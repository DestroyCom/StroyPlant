# Live sensor mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let DestCom start a per-device "live mode" on the device detail page — a graph that
updates roughly every second (real GATT notify on the Parrot Pot, best-effort on the Xiaomi) —
with every live sample also persisted to the database, tagged separately from normal polling.

**Architecture:** A new `DeviceProvider.subscribeLive()` method (mock + node-ble implement it for
real, noble-bridge stubs it) streams samples through the existing single `ConnectionQueue`. A new
`backend/src/liveSession/manager.ts` singleton enforces "one live session at a time" and a 5-minute
hard cutoff, persists each sample via `persistReading(..., 'LIVE')`, and broadcasts it over a new
`liveSession.onSample` tRPC subscription. The frontend's device detail page gets a "Mode live"
section reusing the existing `HistoryChart` component, fed by that subscription instead of a DB
query.

**Tech Stack:** TypeScript, Fastify + tRPC (subscriptions over WS), Prisma/SQLite, node-ble
(BlueZ/D-Bus), React + TanStack Query/Router, recharts (via the existing `HistoryChart` wrapper).

## Global Constraints

- `pnpm` exclusively, never `npm`/`yarn` (see `CLAUDE.md`).
- No automated test framework exists in this repo (`backend/package.json` has no `test` script,
  no vitest/jest anywhere) — every "test" step below is a **manual verification**: boot the
  backend with `BLE_PROVIDER=mock` against a scratch copy of the dev DB and exercise it via
  `curl`/a short `tsx` script, matching how every prior batch in this project was verified (see
  `CLAUDE.md`'s batch history). Do not add a test framework as part of this plan — out of scope,
  not requested.
- Never silently swallow a BLE error (`docs/STROYPLANT_SPEC.md` section 7.1) — every abnormal
  live-session end must be logged via `log()` **and** surfaced to the frontend, never just a
  silently-closed subscription.
- Biome formatting (2 spaces, single quotes) — run `pnpm -w lint:fix` before every commit; run
  `pnpm -w lint` and both backends' `tsc --noEmit`/`tsc -b` before considering a task done.
- No `Co-Authored-By` in commit messages (global rule).
- Follow the spec exactly: `docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md`. If
  anything in this plan seems to contradict it, the spec wins — stop and flag it rather than
  guessing.

---

## Task 1: `Reading.source` — schema + migration

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Create: `backend/prisma/migrations/<timestamp>_add_reading_source/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma enum `ReadingSource` (`POLL` | `LIVE`), `Reading.source: ReadingSource`
  (`@default(POLL)`) — every later task that creates or queries `Reading` rows depends on this.

- [ ] **Step 1: Add the enum and field**

Open `backend/prisma/schema.prisma`, find the `Reading` model (currently ends with
`@@index([deviceId, timestamp])` then `}`). Add a new enum just above the `model Reading {` line,
and add the `source` field as the last field inside the model, right before the `@@index` line:

```prisma
enum ReadingSource {
  POLL // scanner's periodic poll, manual "sync now"/"forcer la synchro", MCP tool reads
  LIVE // live-mode session (backend/src/liveSession/manager.ts)
}

model Reading {
  id        Int      @id @default(autoincrement())
  deviceId  String
  device    Device   @relation(fields: [deviceId], references: [id])
  timestamp DateTime @default(now())

  // ...existing fields, unchanged, do not retype them...

  // How this row was produced — POLL rows feed the Health Engine's rolling baseline and the
  // 24h/7d/30d history charts; LIVE rows (up to 300 in a 5min session) never do, so a live
  // session can never skew either (docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md).
  source ReadingSource @default(POLL)

  @@index([deviceId, timestamp])
}
```

Only add the `enum ReadingSource { ... }` block and the `source` field — leave every other line of
the `Reading` model exactly as it already is.

- [ ] **Step 2: Generate and apply the migration**

Run from `backend/`:

```bash
cd backend
pnpm exec prisma migrate dev --name add_reading_source
```

Expected: Prisma prints `Applying migration ...add_reading_source` and creates
`backend/prisma/migrations/<timestamp>_add_reading_source/migration.sql`. Because the field has
`@default(POLL)`, this needs no manual backfill — SQLite's generated `ALTER TABLE` sets every
existing row to `'POLL'` automatically. This also regenerates the Prisma client.

- [ ] **Step 3: Verify**

```bash
cd backend
pnpm exec prisma studio &  # optional visual check, or:
sqlite3 prisma/dev.db "SELECT source, COUNT(*) FROM Reading GROUP BY source;"
```

Expected: a single row `POLL|<total row count>` — confirms every pre-existing row got the default,
no `NULL`s, no `LIVE` rows yet.

- [ ] **Step 4: Typecheck**

```bash
cd backend
pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: no new errors (existing `Reading`-related code doesn't reference `source` yet, so this
should be a no-op check — if it fails, something else already broke).

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "Add Reading.source (POLL/LIVE) for the upcoming live sensor mode"
```

---

## Task 2: Thread `source` through every reader/writer of `Reading`

**Files:**
- Modify: `backend/src/readings.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/api/trpc/routers/devices.ts`
- Modify: `backend/src/health/scheduler.ts`
- Modify: `backend/src/api/trpc/routers/health.ts`
- Modify: `backend/src/mqtt/publisher.ts`
- Modify: `frontend/src/lib/types.ts`

**Interfaces:**
- Consumes: `Reading.source` (Task 1).
- Produces: `persistReading(deviceId, kind, reading, source: 'POLL' | 'LIVE')` — Task 6's
  `liveSession/manager.ts` will call this with `'LIVE'`.

- [ ] **Step 1: Make `source` explicit in `persistReading`**

In `backend/src/readings.ts`, change the function signature and the `create` call:

```typescript
import { emitReading } from './api/trpc/readingsEmitter.js';
import { serializeReading } from './api/trpc/serialize.js';
import { prisma } from './db/client.js';
import { getMqttState } from './mqtt/manager.js';
import { publishHealthState, publishReadingState } from './mqtt/publisher.js';
import type { DeviceKind, SensorReading } from './providers/types.js';
import type { ReadingSource } from '@prisma/client';

// Shared by the scanner's automatic poll cycle (ble/scanner.ts, via index.ts's onReading
// callback), the manual "sync now"/"forcer la synchro" tRPC mutations (devices.sync/forceSyncAll),
// and the live-mode session manager (liveSession/manager.ts) — every producer of a Reading row
// goes through this one function so persistence/broadcast never diverges between them. `source` is
// required (no default) so every call site is explicit about which one it is — POLL rows feed the
// Health Engine's rolling baseline and history charts, LIVE rows never do (see
// docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md).
export async function persistReading(deviceId: string, kind: DeviceKind, reading: SensorReading, source: ReadingSource) {
  const data =
    reading.kind === 'PARROT_POT'
      ? {
          soilMoisturePercent: reading.data.soilMoisturePercent,
          temperatureC: reading.data.temperatureC,
          luminosity: reading.data.luminosity,
          waterTankLevelPercent: reading.data.waterTankLevelPercent,
          soilConductivityEcb: reading.data.soilConductivityEcb,
          soilConductivityEcPorous: reading.data.soilConductivityEcPorous,
          isDrySoil: reading.data.isDrySoil,
          isWetSoil: reading.data.isWetSoil,
          isEmptyTank: reading.data.isEmptyTank,
          isInAir: reading.data.isInAir,
        }
      : {
          temperatureC: reading.data.temperatureC,
          humidityPercent: reading.data.humidityPercent,
          batteryPercent: reading.data.batteryPercent,
        };

  const created = await prisma.reading.create({ data: { deviceId, source, ...data } });
  emitReading({ deviceId, kind, reading: serializeReading(created) });

  const mqttState = getMqttState();
  if (mqttState) {
    publishReadingState(mqttState.client, deviceId, data, mqttState.baseTopic);
    void publishHealthState(mqttState.client, deviceId, mqttState.baseTopic);
  }

  return created;
}
```

- [ ] **Step 2: Update the 3 existing call sites to pass `'POLL'`**

In `backend/src/index.ts`, find `async onReading(deviceId, kind, reading) {` and change the call
inside it from `await persistReading(deviceId, kind, reading);` to:

```typescript
await persistReading(deviceId, kind, reading, 'POLL');
```

In `backend/src/api/trpc/routers/devices.ts`, the `sync` mutation has
`await persistReading(device.id, device.kind, reading);` — change to:

```typescript
await persistReading(device.id, device.kind, reading, 'POLL');
```

In the same file, the `forceSyncAll` mutation has
`.then((reading) => persistReading(device.id, device.kind, reading))` — change to:

```typescript
.then((reading) => persistReading(device.id, device.kind, reading, 'POLL'))
```

- [ ] **Step 3: Exclude `LIVE` rows from every baseline/history/MQTT read**

In `backend/src/health/scheduler.ts`, inside `evaluateDevice`, find:

```typescript
  const readings = await prisma.reading.findMany({
    where: { deviceId: device.id, timestamp: { gte: since } },
    orderBy: { timestamp: 'asc' },
  });
```

Change the `where` to:

```typescript
  const readings = await prisma.reading.findMany({
    where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
    orderBy: { timestamp: 'asc' },
  });
```

In `backend/src/api/trpc/routers/health.ts`, inside `deviceHealth`, apply the identical change to
its `prisma.reading.findMany` call (same shape, same fix: add `source: 'POLL'` to the `where`).

In `backend/src/api/trpc/routers/devices.ts`, inside the `history` query, find:

```typescript
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
```

Change to:

```typescript
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
      orderBy: { timestamp: 'asc' },
    });
