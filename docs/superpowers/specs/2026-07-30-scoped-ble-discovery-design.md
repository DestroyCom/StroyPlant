# Scoped BLE discovery + direct MAC add — design spec

Date: 2026-07-30
Status: approved by DestCom, ready for implementation planning

## Purpose

Today, `backend/src/ble/scanner.ts`'s `startScanner()` runs one continuous loop, forever, from
backend startup: it both (a) discovers and auto-registers any recognized BLE device in range
(named or not — including neighbours' Xiaomi sensors, per `CLAUDE.md`'s documented production
observation), and (b) drives the periodic ~5min poll of every device it sees, via the same
`onDiscovered` callback.

DestCom asked to narrow this: only actively scan for **new** devices while the user is on the
"Ajouter un appareil" screen; the rest of the time, the backend should only ever target the BLE
addresses of devices already claimed (named) by the user. This reduces continuous BLE exposure to
devices the user never asked to track, and is also the direct root cause of a risk flagged in the
2026-07-30 responsive/history branch's final review (unclaimed devices' sync failures could flood
the history feed — patched there at the query level, but the underlying cause, that unclaimed
devices get polled via GATT at all, was left in place until now).

## Evidence this is feasible (not assumed)

- **`connectDevice()` (`backend/src/providers/node-ble/index.ts`) already self-manages its own
  discovery-if-needed step**: `if (!(await adapter.isDiscovering())) await adapter.startDiscovery()`
  before `adapter.waitDevice(macAddress, ...)`. It does not depend on `scanner.ts`'s separate
  continuous loop to have already found the device.
- **`noble-bridge` has the equivalent primitive**: `scanForDevice(logicalId, timeoutMs)`
  (`noble-bridge/src/ble-client.ts`), a short, self-contained scan-for-one-device function, already
  separate from `scanContinuous` (the general new-device discovery loop).
- **Empirically confirmed on the production server** (SSH, disposable Docker containers sharing
  the host's D-Bus socket — no risk to the live `stroyplant` container): `bluetoothctl devices` on
  the host lists all 4 real devices (both Parrot Pots, both Xiaomi sensors) as persistently known
  to BlueZ, independent of any specific app's active scanning. A fresh `node-ble` connection (a
  disposable container) needed a few seconds for its own internal D-Bus object cache to catch up
  with BlueZ's already-known devices (`adapter.devices()` went from 0 → 3 devices over ~3s with no
  discovery started by that process) — a one-time startup propagation delay, not a blocker.
  Attempting an actual `device.connect()` from that same disposable container failed with
  `le-connection-abort-by-local` — but this was radio contention between two independent processes
  (the disposable test container and the live `stroyplant` container) both using the single
  physical adapter at once, which does not apply to the real design (a single process, same
  `connectionQueue` serialization as every other GATT operation today).

## Scope

In scope:
- A new discovery-session lifecycle, active only while `/devices/add` is open.
- Decoupling periodic reads of named devices from discovery entirely (a new, independent poller).
- Preserving `Device.lastSeenAt` accuracy now that discovery no longer runs continuously (see
  "`lastSeenAt` fix" below — an easy-to-miss regression this design must not introduce).
- Direct add-by-MAC-address on the `/devices/add` screen.

Out of scope (explicitly deferred, per DestCom):
- The multi-step onboarding stepper (name/location/indoor-outdoor/species/auto-watering in one
  flow) — a separate, independent frontend feature, its own spec after this one.
- Any change to the actual GATT protocol logic, retry/backoff policy (`ble/parrot/retry.ts`), or
  per-characteristic read/write behavior.

## Part 1 — Discovery session (new)

New module `backend/src/ble/discoverySession.ts`, structurally mirroring the existing
`liveSession/manager.ts` (`startLiveSession`/`stopLiveSession`/`getActiveLiveSession`):

