# Live sensor mode — design spec

Date: 2026-07-29
Status: approved by DestCom, ready for implementation planning

## Purpose

Add a per-device "live mode" to the device detail page: while active, a graph updates roughly
every second with real-time sensor values, instead of waiting for the scanner's ~5min poll.
Requested by DestCom; confirmed technically supported by the Parrot Pot's official BLE protocol
(see Evidence below). Live samples must also be persisted to the database.

## Evidence this is real (not assumed)

- `docs/PARROT_OFFICIAL_BLE_SPEC.md`: the official Parrot engineering PDF states the app connects
  in 3 cases, one of which is *"The user manually starts a live session"* — a first-party
  confirmation this is an intended, supported mode, not a hack.
- `docs/PARROT_BLE_REVERSE_ENGINEERING.md` (decompiled official Android app, "Certain" confidence):
  `BleTaskHandler.startLive()` writes the sampling period to `39e1fa06`
  (`UUID_LIVE_MEASURE_PERIOD`) then subscribes via `setCharacteristicNotification()` (real BLE
  Notify/CCCD, not polling reads) to `39e1fa09`/`0a`/`0b` (VWC/temperature/light — already
  calibrated float32 LE, no conversion formula needed, same characteristics StroyPlant already
  reads for a normal poll).
- Our code already writes `1` to `39e1fa06` before every normal read (`node-ble/index.ts`,
  `readSensors`) — today only to "wake" the firmware for a single read, never to open continuous
  notify. Live mode is the same activation, held open instead of read-once-and-deactivate.
- Xiaomi LYWSD03MMC: already notify-based in our code (`ebe0ccc1`), but the rate is entirely
  firmware-controlled — there's no equivalent "measure period" characteristic to force it to 1Hz.
  Live mode on Xiaomi is best-effort: the graph updates whenever a notification arrives, which may
  be sparser than 1/s.

## Key constraint: single shared GATT connection

The whole project has exactly one BLE connection at a time (`ConnectionQueue`, single dongle,
shared by every Parrot Pot, every Xiaomi, the scanner's own polling, and the auto-watering
scheduler). A live session holds that connection open for its whole duration. Decisions made with
DestCom to bound the impact:

- **One live session globally at a time.** Starting a second one while another is active is
  **rejected outright** (clear error, not silently queued) — queuing would mean the button appears
  to do nothing for up to 5 minutes.
- **Hard 5-minute auto-cutoff**, even if the user stays on the page — bounds how long every other
  device's polling and the auto-watering scheduler can be starved.
- Ending a session (auto-cutoff, manual stop, or leaving the page) immediately frees the queue for
  everything else.

## Scope for this iteration

- Providers: `mock` (full simulation, used for dev/testing) and `node-ble` (production) implement
  real live sampling. `noble-bridge` throws an explicit "not implemented" error if called — real
  Mac-hardware validation of this feature is deferred, matching how `node-ble` itself was
  originally validated directly on the production server rather than via noble-bridge.
- Device kinds: both Parrot Pot and Xiaomi LYWSD03MMC get a "Mode live" button. Parrot Pot shows 3
  metrics (soil moisture, temperature, luminosity); Xiaomi shows 2 (temperature, humidity) — both
  bundled in a single notification payload already parsed by `parseTempHumidityPayload`.

## Data model

`Reading` gains a `source` column distinguishing how a row was produced:

```prisma
enum ReadingSource {
  POLL // scanner's periodic poll, manual "sync now"/"forcer la synchro", MCP tool reads
  LIVE // live-mode session
}

model Reading {
  // ...existing fields unchanged...
  source ReadingSource @default(POLL)
}
```

`@default(POLL)` means the migration needs no backfill step — SQLite sets every existing row to
`POLL` as part of the `ALTER TABLE ... ADD COLUMN ... DEFAULT 'POLL'`, consistent with how
`Schedule`'s defaults already avoid a backfill elsewhere in this codebase.