```

In `backend/src/mqtt/publisher.ts`, inside `publishHealthState`, find:

```typescript
  const readings = await prisma.reading.findMany({ where: { deviceId, timestamp: { gte: since } }, orderBy: { timestamp: 'asc' } });
```

Change to:

```typescript
  const readings = await prisma.reading.findMany({ where: { deviceId, timestamp: { gte: since }, source: 'POLL' }, orderBy: { timestamp: 'asc' } });
```

- [ ] **Step 4: Mirror the new field in the frontend's manually-typed `Reading`**

In `frontend/src/lib/types.ts`, inside `export interface Reading { ... }`, add one field (matches
the wire shape now returned by every procedure that serializes a `Reading` row):

```typescript
  source: 'POLL' | 'LIVE';
```

Add it right after `deviceId: string;` — doesn't need to be used anywhere yet, just kept accurate.

- [ ] **Step 5: Typecheck both packages**

```bash
cd backend && pnpm exec tsc --noEmit -p tsconfig.json
cd ../frontend && pnpm exec tsc -b
```

Expected: no errors. If `tsc` complains `source` is missing in a `prisma.reading.create` call
somewhere you didn't touch, you missed a call site — search
`grep -rn "reading.create" backend/src` and make sure `persistReading` is the only one (it should
be — this is the whole point of that shared function).

- [ ] **Step 6: Manual verification (mock provider, scratch DB)**

```bash
cd backend
cp prisma/dev.db /tmp/live-mode-verify.db
DATABASE_URL="file:/tmp/live-mode-verify.db" pnpm exec prisma migrate deploy
BLE_PROVIDER=mock DATABASE_URL="file:/tmp/live-mode-verify.db" PORT=3990 BETTER_AUTH_SECRET=verifysecretverifysecretverify \
  pnpm exec tsx src/index.ts > /tmp/live-mode-verify.log 2>&1 &
sleep 3
BASE_URL=http://localhost:3990 ADMIN_EMAIL=verify@test.local ADMIN_PASSWORD=verifypassword123 \
  DATABASE_URL="file:/tmp/live-mode-verify.db" pnpm exec tsx src/auth/seed-admin.ts
curl -s -c /tmp/live-cookies.txt -X POST http://localhost:3990/api/auth/sign-in/email \
  -H "Content-Type: application/json" -d '{"email":"verify@test.local","password":"verifypassword123"}' > /dev/null
```

Manually insert one `LIVE`-tagged row directly (simulates what Task 6's manager will do later,
before it exists):

```bash
sqlite3 /tmp/live-mode-verify.db \
  "INSERT INTO Reading (deviceId, timestamp, soilMoisturePercent, source) VALUES ('MOCK-POT-NORMAL', datetime('now'), 999, 'LIVE');"
```

Then confirm it's excluded from history and health, but a `POLL` row (already there from the
scanner's own boot-time poll) is included:

```bash
curl -s -b /tmp/live-cookies.txt "http://localhost:3990/api/trpc/devices.history?input=%7B%22deviceId%22%3A%22MOCK-POT-NORMAL%22%2C%22hours%22%3A24%7D" \
  | python3 -c "import json,sys; d=json.load(sys.stdin)['result']['data']; print('rows:', len(d)); print('any soil=999 (would mean the LIVE row leaked in):', any(r.get('soilMoisturePercent')==999 for r in d))"
```

Expected: `rows: <some number >= 1>` and `any soil=999...: False` — the manually-inserted `LIVE`
row must never appear. Then stop the server: `kill %1` (or find the PID from `/tmp/live-mode-verify.log`'s "API listening" line's surrounding shell job).

- [ ] **Step 7: Commit**

```bash
git add backend/src/readings.ts backend/src/index.ts backend/src/api/trpc/routers/devices.ts \
  backend/src/health/scheduler.ts backend/src/api/trpc/routers/health.ts backend/src/mqtt/publisher.ts \
  frontend/src/lib/types.ts