- `startDiscoverySession(provider, deps)`: rejects if a session is already active (same
  one-at-a-time constraint as live sessions — `CONFLICT`, never silently queued). Runs
  `provider.scan(onDiscovered, signal)` (the existing per-provider implementation, completely
  unchanged — `providers/types.ts`'s `DeviceProvider.scan` signature doesn't change) via an
  `AbortController`, with a hard auto-cutoff (`DISCOVERY_SESSION_MAX_DURATION_MS`, 5 minutes,
  matching `LIVE_SESSION_MAX_DURATION_MS`'s existing constant/precedent) in case the frontend
  never calls stop (closed tab, crash).
- `stopDiscoverySession()`: aborts the controller, clears the auto-cutoff timer (same
  `clearTimeout` fix `liveSession` already needed — a stop racing the cutoff must not let the
  timeout still fire afterward).
- `onDeviceSeen` during a session is **unchanged in behavior**: any recognized device (Parrot Pot
  or Xiaomi), named or not, still gets upserted exactly like today — a session is "look for
  anything out there," not "only look for devices I already expect." The difference is purely
  **when** this runs (only during an explicit session), not what it does while running.
- New tRPC procedures: `devices.startDiscovery` (mutation), `devices.stopDiscovery` (mutation),
  `devices.discoveryStatus` (query, `{ active: boolean }`) — same shape as the existing
  `liveSession` router's `start`/`stop`/`status`.

**Backend startup** (`backend/src/index.ts`): `startScanner(...)` is removed from `main()`'s
unconditional startup — no discovery runs until a session is explicitly started.

## Part 2 — Named-device poller (new, decoupled from discovery)

New module `backend/src/ble/namedDevicePoller.ts`: a single `setInterval`-driven loop (matching
`health/scheduler.ts`'s `startScheduler` pattern — same codebase convention for a periodic
backend-lifetime tick), started unconditionally at backend startup (unlike the discovery session).
Each tick:
- Queries every **named** device (`prisma.device.findMany({ where: { name: { not: null } } })` —
  same filter `devices.list` already uses).
- For each device due for a poll (reusing the exact per-device throttle logic currently in
  `scanner.ts`'s `lastPolled` map — moved here unchanged), calls
  `connectionQueue.run(() => provider.readSensors(deviceId, kind))` directly by the device's own id
  (MAC address) — the same call shape `devices.ts`'s `forceSyncAll` already uses, just on an
  automatic timer instead of a button press.
- On success: `persistReading(...)` as today (`source: 'POLL'`).
- On failure: `persistSyncFailure(deviceId, 'POLL', detail)` (already exists, from the previous
  branch) — this poller becomes the new call site for `source: 'POLL'`, replacing
  `scanner.ts`'s `pollDeviceNow`.

**`lastSeenAt` fix (must not regress)**: today, `Device.lastSeenAt` is only ever written by
discovery's `onDeviceSeen` — never by a successful read. Once discovery stops running
continuously, a named device would incorrectly start showing "hors ligne"
(`frontend/src/lib/format.ts`'s `isDeviceOnline`, 10-minute threshold) after 10 minutes even while
the poller keeps successfully reading it. Fix: the poller updates `Device.lastSeenAt = new Date()`
on every successful read (alongside `persistReading`), not just on discovery. This is a strictly
more accurate signal than today's "last seen an advertisement" (a successful sensor read is
stronger evidence the device is online than merely overhearing it), so this is a correctness fix,
not a behavior compromise.

**`devices.sync`/`devices.forceSyncAll`** (existing manual mutations): unchanged in behavior, but
now update `lastSeenAt` too for consistency with the automatic poller (they arguably should have
already — a manual sync succeeding is equally strong evidence of "online").

## Part 3 — Direct add-by-MAC-address

New tRPC mutation `devices.addByAddress`, input `{ macAddress: string, kind: 'PARROT_POT' |
'XIAOMI_LYWSD03MMC', name: string }`:
- Validates `macAddress` matches the standard `AA:BB:CC:DD:EE:FF` shape (zod regex) — a basic
  sanity check, not a guarantee the address is real or reachable.
- Creates the `Device` row directly (`prisma.device.create`), named immediately (unlike the
  scanner's upsert path, which always creates with `name: null` first) — this is a deliberate,
  faster path for a user who already knows their device's address and wants to skip waiting for a
  discovery session to find it.
- No uniqueness surprises beyond the existing `Device.id` primary key constraint (attempting to
  add an address that already exists fails with the same Prisma unique-constraint error every
  other `create` in this codebase already surfaces as a `TRPCError`).
- A wrong/unreachable address surfaces exactly like any other sync failure — the named-device
  poller will fail to connect to it and record a `SyncEvent`, visible on the `/history` page built
  in the previous branch. No special-cased validation beyond the format check.

**Frontend** (`frontend/src/routes/_authenticated/devices.add.tsx`): a small form (MAC address
input + device-kind select + name input) alongside the existing auto-discovered list, calling
`devices.addByAddress`. The page's existing `useSuspenseQuery(trpc.devices.listUnnamed...)` section
also gains the discovery-session start/stop lifecycle from Part 1 (start on mount, stop on
unmount, matching `live-mode-section.tsx`'s existing cleanup pattern) — while a session is active,
`listUnnamed` refetches on a short interval (e.g. `refetchInterval: 3000`, plain TanStack Query
polling) rather than a new push subscription, since a few seconds of latency on a screen the user
is actively watching doesn't warrant a new real-time channel.

## Testing plan

No real BLE hardware needed for the mock-provider verification path; the empirical BlueZ findings
above already cover the production-specific risk this design depends on.
- Mock provider: discovery session start/reject-second-session/auto-cutoff/stop, matching
  `liveSession`'s own already-proven test shape.
- Mock provider: named-device poller ticks on its own without any discovery session active,
  correctly polls only named devices, correctly skips unnamed ones.
- Mock provider: `lastSeenAt` stays fresh purely from poller activity, with zero discovery
  sessions run, over a period exceeding the old 10-minute offline threshold.
- Mock provider: `devices.addByAddress` round-trip (valid format succeeds and becomes pollable,
  invalid format rejected, duplicate address rejected).
- Manual: `/devices/add` page opened/closed a few times, confirming the discovery session
  actually starts/stops (backend logs) and doesn't leak past navigation away from the page.