**Every reader of `Reading` that computes an average/trend or renders the existing history charts
must filter `source: 'POLL'`**, so a live session (up to 300 rows in 5 minutes, vs. ~1 row/5min
normally) can never skew them:

- `health/scheduler.ts` (`evaluateDevice`'s baseline window query)
- `api/trpc/routers/health.ts` (`deviceHealth`'s baseline window query)
- `api/trpc/routers/devices.ts` (`history` — the 24h/7d/30d chart data)
- `mqtt/publisher.ts` (`publishHealthState`'s baseline window query)

`persistReading()` (`backend/src/readings.ts`) gains a `source: ReadingSource` parameter
(no default — every call site must be explicit about which one it is), passed through to
`prisma.reading.create`. Existing call sites (scanner's `onReading`, `devices.sync`,
`devices.forceSyncAll`) all pass `'POLL'`.

## Backend: provider interface

New method on `DeviceProvider` (`backend/src/providers/types.ts`), same shape/contract as `scan()`:

```typescript
// Streams live sensor samples until `signal` aborts. Resolves cleanly on abort; throws on any
// unrecoverable failure (GATT error, unexpected disconnect) — callers must treat a thrown error
// as the session having ended abnormally, not retry it themselves.
subscribeLive(
  deviceId: string,
  kind: DeviceKind,
  onSample: (reading: SensorReading) => Promise<void>,
  signal: AbortSignal,
): Promise<void>;
```

- **`mock`**: `setInterval`-driven (~1s), synthesizes plausible fluctuating values per existing
  mock device, calls `onSample` and awaits it, stops cleanly on abort.
- **`node-ble`**: connects (via the existing `connectDevice()`/`withGattRetry` machinery already
  used elsewhere), writes `1` to `39e1fa06`, subscribes (`startNotifications()` +
  `'valuechanged'` listener, same pattern already used for the Xiaomi single-read path) to the 3
  Parrot characteristics (or the 1 Xiaomi characteristic), awaits `onSample` for each notification
  (keeps writes ordered, no racing persistence calls). Also listens for the device's own
  `'disconnect'` event (node-ble's `Device` already emits this — see `Device.connect()`'s
  `PropertiesChanged` handler) and treats an unexpected disconnect as a thrown error, so a session
  can't hang forever if the pot drops out of range mid-session. On abort (clean stop or timeout):
  writes `0` to `39e1fa06`, stops notifications, disconnects — same
  `releaseDbusListeners`/timeout-wrapped-disconnect cleanup already established for every other
  GATT path in this file (2026-07-29 incident fixes).
- **`noble-bridge`**: `throw new Error('subscribeLive not implemented on noble-bridge')`.

## Backend: session manager

New `backend/src/liveSession/manager.ts`, singleton module-level state (same pattern as
`mqtt/manager.ts`):

```typescript
let activeSession: { deviceId: string; controller: AbortController } | null = null;
const emitter = new EventEmitter(); // 'sample' and 'ended' events, mirrors readingsEmitter.ts
```

- **`startLiveSession(deviceId, kind, provider, connectionQueue)`**: if `activeSession` is already
  set, throws immediately (checked synchronously, before ever touching `connectionQueue` — a
  second attempt gets an instant, clear rejection, never a silent multi-minute wait). Otherwise:
  sets `activeSession`, starts a 5-minute `setTimeout` that aborts the controller, and fires
  `connectionQueue.run(() => provider.subscribeLive(deviceId, kind, onSample, controller.signal))`
  in the background (not awaited by the caller — same fire-and-forget shape as
  `devices.forceSyncAll`). `onSample` persists via `persistReading(..., 'LIVE')` and emits a
  `'sample'` event. When the background call settles (either way), clears `activeSession`, clears
  the timeout, and emits an `'ended'` event with a reason (`'stopped' | 'timeout' | 'error'`) plus
  the error detail if any — logged via the project's standard `log()`, never silently swallowed.
- **`stopLiveSession(deviceId)`**: no-op if no session is active or it's for a different device;
  otherwise aborts the controller (clean stop path).
- **`getActiveLiveSession()`**: returns `{ deviceId, startedAt } | null` — backs a status
  query so a user opening a different device's page can see *why* the button is disabled.

## Backend: tRPC surface

New `liveSession` router (`api/trpc/routers/liveSession.ts`):

- `start` (mutation, input `{ deviceId }`): resolves the device, validates it exists, calls
  `startLiveSession`; throws `TRPCError({code:'CONFLICT'})` if one is already active elsewhere.
- `stop` (mutation, input `{ deviceId }`): calls `stopLiveSession`, always succeeds (no-op if
  nothing to stop).
- `status` (query): returns `getActiveLiveSession()`'s result, used to disable the button
  elsewhere while a session is active.
- `onSample` (subscription, input `{ deviceId }`): async-generator over the manager's emitter,
  filtered to the requested `deviceId`, yielding a discriminated union:
  `{ type: 'sample'; reading: SerializedReading } | { type: 'ended'; reason: 'stopped' | 'timeout' | 'error'; detail?: string }`.
  Deliberately **not** reusing `readings.onReading`/`readingsEmitter` — that channel feeds the
  `devices.list`/`devices.history` query caches for every connected client (see
  `use-live-readings.ts`), and a live session's ~1Hz stream must never flow into those (the
  `source` filtering above protects the *database* reads, this protects the *live-push* path from
  the same pollution client-side).

## Frontend

New `LiveModeSection` component on the device detail page (`devices.$deviceId.tsx`), device-kind
aware (3 metrics for Parrot Pot, 2 for Xiaomi):

- "Mode live" button — calls `liveSession.start`; disabled with a tooltip
  (`liveSession.status` query) if a session is already active on another device.
- While active: subscribes to `liveSession.onSample({deviceId})`. Maintains a local rolling buffer
  per metric (capped at 300 samples, matching the 5-minute cap) fed directly by the subscription —
  no DB query involved, this is purely a client-side buffer. Renders one `HistoryChart` per metric
  (the same component already used for the 24h/7d/30d history — reused as-is, just fed live data
  instead of a query result), plus a countdown to the 5-minute cutoff.
- "Arrêter" button — calls `liveSession.stop`.
- On unmount (route change): calls `liveSession.stop` in a cleanup effect, so navigating away ends
  the session immediately rather than leaving it running until the 5-minute cap.
- On receiving an `{type:'ended'}` event or the subscription erroring: shows a "Session terminée"
  state (with the reason if it was an error) and resets back to the "Mode live" button.

## Error handling (docs/STROYPLANT_SPEC.md section 7.1 — never silent)

- Every abnormal end (GATT error, unexpected disconnect, `subscribeLive` throwing for any reason)
  is logged via `log()` **and** surfaced to the frontend as an `{type:'ended', reason:'error', detail}`
  event — never just a silently-closed subscription the user has to guess about.
- `startLiveSession` rejecting because another session is active is a normal, expected outcome
  (not a bug) — surfaced as a `TRPCError({code:'CONFLICT'})` with a message naming the other device.

## Testing plan (mock provider — no real BLE hardware in this environment)

- `mock`'s `subscribeLive` produces samples on a timer; verify `liveSession.start` →
  `onSample` subscription receives them, `Reading` rows land with `source: 'LIVE'`, and
  `devices.history`/`health.deviceHealth` exclude them (row counts before/after a simulated
  session, health numbers unchanged).
- Verify the single-session guard: starting a second session while one is active gets an immediate
  `CONFLICT`, not a hang.
- Verify `stop` ends the session promptly and frees the device for a normal poll immediately after.
- Verify the 5-minute auto-cutoff path with a shortened timeout override for the test run.