git commit -m "Exclude live-session readings from the Health Engine baseline and history charts"
```

---

## Task 3: `DeviceProvider.subscribeLive` interface + mock implementation

**Files:**
- Modify: `backend/src/providers/types.ts`
- Modify: `backend/src/providers/mock/index.ts`

**Interfaces:**
- Produces: `DeviceProvider.subscribeLive(deviceId, kind, onSample, signal): Promise<void>` — every
  provider (this task's mock, Task 4's noble-bridge stub, Task 5's node-ble) implements this exact
  signature. `onSample: (reading: SensorReading) => Promise<void>` — Task 6's manager passes a
  callback matching this shape.

- [ ] **Step 1: Add the interface method**

In `backend/src/providers/types.ts`, inside `export interface DeviceProvider { ... }`, add this
method right after `readSensors`:

```typescript
  // Streams live sensor samples (real GATT notify on the Parrot Pot, best-effort on the Xiaomi —
  // see docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md) until `signal` aborts.
  // Resolves cleanly on abort. Throws on any unrecoverable failure (GATT error, unexpected
  // disconnect) — callers must treat a thrown error as the session having ended abnormally, never
  // retry it themselves (a live session that already streamed real samples must not silently
  // restart from scratch). `onSample` is awaited before the provider processes the next
  // notification, so persistence (which it triggers) never races itself.
  subscribeLive(
    deviceId: string,
    kind: DeviceKind,
    onSample: (reading: SensorReading) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;
```

- [ ] **Step 2: Implement it in the mock provider**

In `backend/src/providers/mock/index.ts`, add a helper near the top (after `applyXiaomiNoise`,
before `export function createMockProvider`):

```typescript
const MOCK_LIVE_SAMPLE_INTERVAL_MS = 1000;
```

Then, inside `createMockProvider()`'s returned object, add `subscribeLive` right after
`readSensors` (reuses the exact same `pots`/`xiaomiSensors` maps and decay/noise helpers the
existing `readSensors` already uses, so live values are just as plausible):

```typescript
    async subscribeLive(deviceId: string, kind, onSample, signal): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(() => {
          void (async () => {
            try {
              if (kind === 'XIAOMI_LYWSD03MMC') {
                const sensor = xiaomiSensors.get(deviceId);
                if (!sensor) throw new Error(`Mock device ${deviceId} inconnu`);
                applyXiaomiNoise(sensor);
                await onSample({
                  kind: 'XIAOMI_LYWSD03MMC',
                  data: { temperatureC: sensor.temperatureC, humidityPercent: sensor.humidityPercent, batteryPercent: sensor.batteryPercent },
                });
                return;
              }

              const pot = pots.get(deviceId);
              if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
              applyPotDecay(pot);
              await onSample({
                kind: 'PARROT_POT',
                data: { soilMoisturePercent: pot.soilMoisturePercent, temperatureC: pot.temperatureC, luminosity: pot.luminosity },
              });
            } catch (error) {
              clearInterval(interval);
              reject(error);
            }
          })();
        }, MOCK_LIVE_SAMPLE_INTERVAL_MS);

        signal.addEventListener(
          'abort',
          () => {
            clearInterval(interval);
            resolve();
          },
          { once: true },
        );
      });
    },
```

- [ ] **Step 3: Typecheck**

```bash
cd backend && pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: fails here if `noble-bridge`/`node-ble` don't implement `subscribeLive` yet — that's
correct and expected until Tasks 4/5 are done. If it fails on the `mock` provider itself, fix that
before moving on.

- [ ] **Step 4: Manual verification (mock only, isolated)**

Create a throwaway script (adjust the path to wherever you keep scratch files) and run it once:

```typescript
// /tmp/verify-mock-live.ts
import { createMockProvider } from './src/providers/mock/index.js';

const provider = createMockProvider();
const samples: unknown[] = [];
const controller = new AbortController();

setTimeout(() => controller.abort(), 2500);

await provider.subscribeLive(
  'MOCK-POT-NORMAL',
  'PARROT_POT',
  async (reading) => {
    samples.push(reading);
  },
  controller.signal,
);

console.log(`received ${samples.length} samples`);
if (samples.length < 2) throw new Error('expected at least 2 samples in 2.5s at 1/s');
console.log('OK');
```

```bash
cd backend
pnpm exec tsx /tmp/verify-mock-live.ts
```

Expected: `received 2 samples` (or 3) then `OK`. If it hangs past ~3s, the `abort` listener isn't
wired correctly — check the `signal.addEventListener('abort', ...)` block.

- [ ] **Step 5: Commit**

```bash
git add backend/src/providers/types.ts backend/src/providers/mock/index.ts
git commit -m "Add DeviceProvider.subscribeLive, implemented for the mock provider"
```

---

## Task 4: `noble-bridge` stub

**Files:**
- Modify: `backend/src/providers/noble-bridge/index.ts`

**Interfaces:**
- Consumes: `DeviceProvider.subscribeLive` signature from Task 3.

- [ ] **Step 1: Add the stub**

In `backend/src/providers/noble-bridge/index.ts`, inside the returned object (alongside `scan`,
`readSensors`, etc.), add:

```typescript
    async subscribeLive(): Promise<void> {
      // Deliberate scope cut (docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md):
      // noble-bridge (Mac dev environment) doesn't implement real live sampling yet — validating
      // node-ble's live GATT notify happens directly on the production server, matching how
      // node-ble itself was originally validated there rather than via this provider.
      throw new Error('subscribeLive not implemented on noble-bridge');
    },
```

- [ ] **Step 2: Typecheck**

```bash
cd backend && pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: still fails only on `node-ble` (Task 5) not implementing `subscribeLive` yet.

- [ ] **Step 3: Manual verification**

```typescript
// /tmp/verify-noble-bridge-stub.ts
import { createNobleBridgeProvider } from './src/providers/noble-bridge/index.js';

const provider = createNobleBridgeProvider();
try {
  await provider.subscribeLive('X', 'PARROT_POT', async () => {}, new AbortController().signal);
  throw new Error('expected subscribeLive to throw');
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('not implemented')) throw error;
  console.log('OK — throws as expected:', error.message);
}
```

```bash
cd backend
pnpm exec tsx /tmp/verify-noble-bridge-stub.ts
```

Expected: `OK — throws as expected: subscribeLive not implemented on noble-bridge`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/providers/noble-bridge/index.ts
git commit -m "Stub subscribeLive on noble-bridge (out of scope for this batch)"
```

---

## Task 5: `node-ble` real implementation

**Files:**
- Modify: `backend/src/providers/node-ble/index.ts`

**Interfaces:**
- Consumes: `DeviceProvider.subscribeLive` signature (Task 3), existing helpers already in this
  file: `connectDevice(macAddress)`, `releaseDbusListeners(target)`, `trackedCharacteristic(service, uuid, tracked)`,
  `withTimeout(promise, ms, label)`, constants `CONNECT_TIMEOUT_MS`, `UUIDS`, `SENSOR_SERVICE_UUID`,
  `XIAOMI_DATA_SERVICE_UUID`, `TEMP_HUMIDITY_CHARACTERISTIC_UUID`, `parseTempHumidityPayload`.

**Design notes for whoever implements this** (context a fresh reader needs, not in the interface
signature alone):
- Deliberately **does not** wrap the whole session in `withGattRetry` like `readSensors` does —
  that helper's retry semantics assume a quick one-shot operation; retrying a multi-minute live
  session from scratch after it already streamed real samples would be wrong. Only the *initial*
  `connectDevice()` call can fail outright (surfaced as a thrown error, no retry) — a mid-session
  disconnect ends the function the same way.
