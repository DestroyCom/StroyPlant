# Scoped BLE Discovery + Direct MAC Add — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop continuous BLE discovery except while the user is on "Ajouter un appareil"; move periodic reads of already-claimed devices to an independent timer that connects directly by MAC address; add a way to register a device directly by its MAC address.

**Architecture:** `backend/src/ble/scanner.ts`'s single loop (today mixing new-device discovery and known-device polling) is split into two independent modules: `discoverySession.ts` (session-scoped, on/off via tRPC, mirrors the existing `liveSession/manager.ts` pattern) and `namedDevicePoller.ts` (always-on timer, mirrors `health/scheduler.ts`'s pattern). `scanner.ts` is deleted once both replacements are wired in.

**Tech Stack:** Fastify + Prisma/SQLite + tRPC (backend), Vite + React 19 + TanStack Router/Query (frontend), pnpm workspace.

## Global Constraints

- `pnpm` exclusively, never `npm`/`yarn`.
- TypeScript everywhere, no JS.
- No test framework in this repo — verification is manual (throwaway `tsx` scripts, dev-server + curl), matching every prior batch. Reserve Playwright browser automation for genuine visual/rendering checks only (it's token-expensive) — prefer curl/tRPC calls or code reading for everything else.
- No `Co-Authored-By` line in any commit.
- All UI copy is in French.
- Never silently swallow a BLE/sync error (project spec section 7.1) — `persistSyncFailure` calls stay additive to existing `log(...)` calls, never a replacement.
- **Naming deviation from the approved design spec, deliberate**: the spec (`docs/superpowers/specs/2026-07-30-scoped-ble-discovery-design.md`) names the new procedures `devices.startDiscovery`/`stopDiscovery`/`discoveryStatus`. This plan instead gives them their own `discoverySession` router (`discoverySession.status`/`start`/`stop`), mirroring the already-established `liveSession` router's exact shape (own manager module + own thin router file) rather than growing `devices.ts` further — the same architectural pattern this codebase already uses for an equivalent "one global BLE session at a time, on/off via tRPC" feature. Behavior is identical to what the spec describes; only the router name/file location differs.

---

## Task 1: `discoverySession` manager module

**Files:**
- Create: `backend/src/ble/discoverySession.ts`

**Interfaces:**
- Consumes: `DeviceProvider.scan()` (existing, unchanged), `ConnectionQueue` (unused by this module — discovery doesn't need GATT serialization, only `provider.scan()`), `prisma`, `getMqttState`/`publishDiscovery` (existing, from `mqtt/manager.js`/`mqtt/publisher.js`).
- Produces: `startDiscoverySession(provider: DeviceProvider, maxDurationMs?: number): void`, `stopDiscoverySession(): void`, `getActiveDiscoverySession(): { startedAt: string } | null` — all imported directly by Task 2's router (no callback injection from `index.ts`, unlike the old `scanner.ts`/`index.ts` split).

- [ ] **Step 1: Write the module**

Create `backend/src/ble/discoverySession.ts`:

```ts
import { GATT_133_BACKOFF_MS } from './parrot/retry.js';
import { prisma } from '../db/client.js';
import { log } from '../logger.js';
import { getMqttState } from '../mqtt/manager.js';
import { publishDiscovery } from '../mqtt/publisher.js';
import type { DeviceProvider, DiscoveredDevice } from '../providers/types.js';

// Bounds how long a discovery session can run — same idea and constant as
// liveSession/manager.ts's LIVE_SESSION_MAX_DURATION_MS: a closed tab or a crashed frontend must
// not leave continuous BLE scanning running forever (docs/superpowers/specs/
// 2026-07-30-scoped-ble-discovery-design.md).
export const DISCOVERY_SESSION_MAX_DURATION_MS = 5 * 60_000;

const SCAN_RESTART_BASE_DELAY_MS = 5_000;
const SCAN_RESTART_MAX_DELAY_MS = 60_000;
const SCAN_HEALTHY_UPTIME_MS = 60_000;

interface ActiveSession {
  controller: AbortController;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// Module-level singleton, same pattern as liveSession/manager.ts and mqtt/manager.ts — exactly one
// discovery session globally at a time.
let activeSession: ActiveSession | null = null;

export function getActiveDiscoverySession(): { startedAt: string } | null {
  if (!activeSession) return null;
  return { startedAt: new Date(activeSession.startedAt).toISOString() };
}

// Upsert-any-recognized-device behavior is unchanged from the old scanner.ts: named or not, any
// Parrot Pot/Xiaomi seen gets a Device row. Only WHEN this runs changes (session-scoped, not
// forever from boot).
async function onDeviceSeen(device: DiscoveredDevice): Promise<void> {
  const previous = await prisma.device.findUnique({ where: { id: device.id } });
  const upserted = await prisma.device.upsert({
    where: { id: device.id },
    create: { id: device.id, kind: device.kind, name: device.name, lastSeenAt: new Date() },
    update: { name: device.name, lastSeenAt: new Date() },
  });

  // Real BLE providers never populate `device.name` (only devices.rename claims a device) — this
  // only fires for the mock provider's pre-named devices, so their MQTT discovery still gets
  // published once without waiting on a rename that will never happen in that case.
  const mqttState = getMqttState();
  if (mqttState && upserted.name != null && previous?.name == null) {
    publishDiscovery(mqttState.client, upserted, mqttState);
  }
}

// maxDurationMs defaults to the real 5min cutoff — overridable so a verification script can
// exercise the auto-cutoff path without actually waiting 5 minutes (see Task 1 Step 2).
export function startDiscoverySession(provider: DeviceProvider, maxDurationMs = DISCOVERY_SESSION_MAX_DURATION_MS): void {
  if (activeSession) {
    throw new Error('Une session de découverte est déjà active');
  }

  const controller = new AbortController();

  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, maxDurationMs);

  activeSession = { controller, startedAt: Date.now(), timeoutHandle };

  void runResilientScan(provider, controller.signal);
}

export function stopDiscoverySession(): void {
  if (!activeSession) return;
  clearTimeout(activeSession.timeoutHandle);
  activeSession.controller.abort();
  activeSession = null;
}

// Same resilience pattern the old scanner.ts's runScanLoop had (2026-07-29 production incident:
// a single transient provider.scan() error must never kill discovery silently) — capped
// exponential backoff, reset once a run has stayed up long enough to be considered healthy.
// Bounded by the session's own signal, so this loop naturally stops at the session's cutoff.
async function runResilientScan(provider: DeviceProvider, signal: AbortSignal): Promise<void> {
  let delayMs = SCAN_RESTART_BASE_DELAY_MS;
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      await provider.scan((device) => {
        void onDeviceSeen(device).catch((error) => {
          log({
            direction: 'INFO',
            label: 'onDeviceSeen failed',
            deviceId: device.id,
            result: 'ERROR',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      }, signal);
      if (signal.aborted) return;
      throw new Error('provider.scan() returned without the abort signal firing');
    } catch (error) {
      if (signal.aborted) return;
      log({
        direction: 'SCAN',
        label: `Discovery session scan stopped on error — restarting in ${delayMs}ms`,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    delayMs =
      Date.now() - startedAt >= SCAN_HEALTHY_UPTIME_MS ? SCAN_RESTART_BASE_DELAY_MS : Math.min(delayMs * 2, SCAN_RESTART_MAX_DELAY_MS);
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, GATT_133_BACKOFF_MS * 4)));
  }
}
```

Note: the last line caps the actual sleep at `GATT_133_BACKOFF_MS * 4` (2000ms) instead of the full
computed `delayMs` — a discovery session is short-lived (5min max) and interactive (the user is
watching the "Ajouter un appareil" page), so a fast retry matters more here than in the old
forever-running scanner; this deliberately doesn't wait a full 60s backoff during a session the
user is actively staring at.

- [ ] **Step 2: Verify with a throwaway script**

Create `backend/scratch-verify-discovery.ts`:

```ts
import assert from 'node:assert';
import { getActiveDiscoverySession, startDiscoverySession, stopDiscoverySession } from './src/ble/discoverySession.js';
import { createDeviceProvider } from './src/providers/factory.js';

process.env.BLE_PROVIDER = 'mock';
const provider = createDeviceProvider();

assert.strictEqual(getActiveDiscoverySession(), null, 'no session should be active initially');

startDiscoverySession(provider, 500); // short maxDuration for this test
assert(getActiveDiscoverySession() !== null, 'session should be active after start');

assert.throws(() => startDiscoverySession(provider), /déjà active/, 'starting a 2nd session must throw');

await new Promise((resolve) => setTimeout(resolve, 200));
stopDiscoverySession();
assert.strictEqual(getActiveDiscoverySession(), null, 'session should be gone after explicit stop');

// Auto-cutoff path: start again with the same short maxDuration, don't stop it manually.
startDiscoverySession(provider, 500);
await new Promise((resolve) => setTimeout(resolve, 700));
assert.strictEqual(getActiveDiscoverySession(), null, 'session should have auto-cutoff by itself');

console.log('PASS');
process.exit(0);
```

Run:

```bash
cd backend && pnpm exec tsx scratch-verify-discovery.ts && rm scratch-verify-discovery.ts
```

Expected: `PASS`, then the script is deleted.

- [ ] **Step 3: Commit**

```bash
git add backend/src/ble/discoverySession.ts
git commit -m "Add discoverySession manager (session-scoped BLE discovery, mirrors liveSession)"
```

---

## Task 2: `discoverySession` tRPC router

**Files:**
- Create: `backend/src/api/trpc/routers/discoverySession.ts`
- Modify: `backend/src/api/trpc/router.ts`

**Interfaces:**
- Consumes: `startDiscoverySession`/`stopDiscoverySession`/`getActiveDiscoverySession` (Task 1).
- Produces: `appRouter.discoverySession.status/start/stop`, used by Task 3's frontend.

- [ ] **Step 1: Write the router**

Create `backend/src/api/trpc/routers/discoverySession.ts`:

```ts
import { TRPCError } from '@trpc/server';
import { getActiveDiscoverySession, startDiscoverySession, stopDiscoverySession } from '../../../ble/discoverySession.js';
import { protectedProcedure, router } from '../trpc.js';

export const discoverySessionRouter = router({
  // Backs the "Ajouter un appareil" page's own start/stop lifecycle — whether a discovery
  // session is currently running (there's only ever one, globally).
  status: protectedProcedure.query(() => getActiveDiscoverySession()),

  start: protectedProcedure.mutation(({ ctx }) => {
    try {
      startDiscoverySession(ctx.provider);
    } catch (error) {
      // Expected, not a bug: a session is already active (e.g. two browser tabs both on
      // "Ajouter un appareil").
      throw new TRPCError({ code: 'CONFLICT', message: error instanceof Error ? error.message : String(error) });
    }
    return { ok: true as const };
  }),

  stop: protectedProcedure.mutation(() => {
    stopDiscoverySession();
    return { ok: true as const };
  }),
});
```

- [ ] **Step 2: Mount the router**

Open `backend/src/api/trpc/router.ts`. Add the import and the router entry:

```ts
import { devicesRouter } from './routers/devices.js';
import { discoverySessionRouter } from './routers/discoverySession.js';
import { healthRouter } from './routers/health.js';
import { historyRouter } from './routers/history.js';
import { liveSessionRouter } from './routers/liveSession.js';
import { mqttRouter } from './routers/mqtt.js';
import { plantDrRouter } from './routers/plantDr.js';
import { readingsRouter } from './routers/readings.js';
import { scheduleRouter } from './routers/schedule.js';
import { router } from './trpc.js';

export const appRouter = router({
  devices: devicesRouter,
  discoverySession: discoverySessionRouter,
  health: healthRouter,
  history: historyRouter,
  liveSession: liveSessionRouter,
  mqtt: mqttRouter,
  plantDr: plantDrRouter,
  readings: readingsRouter,
  schedule: scheduleRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 3: Verify end-to-end via curl**

With the dev server running (`cd backend && pnpm dev`, `BLE_PROVIDER=mock` in `.env` or as an env
override) and a session cookie (sign in via `curl -c /tmp/sp-cookies.txt -s -X POST
http://localhost:3000/api/auth/sign-in/email -H 'Content-Type: application/json' -d
"{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}"` — use an existing dev admin or a
temporary one via `pnpm seed:admin`, cleaned up after):

```bash
curl -b /tmp/sp-cookies.txt -s "http://localhost:3000/api/trpc/discoverySession.status"
# expect: {"result":{"data":null}}

curl -b /tmp/sp-cookies.txt -s -X POST "http://localhost:3000/api/trpc/discoverySession.start" -H 'Content-Type: application/json' -d '{}'
# expect: {"result":{"data":{"ok":true}}}

curl -b /tmp/sp-cookies.txt -s "http://localhost:3000/api/trpc/discoverySession.status"
# expect: {"result":{"data":{"startedAt":"<ISO timestamp>"}}}

curl -b /tmp/sp-cookies.txt -s -X POST "http://localhost:3000/api/trpc/discoverySession.start" -H 'Content-Type: application/json' -d '{}'
# expect: a tRPC error response, CONFLICT

curl -b /tmp/sp-cookies.txt -s -X POST "http://localhost:3000/api/trpc/discoverySession.stop" -H 'Content-Type: application/json' -d '{}'
# expect: {"result":{"data":{"ok":true}}}

curl -b /tmp/sp-cookies.txt -s "http://localhost:3000/api/trpc/discoverySession.status"
# expect: {"result":{"data":null}}
```

Remove `/tmp/sp-cookies.txt` afterward.

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/trpc/routers/discoverySession.ts backend/src/api/trpc/router.ts
git commit -m "Add discoverySession tRPC router"
```

---

## Task 3: Frontend discovery-session lifecycle on `/devices/add`

**Files:**
- Modify: `frontend/src/routes/_authenticated/devices.add.tsx`

**Interfaces:**
- Consumes: `trpc.discoverySession.status/start/stop` (Task 2), existing `trpc.devices.listUnnamed`.

- [ ] **Step 1: Add the discovery-session lifecycle to the page**

Open `frontend/src/routes/_authenticated/devices.add.tsx`. Add the imports (alongside the existing
ones):

```tsx
import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { RadioTower } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { DeviceKindIcon } from '@/components/device-kind-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDeviceKind, formatRelativeTime } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import type { Device } from '@/lib/types';
```

(This replaces the existing import block — `useMutation` and `RadioTower` are the only new
additions; everything else was already imported.)

Find the `AddDevicePage` component (currently the last function in the file):

```tsx
function AddDevicePage() {
  const { data: devices } = useSuspenseQuery(trpc.devices.listUnnamed.queryOptions());

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-[30px] leading-tight font-black tracking-tight text-foreground">Ajouter un appareil</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Les appareils détectés par le scanner BLE apparaissent ici avant d'être ajoutés au tableau de bord. Donne un nom à celui que tu
          veux suivre.
        </p>
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun nouvel appareil en attente. Ils apparaîtront ici dès que le scanner BLE en détecte un à proximité.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {devices.map((device) => (
            <UnnamedDeviceRow key={device.id} device={device} />
          ))}
        </div>
      )}
    </div>
  );
}
```

Replace it with:

```tsx
function AddDevicePage() {
  const queryClient = useQueryClient();
  const [discoveryActive, setDiscoveryActive] = useState(false);

  const startMutation = useMutation(
    trpc.discoverySession.start.mutationOptions({
      onSuccess: () => setDiscoveryActive(true),
      onError: (error) => {
        // CONFLICT (another session already active, e.g. a second browser tab) — not fatal,
        // the page still works for naming already-discovered devices.
        toast.error('Recherche déjà en cours ailleurs', { description: error.message });
      },
    }),
  );
  const stopMutation = useMutation(trpc.discoverySession.stop.mutationOptions());

  // Start a discovery session when this page mounts, stop it when leaving — same lifecycle
  // pattern live-mode-section.tsx already uses for live sessions. Runs once per mount, not
  // per-render (empty dependency array is deliberate: startMutation/stopMutation are stable
  // across renders, and this must fire exactly once on mount/unmount).
  useEffect(() => {
    startMutation.mutate();
    return () => {
      stopMutation.mutate();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refetch on a short interval only while a session is actually active — a discovery session
  // finding a device is the only thing that can change this list, and a plain interval is enough
  // for a screen the user is actively watching (no need for a push subscription). Passed directly
  // into the same suspense query rather than a second observer on the same key, so there's only
  // ever one source of truth for this list's refetch behavior.
  const { data: devices } = useSuspenseQuery({
    ...trpc.devices.listUnnamed.queryOptions(),
    refetchInterval: discoveryActive ? 3000 : false,
  });

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[30px] leading-tight font-black tracking-tight text-foreground">Ajouter un appareil</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Les appareils détectés apparaissent ici pendant que cette page est ouverte. Donne un nom à celui que tu veux suivre, ou
            ajoute-le directement par son adresse si tu la connais déjà.
          </p>
        </div>
        {discoveryActive && (
          <div className="mt-1 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <RadioTower size={14} className="animate-pulse text-teal-500" />
            Recherche en cours…
          </div>
        )}
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun nouvel appareil en attente. Ils apparaîtront ici dès que la recherche en détecte un à proximité.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {devices.map((device) => (
            <UnnamedDeviceRow key={device.id} device={device} />
          ))}
        </div>
      )}

      <AddByAddressForm queryClient={queryClient} />
    </div>
  );
}
```

Note: `AddByAddressForm` is a forward reference to Task 6's component — it does not exist yet at
the end of this task. **Do not add the `<AddByAddressForm queryClient={queryClient} />` line or
the `queryClient` variable yet** — Task 6 adds both together. For this task, end the returned JSX
right after the closing `)}` of the `devices.length === 0 ? ... : ...` block (i.e. omit the
`<AddByAddressForm .../>` line and the now-unused `queryClient`/`useQueryClient` import for now).

- [ ] **Step 2: Typecheck**

```bash
cd frontend && pnpm typecheck
```

Expected: no errors. (If `queryClient`/`useQueryClient` show as unused because Step 1's note above
was followed, remove that import and the `const queryClient = ...` line until Task 6 needs them.)

- [ ] **Step 3: Manual verification**

Start both dev servers (mock provider). Sign in, open `/devices/add`: confirm the "Recherche en
cours…" indicator appears, and — if the mock provider has any undiscovered devices left in its
simulated set (it may not, since the mock provider's devices are usually already named; this step
mainly confirms no error is thrown and the indicator/lifecycle works) — navigate away and confirm
(via a `discoverySession.status` curl check, or backend logs) that the session stops. Do this
check via curl/backend logs rather than Playwright, per this project's preference to save
Playwright for genuine visual checks only.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/routes/_authenticated/devices.add.tsx
git commit -m "Start/stop a discovery session while the Add Device page is open"
```

---

## Task 4: `namedDevicePoller` module + retire `scanner.ts`

**Files:**
- Create: `backend/src/ble/namedDevicePoller.ts`
- Modify: `backend/src/index.ts`
- Delete: `backend/src/ble/scanner.ts`

**Interfaces:**
- Consumes: `persistReading`/`persistSyncFailure` (existing, from `readings.js`), `ConnectionQueue`, `DeviceProvider`.
- Produces: `startNamedDevicePoller(provider: DeviceProvider, connectionQueue: ConnectionQueue, pollIntervalMs?: number): void`.

- [ ] **Step 1: Write the module**

Create `backend/src/ble/namedDevicePoller.ts`:

```ts
import type { DeviceKind } from '@prisma/client';
import { prisma } from '../db/client.js';
import { log } from '../logger.js';
import { persistReading, persistSyncFailure } from '../readings.js';
import type { ConnectionQueue } from './connectionQueue.js';
import type { DeviceProvider } from '../providers/types.js';

// How often each named device gets read — same default and env override
// (PARROT_POLL_INTERVAL_MS) the old scanner.ts used, just moved here since this module is now the
// only thing that polls known devices (docs/superpowers/specs/2026-07-30-scoped-ble-discovery-design.md).
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

// How often the poller wakes up to check which devices are due — separate from the per-device
// poll interval itself, so a 5min-per-device cadence doesn't require a 5min-granularity tick.
const TICK_INTERVAL_MS = 15_000;

const lastPolled = new Map<string, number>();

async function pollDevice(deviceId: string, kind: DeviceKind, provider: DeviceProvider, connectionQueue: ConnectionQueue) {
  lastPolled.set(deviceId, Date.now());
  await connectionQueue.run(async () => {
    try {
      const reading = await provider.readSensors(deviceId, kind);
      await persistReading(deviceId, kind, reading, 'POLL');
      // A successful read is at least as strong evidence the device is online as merely
      // overhearing its advertisement — now that discovery no longer runs continuously, this is
      // the only remaining thing keeping lastSeenAt fresh for a named device (see the design
      // spec's "lastSeenAt fix" section).
      await prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Never swallow an error silently (docs/STROYPLANT_SPEC.md section 7.1).
      log({ direction: 'READ', label: 'Poll readSensors failed', deviceId, result: 'ERROR', detail });
      await persistSyncFailure(deviceId, 'POLL', detail).catch((persistError) => {
        log({
          direction: 'INFO',
          label: 'persistSyncFailure failed',
          deviceId,
          result: 'ERROR',
          detail: persistError instanceof Error ? persistError.message : String(persistError),
        });
      });
    }
  });
}

export function startNamedDevicePoller(provider: DeviceProvider, connectionQueue: ConnectionQueue, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS): void {
  setInterval(async () => {
    const devices = await prisma.device.findMany({ where: { name: { not: null } } });
    for (const device of devices) {
      const last = lastPolled.get(device.id) ?? 0;
      if (Date.now() - last < pollIntervalMs) continue;
      void pollDevice(device.id, device.kind, provider, connectionQueue);
    }
  }, TICK_INTERVAL_MS);
}
```

Note: `pollDevice` calls are individually `void`-fired (not awaited) inside the tick's `for` loop,
matching how `devices.forceSyncAll` already handles multiple devices — each one goes through
`connectionQueue.run(...)` internally, which is what actually serializes them onto the single GATT
connection; the tick loop itself doesn't need to wait for one device's poll before moving to the
next, since `connectionQueue` already guarantees they run one at a time regardless of firing order.

- [ ] **Step 2: Verify with a throwaway script**

Create `backend/scratch-verify-poller.ts`:

```ts
import assert from 'node:assert';
import { ConnectionQueue } from './src/ble/connectionQueue.js';
import { startNamedDevicePoller } from './src/ble/namedDevicePoller.js';
import { prisma } from './src/db/client.js';
import { createDeviceProvider } from './src/providers/factory.js';

process.env.BLE_PROVIDER = 'mock';
const provider = createDeviceProvider();
const connectionQueue = new ConnectionQueue();

const deviceId = 'MOCK-POT-NORMAL'; // already named in the mock provider's fixed device set
const before = await prisma.device.findUnique({ where: { id: deviceId } });

// Tick interval is 15s and hardcoded — use a 0ms pollIntervalMs so the very first tick (which
// this test waits for) is already "due" for this device.
startNamedDevicePoller(provider, connectionQueue, 0);

await new Promise((resolve) => setTimeout(resolve, 16_000)); // > TICK_INTERVAL_MS

const after = await prisma.device.findUnique({ where: { id: deviceId } });
assert(after?.lastSeenAt, 'lastSeenAt should be set after a successful poll');
assert(
  !before?.lastSeenAt || after.lastSeenAt.getTime() > before.lastSeenAt.getTime(),
  'lastSeenAt should have advanced from the poll, not just from a stale prior value',
);

const reading = await prisma.reading.findFirst({ where: { deviceId, source: 'POLL' }, orderBy: { timestamp: 'desc' } });
assert(reading, 'a POLL reading should have been persisted');

console.log('PASS');
await prisma.$disconnect();
process.exit(0);
```

Run:

```bash
cd backend && pnpm exec tsx scratch-verify-poller.ts && rm scratch-verify-poller.ts
```

Expected: `PASS` after ~16s, then the script is deleted. (This intentionally does NOT start a
discovery session at all — proving the poller works with zero discovery running, the core claim
of this whole plan.)

- [ ] **Step 3: Wire into `index.ts`, remove `startScanner`**

Open `backend/src/index.ts`. Replace the entire file with:

```ts
import { buildServer } from './api/server.js';
import { ConnectionQueue } from './ble/connectionQueue.js';
import { startNamedDevicePoller } from './ble/namedDevicePoller.js';
import { env } from './env.js';
import { startScheduler } from './health/scheduler.js';
import { log } from './logger.js';
import { initMqttManager } from './mqtt/manager.js';
import { createDeviceProvider } from './providers/factory.js';

async function main() {
  const provider = createDeviceProvider();
  const connectionQueue = new ConnectionQueue();

  log({ direction: 'INFO', label: `Starting StroyPlant backend — provider=${provider.name}`, result: 'OK' });

  // Connects (or logs "disabled" if no broker is configured in Settings) and publishes discovery
  // for every already-named device — subscribing to watering commands and republishing discovery
  // happen again automatically on every `reloadMqttClient()` call too (mqttSettings.upsert, tRPC).
  await initMqttManager(provider, connectionQueue);

  // Polls every already-named device on its own timer, independent of BLE discovery — see
  // docs/superpowers/specs/2026-07-30-scoped-ble-discovery-design.md. Discovery of NEW devices
  // only happens during an explicit discoverySession (started/stopped via tRPC from the
  // "Ajouter un appareil" page), never unconditionally at startup.
  startNamedDevicePoller(provider, connectionQueue, env.parrotPollIntervalMs);

  startScheduler(provider, connectionQueue);

  const app = await buildServer(provider, connectionQueue);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  log({ direction: 'INFO', label: `API listening on port ${env.port}`, result: 'OK' });
}

main().catch((error) => {
  log({ direction: 'INFO', label: 'Fatal startup error', result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
```

- [ ] **Step 4: Delete `scanner.ts`**

```bash
git rm backend/src/ble/scanner.ts
```

- [ ] **Step 5: Search for any remaining references**

```bash
grep -rn "ble/scanner\|startScanner" backend/src
```

Expected: no matches. If any turn up (e.g. an import this plan's author missed), resolve them
before proceeding — do not leave a dangling import to a deleted file.

- [ ] **Step 6: Typecheck and build**

```bash
cd backend && pnpm build
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Replace scanner.ts with namedDevicePoller (discovery moves to discoverySession)"
```

---

## Task 5: Verify `lastSeenAt` freshness end-to-end, no discovery running

**Files:** none new — this task is a dedicated verification pass for the design's central claim,
since Task 4's own script already covers the mechanism in isolation but not the full "app running
normally, zero discovery sessions, for a duration exceeding the old offline threshold" scenario.

- [ ] **Step 1: Manual end-to-end check**

Start the backend (`cd backend && pnpm dev`, mock provider). Do **not** start any discovery
session (don't open `/devices/add`). Wait at least 11 minutes (exceeds
`frontend/src/lib/format.ts`'s `OFFLINE_THRESHOLD_MS`, 10 minutes) — or temporarily lower
`OFFLINE_THRESHOLD_MS` in a scratch copy of that check for a faster local test, reverting before
committing anything.

Query a named device's `lastSeenAt` periodically via curl:

```bash
curl -b /tmp/sp-cookies.txt -s "http://localhost:3000/api/trpc/devices.list" | python3 -m json.tool | grep -A2 lastSeenAt
```

Expected: `lastSeenAt` keeps advancing every ~poll interval, purely from `namedDevicePoller`
activity, with zero discovery sessions run — confirming the dashboard would never incorrectly show
these devices as "hors ligne" under the new architecture.

- [ ] **Step 2: No commit for this task** (verification-only, no code changes). If this check
  fails, treat it as a regression against Task 4 and fix there before proceeding — do not silently
  continue to Task 6 with a known-broken `lastSeenAt`.

---

## Task 6: `devices.addByAddress` + frontend form

**Files:**
- Modify: `backend/src/api/trpc/routers/devices.ts`
- Modify: `frontend/src/routes/_authenticated/devices.add.tsx`

**Interfaces:**
- Produces: `trpc.devices.addByAddress.mutate({ macAddress, kind, name })`.

- [ ] **Step 1: Add the backend mutation**

Open `backend/src/api/trpc/routers/devices.ts`. Add this procedure to `devicesRouter` (e.g. right
after `rename`):

```ts
  // Registers a device directly by its known BLE address, without waiting for a discovery
  // session to find it — for a device that's temporarily out of range, or when the user already
  // knows the address (docs/superpowers/specs/2026-07-30-scoped-ble-discovery-design.md).
  addByAddress: protectedProcedure
    .input(
      z.object({
        macAddress: z
          .string()
          .trim()
          .regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/, 'Adresse invalide (format attendu : AA:BB:CC:DD:EE:FF)')
          .transform((value) => value.toUpperCase()),
        kind: z.enum(['PARROT_POT', 'XIAOMI_LYWSD03MMC']),
        name: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await prisma.device.findUnique({ where: { id: input.macAddress } });
      if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'Un appareil avec cette adresse existe déjà' });

      const created = await prisma.device.create({
        data: { id: input.macAddress, kind: input.kind, name: input.name, lastSeenAt: new Date() },
        include: { plantProfile: true },
      });

      const mqttState = getMqttState();
      if (mqttState) publishDiscovery(mqttState.client, created, mqttState);

      return withLastReading(created);
    }),
```

This sits alongside the existing `rename`/`updateDetails`/etc procedures in the same file — no new
imports needed (`z`, `TRPCError`, `prisma`, `getMqttState`, `publishDiscovery`, `withLastReading`
are all already imported/defined in this file).

- [ ] **Step 2: Verify with curl**

With the dev server running:

```bash
curl -b /tmp/sp-cookies.txt -s -X POST "http://localhost:3000/api/trpc/devices.addByAddress" \
  -H 'Content-Type: application/json' \
  -d '{"macAddress":"AA:BB:CC:DD:EE:FF","kind":"XIAOMI_LYWSD03MMC","name":"Test capteur"}'
```

Expected: a successful response with the created device. Then confirm the format check and
duplicate check both work:

```bash
curl -b /tmp/sp-cookies.txt -s -X POST "http://localhost:3000/api/trpc/devices.addByAddress" \
  -H 'Content-Type: application/json' \
  -d '{"macAddress":"not-a-mac","kind":"XIAOMI_LYWSD03MMC","name":"Test"}'
# expect: a zod validation error mentioning the expected format

curl -b /tmp/sp-cookies.txt -s -X POST "http://localhost:3000/api/trpc/devices.addByAddress" \
  -H 'Content-Type: application/json' \
  -d '{"macAddress":"AA:BB:CC:DD:EE:FF","kind":"XIAOMI_LYWSD03MMC","name":"Doublon"}'
# expect: CONFLICT — this address was already added above
```

Clean up the test device afterward:

```bash
cd backend && pnpm exec tsx -e "
import('./src/db/client.js').then(async ({ prisma }) => {
  await prisma.device.delete({ where: { id: 'AA:BB:CC:DD:EE:FF' } });
  await prisma.\$disconnect();
});
"
```

- [ ] **Step 3: Add the frontend form**

Open `frontend/src/routes/_authenticated/devices.add.tsx`. Add this component, after
`UnnamedDeviceRow` and before `AddDevicePage`:

```tsx
function AddByAddressForm({ queryClient }: { queryClient: ReturnType<typeof useQueryClient> }) {
  const [macAddress, setMacAddress] = useState('');
  const [kind, setKind] = useState<'PARROT_POT' | 'XIAOMI_LYWSD03MMC'>('PARROT_POT');
  const [name, setName] = useState('');

  const addMutation = useMutation(
    trpc.devices.addByAddress.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        toast.success('Appareil ajouté');
        setMacAddress('');
        setName('');
      },
      onError: (error) => {
        toast.error("Échec de l'ajout", { description: error.message });
      },
    }),
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!macAddress.trim() || !name.trim()) return;
    addMutation.mutate({ macAddress: macAddress.trim(), kind, name: name.trim() });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3 rounded-lg border border-border-subtle p-4 sm:flex-row sm:items-end">
      <div className="flex flex-col gap-2">
        <Label htmlFor="mac-address">Adresse BLE</Label>
        <Input
          id="mac-address"
          value={macAddress}
          onChange={(event) => setMacAddress(event.target.value)}
          placeholder="AA:BB:CC:DD:EE:FF"
          className="sm:w-48"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="device-kind">Type</Label>
        <select
          id="device-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as 'PARROT_POT' | 'XIAOMI_LYWSD03MMC')}
          className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="PARROT_POT">Parrot Pot</option>
          <option value="XIAOMI_LYWSD03MMC">Capteur Xiaomi</option>
        </select>
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="device-name">Nom</Label>
        <Input id="device-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Nom de la plante" />
      </div>
      <Button type="submit" disabled={!macAddress.trim() || !name.trim() || addMutation.isPending}>
        Ajouter par adresse
      </Button>
    </form>
  );
}
```

This needs the `Label` import added: `import { Label } from '@/components/ui/label';`.

- [ ] **Step 4: Wire it into `AddDevicePage`**

In `AddDevicePage` (edited in Task 3), restore the `queryClient`/`useQueryClient` usage that Task
3 deliberately omitted, and add the form to the JSX. The component should now read:

```tsx
function AddDevicePage() {
  const queryClient = useQueryClient();
  const [discoveryActive, setDiscoveryActive] = useState(false);

  // ... (unchanged: startMutation, stopMutation, the useEffect, devices query — from Task 3)

  return (
    <div>
      {/* ... unchanged header/indicator/device-list JSX from Task 3 ... */}

      <AddByAddressForm queryClient={queryClient} />
    </div>
  );
}
```

(The `queryClient` variable already exists from Task 3's `useState`/`useEffect` setup — Task 3's
instructions said to omit only the `<AddByAddressForm />` JSX line and the then-unused
`useQueryClient` import; this step adds both back.)

- [ ] **Step 5: Typecheck**

```bash
cd frontend && pnpm typecheck
```

Expected: no errors.

- [ ] **Step 6: Manual verification**

With both dev servers running (mock provider), open `/devices/add`, fill in the address form with
a fake but validly-formatted address (e.g. `AA:BB:CC:DD:EE:01`), submit, confirm a success toast
and that the device now appears (it won't have a `Reading` yet — the mock provider doesn't know
this address — but it should appear in the dashboard/device list). Then check the `/history` page
after waiting one poll tick — a `SyncEvent` should appear for this device (mock provider will fail
to read an unknown address), confirming the failure path surfaces correctly rather than silently.
Clean up the test device via the same `tsx -e` snippet as Step 2 afterward.

- [ ] **Step 7: Commit**

```bash
git add backend/src/api/trpc/routers/devices.ts frontend/src/routes/_authenticated/devices.add.tsx
git commit -m "Add devices.addByAddress mutation and its form on the Add Device page"
```

---

## Task 7: Final verification pass + lint

**Files:** none new — verification-only task.

- [ ] **Step 1: Full lint pass**

```bash
pnpm lint:fix
```

Expected: no errors; review any diff before committing (should be whitespace/import-order only).

- [ ] **Step 2: Full typecheck/build, both packages**

```bash
cd backend && pnpm build
cd frontend && pnpm typecheck
```

Expected: both succeed with no errors.

- [ ] **Step 3: Full manual pass against the mock provider**

With both dev servers running:
- Confirm the dashboard (`/`) and device detail pages still show correct online/offline status
  and readings, purely from `namedDevicePoller` activity, with no discovery session ever started
  during this check.
- Open `/devices/add`, confirm discovery starts (indicator visible), close it, confirm (via
  `discoverySession.status` curl or backend logs) it stops.
- Confirm `devices.addByAddress` still works (quick repeat of Task 6 Step 6, or skip if already
  fresh from that task).
- Confirm watering/sync/species-assignment (existing features, unrelated to this plan) still work
  end-to-end — this plan touched `index.ts`'s startup wiring and deleted `scanner.ts`, both
  relevant to whether the rest of the app still boots and functions correctly.

- [ ] **Step 4: Commit (only if Step 1 produced formatting changes)**

```bash
git add -A
git commit -m "Lint fixes after scoped BLE discovery pass"
```

If `pnpm lint:fix` made no changes, skip this commit entirely.