- The 3 Parrot Pot live characteristics (`soilMoisturePercent`/`temperatureC`/`luminosity`) notify
  **independently** — they don't fire in lockstep. A short debounce (150ms) combines whatever's
  most recently known into one `ParrotPotReading` sample instead of persisting 3x/second with 2
  fields stale each time.
- node-ble's `Device` re-emits BlueZ's `Connected` property change as its own `'disconnect'` event
  (see `Device.connect()` in `node_modules/node-ble/src/Device.js`) for as long as the device
  hasn't had `disconnect()` called on it yet — listen for it so an unexpected mid-session drop ends
  the function with a thrown error instead of hanging forever.

- [ ] **Step 1: Implement the Xiaomi path**

In `backend/src/providers/node-ble/index.ts`, add `subscribeLive` to the returned object, right
after `readSensors`. Start with the Xiaomi branch:

```typescript
    async subscribeLive(deviceId: string, kind, onSample, signal): Promise<void> {
      if (kind === 'XIAOMI_LYWSD03MMC') {
        const device = await connectDevice(deviceId);
        try {
          const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
          const dataService = await gatt.getPrimaryService(XIAOMI_DATA_SERVICE_UUID);
          const tempHumidityChar = await dataService.getCharacteristic(TEMP_HUMIDITY_CHARACTERISTIC_UUID);
          await tempHumidityChar.startNotifications();
          try {
            await new Promise<void>((resolve, reject) => {
              let pending: Promise<void> = Promise.resolve();
              const onValue = (buf: Buffer) => {
                const data = parseTempHumidityPayload(buf);
                pending = pending.then(() => onSample({ kind: 'XIAOMI_LYWSD03MMC', data }));
              };
              const onAbort = () => {
                tempHumidityChar.removeListener('valuechanged', onValue);
                device.removeListener('disconnect', onDisconnect);
                resolve();
              };
              const onDisconnect = () => {
                tempHumidityChar.removeListener('valuechanged', onValue);
                signal.removeEventListener('abort', onAbort);
                reject(new Error('Device disconnected unexpectedly during live session'));
              };
              tempHumidityChar.on('valuechanged', onValue);
              signal.addEventListener('abort', onAbort, { once: true });
              device.once('disconnect', onDisconnect);
            });
          } finally {
            await tempHumidityChar.stopNotifications().catch(() => {});
            releaseDbusListeners(tempHumidityChar);
          }
        } finally {
          await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
          releaseDbusListeners(device);
        }
        return;
      }

      // Parrot Pot branch — Step 2.
    },
```

- [ ] **Step 2: Implement the Parrot Pot path**

Replace the `// Parrot Pot branch — Step 2.` comment with:

```typescript
      const device = await connectDevice(deviceId);
      const characteristics: GattCharacteristic[] = [];
      try {
        const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
        const sensorService = await gatt.getPrimaryService(SENSOR_SERVICE_UUID);

        const measurePeriod = await trackedCharacteristic(sensorService, UUIDS.live.measurePeriod, characteristics);
        await measurePeriod.writeValueWithResponse(Buffer.from([1]));
        log({
          direction: 'WRITE',
          label: 'Activate live measure period (live session)',
          uuid: UUIDS.live.measurePeriod,
          deviceId,
          payloadHex: '01',
          result: 'OK',
        });

        const soilChar = await trackedCharacteristic(sensorService, UUIDS.live.soilMoisturePercent, characteristics);
        const tempChar = await trackedCharacteristic(sensorService, UUIDS.live.temperatureC, characteristics);
        const luxChar = await trackedCharacteristic(sensorService, UUIDS.live.luminosity, characteristics);

        try {
          await new Promise<void>((resolve, reject) => {
            const pending: { soilMoisturePercent?: number; temperatureC?: number; luminosity?: number } = {};
            let flushTimer: NodeJS.Timeout | undefined;
            let flushing: Promise<void> = Promise.resolve();

            const scheduleFlush = () => {
              if (flushTimer) return;
              flushTimer = setTimeout(() => {
                flushTimer = undefined;
                if (pending.soilMoisturePercent === undefined || pending.temperatureC === undefined || pending.luminosity === undefined) {
                  return; // wait for the first complete triple before ever sampling
                }
                const snapshot = {
                  soilMoisturePercent: pending.soilMoisturePercent,
                  temperatureC: pending.temperatureC,
                  luminosity: pending.luminosity,
                };
                flushing = flushing.then(() => onSample({ kind: 'PARROT_POT', data: snapshot }));
              }, 150);
            };

            const onSoil = (buf: Buffer) => {
              pending.soilMoisturePercent = buf.readFloatLE(0);
              scheduleFlush();
            };
            const onTemp = (buf: Buffer) => {
              pending.temperatureC = buf.readFloatLE(0);
              scheduleFlush();
            };
            const onLux = (buf: Buffer) => {
              pending.luminosity = buf.readFloatLE(0);
              scheduleFlush();
            };

            const cleanupListeners = () => {
              soilChar.removeListener('valuechanged', onSoil);
              tempChar.removeListener('valuechanged', onTemp);
              luxChar.removeListener('valuechanged', onLux);
              if (flushTimer) clearTimeout(flushTimer);
            };
            const onAbort = () => {
              cleanupListeners();
              device.removeListener('disconnect', onDisconnect);
              resolve();
            };
            const onDisconnect = () => {
              cleanupListeners();
              signal.removeEventListener('abort', onAbort);
              reject(new Error('Device disconnected unexpectedly during live session'));
            };

            soilChar.on('valuechanged', onSoil);
            tempChar.on('valuechanged', onTemp);
            luxChar.on('valuechanged', onLux);
            signal.addEventListener('abort', onAbort, { once: true });
            device.once('disconnect', onDisconnect);
          });
        } finally {
          for (const characteristic of [soilChar, tempChar, luxChar]) {
            await characteristic.stopNotifications().catch(() => {});
          }
          await measurePeriod.writeValueWithResponse(Buffer.from([0])).catch(() => {});
        }
      } finally {
        for (const characteristic of characteristics) releaseDbusListeners(characteristic);
        await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
        releaseDbusListeners(device);
      }
```

Note: this uses `soilChar.on('valuechanged', ...)` directly (not `startNotifications()` first) —
double check against `waitForFirstNotification` above in the same file: it calls
`await characteristic.startNotifications()` **before** attaching the `'valuechanged'` listener.
Add that same call for all 3 characteristics, right before the `try { await new Promise...`
block:

```typescript
        await soilChar.startNotifications();
        await tempChar.startNotifications();
        await luxChar.startNotifications();

        try {
          await new Promise<void>((resolve, reject) => {
```

- [ ] **Step 3: Typecheck and lint**

```bash
cd backend
pnpm exec tsc --noEmit -p tsconfig.json
cd .. && pnpm -w lint:fix && pnpm -w lint
```

Expected: no errors. All 3 providers now implement `subscribeLive`, so this is the first point
where the whole backend typechecks clean again since Task 3.

- [ ] **Step 4: Verification note (no real hardware in this environment)**

This cannot be exercised without a real Parrot Pot/Xiaomi and the production server's Bluetooth
adapter — do **not** attempt to fake this with mocked D-Bus calls. Log it as a known gap the same
way Batch 6's Plant Dr calibration was: "not yet validated against real hardware, first real test
happens on the production server." Do not mark this step as more verified than that.

- [ ] **Step 5: Commit**

```bash
git add backend/src/providers/node-ble/index.ts
git commit -m "Implement subscribeLive on node-ble (Parrot Pot notify + Xiaomi notify)"
```

---

## Task 6: `liveSession` manager (session lifecycle, single-session guard, timeout)

**Files:**
- Create: `backend/src/liveSession/manager.ts`

**Interfaces:**
- Consumes: `persistReading(deviceId, kind, reading, source)` (Task 2), `DeviceProvider.subscribeLive`
  (Tasks 3-5), `ConnectionQueue.run(task)` (existing, `backend/src/ble/connectionQueue.ts`), `log()`
  (existing, `backend/src/logger.ts`), `serializeReading()` (existing,
  `backend/src/api/trpc/serialize.ts`).
- Produces (consumed by Task 7's tRPC router):
  - `liveSessionEmitter: EventEmitter` (emits `'event'` with a `LiveSessionEvent` payload)
  - `LiveSessionEvent = LiveSampleEvent | LiveEndedEvent`
  - `LiveSampleEvent = { type: 'sample'; deviceId: string; reading: SerializedReading }`
  - `LiveEndedEvent = { type: 'ended'; deviceId: string; reason: 'stopped' | 'timeout' | 'error'; detail?: string }`
  - `startLiveSession(deviceId: string, kind: DeviceKind, provider: DeviceProvider, connectionQueue: ConnectionQueue, maxDurationMs?: number): void`
    — throws synchronously if a session is already active elsewhere. `maxDurationMs` defaults to
    `LIVE_SESSION_MAX_DURATION_MS` (5min) — overridable so tests can exercise the auto-cutoff path
    without waiting 5 real minutes.
  - `stopLiveSession(deviceId: string): void` — no-op if nothing to stop.
  - `getActiveLiveSession(): { deviceId: string; startedAt: string } | null`

- [ ] **Step 1: Write the module**

Create `backend/src/liveSession/manager.ts`:

```typescript
import { EventEmitter } from 'node:events';
import type { DeviceKind } from '@prisma/client';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import type { SerializedReading } from '../api/trpc/serialize.js';
import { serializeReading } from '../api/trpc/serialize.js';
import { log } from '../logger.js';
import type { DeviceProvider, SensorReading } from '../providers/types.js';
import { persistReading } from '../readings.js';

// Bounds how long a live session can hold the single shared GATT connection, starving the
// scanner's own polling and the auto-watering scheduler for everyone else (see
// docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md).
export const LIVE_SESSION_MAX_DURATION_MS = 5 * 60_000;

export type LiveSessionEndReason = 'stopped' | 'timeout' | 'error';

export interface LiveSampleEvent {
  type: 'sample';
  deviceId: string;
  reading: SerializedReading;
}
export interface LiveEndedEvent {
  type: 'ended';
  deviceId: string;
  reason: LiveSessionEndReason;
  detail?: string;
}
export type LiveSessionEvent = LiveSampleEvent | LiveEndedEvent;

interface ActiveSession {
  deviceId: string;
  controller: AbortController;
  startedAt: number;
}

// Module-level singleton state, same pattern as mqtt/manager.ts — exactly one live session
// globally at a time (the single shared GATT connection can't do more than one anyway; this makes
// a second attempt fail fast and clearly instead of silently queuing for up to 5 minutes).
let activeSession: ActiveSession | null = null;

export const liveSessionEmitter = new EventEmitter();

export function getActiveLiveSession(): { deviceId: string; startedAt: string } | null {
  if (!activeSession) return null;
  return { deviceId: activeSession.deviceId, startedAt: new Date(activeSession.startedAt).toISOString() };
}

// maxDurationMs defaults to the real 5min cutoff — overridable so a test can exercise the
// auto-cutoff path without actually waiting 5 minutes (see Task 6 Step 3's verification script).
export function startLiveSession(
  deviceId: string,
  kind: DeviceKind,
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
  maxDurationMs = LIVE_SESSION_MAX_DURATION_MS,
): void {
  if (activeSession) {
    throw new Error(`Une session live est déjà active sur ${activeSession.deviceId}`);
  }

  const controller = new AbortController();
  let stopReason: 'stopped' | 'timeout' = 'stopped';
  activeSession = { deviceId, controller, startedAt: Date.now() };

  const timeoutHandle = setTimeout(() => {
    stopReason = 'timeout';
    controller.abort();
  }, maxDurationMs);

  const onSample = async (reading: SensorReading): Promise<void> => {
    try {
      const created = await persistReading(deviceId, kind, reading, 'LIVE');
      const event: LiveSampleEvent = { type: 'sample', deviceId, reading: serializeReading(created) };
      liveSessionEmitter.emit('event', event);
    } catch (error) {
      // Best-effort persistence for a streaming UI feature — a single failed DB write must never
      // kill an otherwise-healthy live session (unlike a real BLE device action, which
      // docs/STROYPLANT_SPEC.md section 7.1's never-silent rule is actually about).
      log({
        direction: 'INFO',
        label: 'Live sample persist failed',
        deviceId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  connectionQueue
    .run(() => provider.subscribeLive(deviceId, kind, onSample, controller.signal))
    .then(
      () => {
        const event: LiveEndedEvent = { type: 'ended', deviceId, reason: stopReason };
        liveSessionEmitter.emit('event', event);
      },
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        log({ direction: 'INFO', label: 'Live session ended abnormally', deviceId, result: 'ERROR', detail });
        const event: LiveEndedEvent = { type: 'ended', deviceId, reason: 'error', detail };
        liveSessionEmitter.emit('event', event);
      },
    )
    .finally(() => {
      clearTimeout(timeoutHandle);
      activeSession = null;
    });
}

export function stopLiveSession(deviceId: string): void {
  if (activeSession?.deviceId === deviceId) {
    activeSession.controller.abort();
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd backend && pnpm exec tsc --noEmit -p tsconfig.json
```

Expected: clean.

- [ ] **Step 3: Manual verification (mock provider, no HTTP layer yet)**

```typescript
// /tmp/verify-live-manager.ts
import { ConnectionQueue } from './src/ble/connectionQueue.js';
import {
  getActiveLiveSession,
  liveSessionEmitter,
  startLiveSession,
  stopLiveSession,
  type LiveSessionEvent,
} from './src/liveSession/manager.js';
import { createMockProvider } from './src/providers/mock/index.js';

const provider = createMockProvider();
const connectionQueue = new ConnectionQueue();
const events: LiveSessionEvent[] = [];
liveSessionEmitter.on('event', (event: LiveSessionEvent) => events.push(event));

startLiveSession('MOCK-POT-NORMAL', 'PARROT_POT', provider, connectionQueue);
console.log('status after start:', getActiveLiveSession());

// A second start attempt must fail immediately, not queue silently.
try {
  startLiveSession('MOCK-XIAOMI-01', 'XIAOMI_LYWSD03MMC', provider, connectionQueue);
  throw new Error('expected the second startLiveSession to throw');
} catch (error) {
  console.log('second start correctly rejected:', (error as Error).message);
}

await new Promise((resolve) => setTimeout(resolve, 2500));
console.log('sample events received:', events.filter((e) => e.type === 'sample').length);

stopLiveSession('MOCK-POT-NORMAL');
await new Promise((resolve) => setTimeout(resolve, 300));
console.log('status after stop:', getActiveLiveSession());
console.log(
  'ended event:',
  events.find((e) => e.type === 'ended'),
);

if (getActiveLiveSession() !== null) throw new Error('expected no active session after stop');
if (events.filter((e) => e.type === 'sample').length < 2) throw new Error('expected at least 2 samples');
const ended = events.find((e) => e.type === 'ended');
if (!ended || ended.type !== 'ended' || ended.reason !== 'stopped') throw new Error('expected an ended event with reason=stopped');
console.log('OK');
```

```bash
cd backend
pnpm exec tsx /tmp/verify-live-manager.ts
```

Expected: prints the status/events described above, ending with `OK`. This is the key check that
the single-session guard and the stop path both work correctly before any HTTP/WS layer is built
on top.

- [ ] **Step 4: Manual verification — auto-cutoff path**

Append to the same throwaway script (or a new one) to prove the 5-minute cutoff actually fires,
using the `maxDurationMs` override so this doesn't take 5 real minutes:

```typescript
// /tmp/verify-live-timeout.ts
import { ConnectionQueue } from './src/ble/connectionQueue.js';
import { getActiveLiveSession, liveSessionEmitter, startLiveSession, type LiveSessionEvent } from './src/liveSession/manager.js';
import { createMockProvider } from './src/providers/mock/index.js';

const provider = createMockProvider();
const connectionQueue = new ConnectionQueue();
const events: LiveSessionEvent[] = [];
liveSessionEmitter.on('event', (event: LiveSessionEvent) => events.push(event));

startLiveSession('MOCK-POT-NORMAL', 'PARROT_POT', provider, connectionQueue, 500); // 500ms override
await new Promise((resolve) => setTimeout(resolve, 900));

console.log('status after auto-cutoff:', getActiveLiveSession());
const ended = events.find((e) => e.type === 'ended');
console.log('ended event:', ended);

if (getActiveLiveSession() !== null) throw new Error('expected the session to have auto-stopped');
if (!ended || ended.type !== 'ended' || ended.reason !== 'timeout') throw new Error('expected an ended event with reason=timeout');
console.log('OK');
```

```bash
cd backend
pnpm exec tsx /tmp/verify-live-timeout.ts
```

Expected: `status after auto-cutoff: null`, an `ended` event with `reason: 'timeout'`, then `OK`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/liveSession/manager.ts
git commit -m "Add the live session manager (single-session guard, 5min auto-cutoff)"
```

---

## Task 7: tRPC `liveSession` router

**Files:**
- Create: `backend/src/api/trpc/routers/liveSession.ts`
- Modify: `backend/src/api/trpc/router.ts`

**Interfaces:**
- Consumes: everything Task 6 exports, plus `ctx.provider`/`ctx.connectionQueue` (existing
  `TrpcDeps`, already available in every procedure's `ctx`), `protectedProcedure`/`router`
  (existing, `backend/src/api/trpc/trpc.ts`).
- Produces: `liveSession.start`, `liveSession.stop`, `liveSession.status`, `liveSession.onSample` —
  Task 8's frontend component calls all 4.

- [ ] **Step 1: Write the router**

Create `backend/src/api/trpc/routers/liveSession.ts`:

```typescript
import { on } from 'node:events';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import {
  getActiveLiveSession,
  type LiveSessionEvent,
  liveSessionEmitter,
  startLiveSession,
  stopLiveSession,
} from '../../../liveSession/manager.js';
import { protectedProcedure, router } from '../trpc.js';

export const liveSessionRouter = router({
  // Which device (if any) currently holds the single shared GATT connection for a live session —
  // backs the "Mode live" button's disabled state on every other device's page.
  status: protectedProcedure.query(() => getActiveLiveSession()),

  start: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    try {
      startLiveSession(device.id, device.kind, ctx.provider, ctx.connectionQueue);
    } catch (error) {
      // Expected, not a bug: another device already has the single shared connection
      // (docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md).
      throw new TRPCError({ code: 'CONFLICT', message: error instanceof Error ? error.message : String(error) });
    }
    return { ok: true as const };
  }),

  stop: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(({ input }) => {
    stopLiveSession(input.deviceId);
    return { ok: true as const };
  }),

  // Same on()-based async-iterator pattern as readings.onReading (routers/readings.ts) — filters
  // the shared emitter down to the one device this subscriber actually asked about, since
  // liveSessionEmitter broadcasts every active session's events regardless of which page is open.
  onSample: protectedProcedure.input(z.object({ deviceId: z.string() })).subscription(async function* (opts) {
    for await (const [event] of on(liveSessionEmitter, 'event', { signal: opts.signal })) {
      const typedEvent = event as LiveSessionEvent;
      if (typedEvent.deviceId === opts.input.deviceId) yield typedEvent;
    }
  }),
});
```

- [ ] **Step 2: Wire it into the app router**

In `backend/src/api/trpc/router.ts`, add the import and the entry (keep the existing ones
alphabetical, as they already are):

```typescript
import { devicesRouter } from './routers/devices.js';
import { healthRouter } from './routers/health.js';
import { liveSessionRouter } from './routers/liveSession.js';
import { mqttRouter } from './routers/mqtt.js';
import { plantDrRouter } from './routers/plantDr.js';
import { readingsRouter } from './routers/readings.js';
import { scheduleRouter } from './routers/schedule.js';
import { router } from './trpc.js';

export const appRouter = router({
  devices: devicesRouter,
  health: healthRouter,
  liveSession: liveSessionRouter,
  mqtt: mqttRouter,
  plantDr: plantDrRouter,
  readings: readingsRouter,
  schedule: scheduleRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 3: Typecheck and lint**

```bash
cd backend && pnpm exec tsc --noEmit -p tsconfig.json
cd .. && pnpm -w lint:fix && pnpm -w lint
```

Expected: clean.

- [ ] **Step 4: Manual verification (mock provider, HTTP + WS)**

Boot the backend the same way as Task 2's Step 6 (mock provider, scratch DB, port 3991 to avoid
clashing with anything else still running), sign in, get a cookie, then:

```bash
echo "--- status before ---"
curl -s -b /tmp/live-cookies.txt "http://localhost:3991/api/trpc/liveSession.status"

echo "--- start ---"
curl -s -b /tmp/live-cookies.txt -X POST "http://localhost:3991/api/trpc/liveSession.start?batch=1" \
  -H "Content-Type: application/json" -d '{"0":{"deviceId":"MOCK-POT-NORMAL"}}'

echo "--- status while active ---"
curl -s -b /tmp/live-cookies.txt "http://localhost:3991/api/trpc/liveSession.status"

echo "--- second start on a different device must be rejected (CONFLICT) ---"
curl -s -b /tmp/live-cookies.txt -X POST "http://localhost:3991/api/trpc/liveSession.start?batch=1" \
  -H "Content-Type: application/json" -d '{"0":{"deviceId":"MOCK-XIAOMI-01"}}'

echo "--- stop ---"
curl -s -b /tmp/live-cookies.txt -X POST "http://localhost:3991/api/trpc/liveSession.stop?batch=1" \
  -H "Content-Type: application/json" -d '{"0":{"deviceId":"MOCK-POT-NORMAL"}}'

echo "--- status after stop ---"
curl -s -b /tmp/live-cookies.txt "http://localhost:3991/api/trpc/liveSession.status"
```

Expected: `status before` → `{"result":{"data":null}}`; `start` → `{"result":{"data":{"ok":true}}}`;
`status while active` → `{"result":{"data":{"deviceId":"MOCK-POT-NORMAL","startedAt":"..."}}}`;
the second `start` → an error body with `"code":"CONFLICT"`; `stop` → `{"ok":true}`; `status after
stop` → `null` again.

Then verify the subscription actually delivers samples, using a tiny WS-based script (the tRPC
client, same as the frontend will use):

```typescript
// /tmp/verify-live-subscription.ts
import { createTRPCClient, createWSClient, wsLink } from '@trpc/client';
import type { AppRouter } from './backend/src/api/trpc/router.js';

const wsClient = createWSClient({ url: 'ws://localhost:3991/api/trpc' });
const client = createTRPCClient<AppRouter>({ links: [wsLink({ client: wsClient })] });

const samples: unknown[] = [];
const sub = client.liveSession.onSample.subscribe(
  { deviceId: 'MOCK-POT-NORMAL' },
  { onData: (event) => samples.push(event) },
);

// Trigger a session over plain HTTP fetch (the WS link only carries the subscription itself).
await fetch('http://localhost:3991/api/trpc/liveSession.start?batch=1', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Cookie: await Bun?.file?.('/tmp/live-cookies.txt').text().catch(() => '') ?? '' },
  body: JSON.stringify({ '0': { deviceId: 'MOCK-POT-NORMAL' } }),
});

await new Promise((resolve) => setTimeout(resolve, 2500));
sub.unsubscribe();
wsClient.close();

console.log('received', samples.length, 'events');
if (samples.length < 2) throw new Error('expected at least 2 sample/ended events');
console.log('OK');
```

The `Cookie` header plumbing above is fiddly outside a browser — if it's simpler in your
environment, just read `/tmp/live-cookies.txt`'s cookie value manually and hardcode it into a
`fetch` header for this one-off script; it's throwaway, not committed. If starting the session via
`fetch` proves awkward, it's equally valid to trigger `curl ... liveSession.start` in a second
terminal while this script's subscription is running and watching stdout — either way, the goal is
just proving samples arrive over the WS subscription before building the UI on top of it.

Expected: at least 2 sample events logged, then `OK`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/trpc/routers/liveSession.ts backend/src/api/trpc/router.ts
git commit -m "Add the liveSession tRPC router (start/stop/status/onSample)"
```

---

## Task 8: Frontend — "Mode live" section on the device detail page

**Files:**
- Create: `frontend/src/components/live-mode-section.tsx`
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`

**Interfaces:**
- Consumes: `trpc.liveSession.{status,start,stop,onSample}` (Task 7), existing `HistoryChart`
  component (`frontend/src/components/history-chart.tsx`, unchanged — reused as-is), existing
  `Button` (`frontend/src/components/ui/button.tsx`).

- [ ] **Step 1: Write the component**

Create `frontend/src/components/live-mode-section.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { HistoryChart, type HistoryPoint } from '@/components/history-chart';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import type { DeviceKind } from '@/lib/types';

const LIVE_SESSION_MAX_DURATION_MS = 5 * 60_000;
const MAX_BUFFER_SIZE = 300; // matches the 5min cap at ~1 sample/s

interface MetricSpec {
  key: 'soilMoisturePercent' | 'temperatureC' | 'luminosity' | 'humidityPercent';
  label: string;
  unit: string;
}

const PARROT_METRICS: MetricSpec[] = [
  { key: 'soilMoisturePercent', label: 'Humidité du sol', unit: '%' },
  { key: 'temperatureC', label: 'Température', unit: '°' },
  { key: 'luminosity', label: 'Luminosité (DLI)', unit: ' mol/m²/j' },
];
const XIAOMI_METRICS: MetricSpec[] = [
  { key: 'temperatureC', label: 'Température', unit: '°' },
  { key: 'humidityPercent', label: 'Humidité', unit: '%' },
];

// Real GATT notify on the Parrot Pot (~1/s, confirmed by docs/PARROT_OFFICIAL_BLE_SPEC.md and the
// decompiled official app's startLive()), best-effort on the Xiaomi (firmware-controlled rate, no
// equivalent "measure period" characteristic — see
// docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md). Single shared GATT connection
// project-wide: only one live session at a time, hence the `status` query below.
export function LiveModeSection({ deviceId, kind }: { deviceId: string; kind: DeviceKind }) {
  const queryClient = useQueryClient();
  const { data: status } = useQuery(trpc.liveSession.status.queryOptions(undefined, { refetchInterval: 5000 }));
  const [isLive, setIsLive] = useState(false);
  const [remainingMs, setRemainingMs] = useState(LIVE_SESSION_MAX_DURATION_MS);
  const startedAtRef = useRef(0);
  const [buffers, setBuffers] = useState<Record<string, HistoryPoint[]>>({});

  const metrics = kind === 'PARROT_POT' ? PARROT_METRICS : XIAOMI_METRICS;
  const activeElsewhere = status != null && status.deviceId !== deviceId;

  function endSession() {
    setIsLive(false);
    void queryClient.invalidateQueries({ queryKey: trpc.liveSession.status.queryKey() });
  }

  const startMutation = useMutation(
    trpc.liveSession.start.mutationOptions({
      onSuccess: () => {
        setBuffers({});
        startedAtRef.current = Date.now();
        setRemainingMs(LIVE_SESSION_MAX_DURATION_MS);
        setIsLive(true);
      },
      onError: (error) => {
        toast.error('Mode live indisponible', { description: error.message });
      },
    }),
  );

  const stopMutation = useMutation(trpc.liveSession.stop.mutationOptions({ onSuccess: endSession }));

  useSubscription(
    trpc.liveSession.onSample.subscriptionOptions(
      { deviceId },
      {
        enabled: isLive,
        onData(event) {
          if (event.type === 'ended') {
            if (event.reason === 'error') {
              toast.error('Session live interrompue', { description: event.detail });
            }
            endSession();
            return;
          }
          setBuffers((prev) => {
            const next = { ...prev };
            for (const metric of metrics) {
              const value = event.reading[metric.key];
              if (value == null) continue;
              const points = next[metric.key] ?? [];
              next[metric.key] = [...points, { timestamp: event.reading.timestamp, value }].slice(-MAX_BUFFER_SIZE);
            }
            return next;
          });
        },
        onError: () => {
          endSession();
        },
      },
    ),
  );

  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => {
      setRemainingMs(Math.max(0, LIVE_SESSION_MAX_DURATION_MS - (Date.now() - startedAtRef.current)));
    }, 1000);
    return () => clearInterval(interval);
  }, [isLive]);

  // Leaving the page (route change/unmount) stops the session immediately instead of leaving it
  // running until the 5min cap with nobody watching it.
  useEffect(() => {
    return () => {
      stopMutation.mutate({ deviceId });
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run this cleanup if deviceId itself changes, not on every stopMutation identity change
  }, [deviceId]);

  return (
    <div className="my-7 rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-foreground">Mode live</div>
          <div className="text-sm text-muted-foreground">
            {isLive
              ? `Se coupe automatiquement dans ${Math.ceil(remainingMs / 1000)}s`
              : activeElsewhere
                ? `Session déjà active sur un autre appareil`
                : 'Graph mis à jour en direct (coupure automatique après 5 min).'}
          </div>
        </div>
        {isLive ? (
          <Button variant="outline" size="sm" onClick={() => stopMutation.mutate({ deviceId })} disabled={stopMutation.isPending}>
            Arrêter
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={activeElsewhere || startMutation.isPending}
            onClick={() => startMutation.mutate({ deviceId })}
          >
            Démarrer
          </Button>
        )}
      </div>

      {isLive && (
        <div className="mt-4 flex flex-col gap-6">
          {metrics.map((metric) => (
            <div key={metric.key}>
              <div className="mb-1 text-xs font-medium text-muted-foreground">{metric.label}</div>
              <HistoryChart data={buffers[metric.key] ?? []} label={metric.label} unit={metric.unit} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Insert it into the device detail page**

In `frontend/src/routes/_authenticated/devices.$deviceId.tsx`:

Add the import next to the other component imports (keep alphabetical, matching the existing
style):

```typescript
import { HistoryChart, type HistoryReferenceLine } from '@/components/history-chart';
import { LiveModeSection } from '@/components/live-mode-section';
import { SensorGauge } from '@/components/sensor-gauge';
```

Insert `<LiveModeSection deviceId={deviceId} kind={device.kind} />` right after the
`{canWater && <AutoWateringSection ... />}` line (available for both device kinds, unlike
`AutoWateringSection` which is Parrot-Pot-only):

```tsx
      {canWater && <AutoWateringSection deviceId={deviceId} hasSpeciesAssigned={device.plantProfile != null} />}

      <LiveModeSection deviceId={deviceId} kind={device.kind} />

      {canWater && (
```

- [ ] **Step 3: Typecheck and lint**

```bash
cd frontend && pnpm exec tsc -b
cd .. && pnpm -w lint:fix && pnpm -w lint
```

Expected: clean.

- [ ] **Step 4: Browser verification (required — this is a UI change)**

Boot the full stack with the mock provider:

```bash
cd backend
BLE_PROVIDER=mock pnpm dev &
cd ../frontend
pnpm dev &
```

Open the frontend (default `http://localhost:5173`), log in, open any device's detail page, and:

1. Confirm the "Mode live" card is visible with a "Démarrer" button.
2. Click it — confirm the card switches to showing 2 or 3 mini-graphs (matching device kind) and a
   countdown, and that the graphs visibly grow a new point roughly every second.
3. Click "Arrêter" — confirm the graphs disappear and the button reverts to "Démarrer".
4. Start it again, then navigate back to the dashboard (don't click "Arrêter") — open the same
   device again and confirm the button shows "Démarrer" again (proves the unmount cleanup stopped
   it, not left it running).
5. Open a second device's detail page in another tab while a session is active on the first —
   confirm its "Mode live" button is disabled with the "Session déjà active..." message.

Stop both dev servers when done (`kill %1 %2` or close the terminals).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/live-mode-section.tsx frontend/src/routes/_authenticated/devices.\$deviceId.tsx
git commit -m "Add the live mode section to the device detail page"
```

---

## Task 9: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a project-status entry**

Following the exact style of the existing batch entries (see the "MQTT + Health Engine settings
moved..." or the "First real production incident" entries for the format), add a new bullet in the
"Project status (by batch)" section, right before `**Next batch**: Batch 10 ...`, summarizing:
what live mode does, the single-shared-connection constraint and how it's bounded (5min cutoff,
single-session guard), the `Reading.source` tagging and which 4 read sites now filter it, the 3
providers' scope (mock + node-ble real, noble-bridge stubbed), and that node-ble's implementation
is unverified against real hardware (matching the "not yet validated" phrasing used elsewhere in
this file for the same kind of gap). Link to
`docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md` for the full design rationale
instead of duplicating it.

Also update the `tRPC` bullet in the "Backend — technical detail" section (the one listing
`router.ts`'s combined routers) to mention the new `liveSession` router, same as how `mqtt`/
`schedule`/`plantDr` are already listed there.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document the live sensor mode feature in CLAUDE.md"
```

---

## Task 10: End-to-end smoke test

**Files:** none (verification only, no code changes)

- [ ] **Step 1: Full-stack manual walkthrough**

With both dev servers running (`BLE_PROVIDER=mock` backend + frontend, as in Task 8 Step 4):

1. Start a live session on `MOCK-POT-NORMAL`'s detail page, let it run ~10s, stop it.
2. Check the 24h history chart on the same page (switch to the "Détails techniques" section) —
   confirm it looks the same as before the live session (no dense cluster of ~10 extra points).
3. Query the device's health status (`health.deviceHealth` — visible as the status badge near the
   top of the page) — confirm it's unaffected (no dip/spike attributable to the live session).
4. Directly inspect the DB to confirm both row types exist:
   ```bash
   sqlite3 backend/prisma/dev.db "SELECT source, COUNT(*) FROM Reading WHERE deviceId='MOCK-POT-NORMAL' GROUP BY source;"
   ```
   Expected: both a `POLL` row count and a `LIVE` row count (~10, matching the session length),
   confirming persistence happened and is correctly tagged.
5. Start a session, then immediately try to water the same device from the confirmation dialog —
   confirm the request either succeeds after the live session's queue turn or the UI doesn't hang
   indefinitely (it's expected to wait, per the accepted single-connection tradeoff — just confirm
   it's not a silent, unbounded hang from the user's perspective; a loading state on the "Arroser"
   button is fine).

- [ ] **Step 2: Clean up scratch files**

```bash
rm -f /tmp/verify-mock-live.ts /tmp/verify-noble-bridge-stub.ts /tmp/verify-live-manager.ts \
  /tmp/verify-live-timeout.ts /tmp/verify-live-subscription.ts /tmp/live-mode-verify.db \
  /tmp/live-mode-verify.log /tmp/live-cookies.txt
```

- [ ] **Step 3: Final full-repo check**

```bash
cd backend && pnpm exec tsc --noEmit -p tsconfig.json && cd ..
cd frontend && pnpm exec tsc -b && cd ..
pnpm -w lint
```

Expected: all clean. This is the last task — if everything above passes, the feature is complete
per the approved spec.
