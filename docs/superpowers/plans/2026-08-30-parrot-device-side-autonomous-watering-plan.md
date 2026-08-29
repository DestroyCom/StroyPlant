# Device-side autonomous watering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push species-derived thresholds (`f903`/`f904`/`f905`) and an algorithm-enable flag
(`f908`) to a Parrot Pot whenever it becomes eligible (species assigned + schedule active + the
species has Parrot-sourced data), so the pot decides and waters itself autonomously — matching the
official Flower Power app's real architecture. The backend scheduler (Batch 5) becomes a degraded,
huge-delta, long-cooldown safety net for these devices instead of the primary decision-maker.

**Architecture:** A new pure encoding module (`backend/src/ble/parrot/wateringConfig.ts`) mirrors
the existing Plant Dr pattern (`ble/parrot/plantDr.ts`) — providers stay "dumb", writing exactly
the values they're given. `DeviceProvider` gains `readWateringConfig`/`writeWateringConfig`,
implemented in `mock` and `node-ble` (not `noble-bridge` — Mac dev tool, out of scope, same cut
already made for Plant Dr). A new orchestration module (`backend/src/wateringConfigPush.ts`) is
the only place that decides eligibility and calls the provider; it's invoked automatically from
`health.assignPlantProfile` and `schedule.upsert` (only when eligibility actually changes) and
manually from a new `wateringConfig.push` tRPC mutation. A new `Device.autonomousWateringActive`
boolean flag — set only after a confirmed-successful push — is what `scheduler.ts`'s
`evaluateDevice` reads to switch into the degraded safety-net behavior; it never does a live BLE
read on a scheduler tick.

**Tech Stack:** TypeScript, Prisma/SQLite, Fastify/tRPC, Node's built-in `node:test` (pure
functions only — see Global Constraints), React/shadcn.

**Spec:** `docs/superpowers/specs/2026-08-30-parrot-device-side-autonomous-watering-design.md`

## Global Constraints

- **Scope of BLE fields written**: only `f903` (`vwcIrr`), `f904` (`vwcCmd`), `f905` (`nIrr`), and
  `f908` (`pumpDutyCycle` in code, actually the algorithm-enable flag). Every other `f900`-service
  field (`f901`, `f902`, `f90a`, `f90b`, `f90d`, `f90e`-`f912` except `f908`) is never written by
  this plan — insufficient evidence, per the spec's Scope table. Do not add writes for them.
- **Testing convention** (matches this project's established precedent — see
  `docs/superpowers/plans/2026-08-11-inference-engine-phase-b-shadow-mode-plan.md`'s identical
  constraint): `backend/src/ble/parrot/wateringConfig.ts` is pure (no Prisma, no I/O) and gets real
  `node:test` unit tests; the `pnpm test` glob is widened to include it. Every Prisma/BLE-touching
  orchestration this plan adds or modifies (`wateringConfigPush.ts`, the provider implementations,
  the tRPC router, `scheduler.ts`, `health.ts`, `schedule.ts`) is verified manually against a
  scratch copy of `dev.db` / the mock provider, exactly like every other impure feature in this
  project's history — do not attempt to build new Prisma-backed test infrastructure.
- **Never write "enable" with a half-applied config**: when enabling, `f908` is always written
  last, after `f903`/`f904`/`f905` succeed. When disabling, only `f908=0` is written.
- **`autonomousWateringActive` is only set `true` after a confirmed-successful write** — never
  optimistically before confirmation, matching every other BLE write path in this codebase (spec
  section 7.1, never silently swallow a BLE error).
- Test command (pure functions): `cd backend && pnpm test`. Typecheck:
  `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`. Frontend typecheck:
  `cd frontend && pnpm exec tsc -b` (pre-existing failure unrelated to this plan is possible — see
  the "Inference engine — Phase B" entry in `CLAUDE.md`'s Project status if it fails on
  `backend/src/inference/engine.ts`; that is not this plan's concern to fix). Lint (repo root):
  `pnpm lint`. Migration command: `cd backend && pnpm prisma:migrate --name <name>`.

---

### Task 1: `Device.autonomousWateringActive`/`autonomousWateringUpdatedAt`, `SyncSource.CONFIG_PUSH`

**Files:**

- Modify: `backend/prisma/schema.prisma`
- Create: migration via `pnpm prisma:migrate` (generates `backend/prisma/migrations/<timestamp>_add_autonomous_watering/migration.sql`)

**Interfaces:**

- Produces: `Device.autonomousWateringActive: boolean` (default `false`),
  `Device.autonomousWateringUpdatedAt: Date | null`, and `SyncSource` enum value `'CONFIG_PUSH'` —
  consumed by every later task.

- [ ] **Step 1: Add the fields to `schema.prisma`**

Open `backend/prisma/schema.prisma`. Find the `Device` model (starts at line 25) and add the two
new fields right after `environment`:

```prisma
model Device {
  id          String       @id // MAC address, uppercase colon-separated — stable across providers
  kind        DeviceKind
  name        String?
  lastSeenAt  DateTime?
  location    String? // free-text placement, e.g. "Salon", "Balcon" — user-entered, not validated
  environment Environment?

  // Device-side autonomous watering (docs/superpowers/specs/2026-08-30-parrot-device-side-
  // autonomous-watering-design.md) — true only after a confirmed-successful push of f903/f904/
  // f905/f908 to the pot's own algorithm. Read by health/scheduler.ts to switch into a degraded,
  // huge-delta, long-cooldown safety net instead of the normal primary trigger condition. Never
  // set optimistically ahead of a confirmed write.
  autonomousWateringActive    Boolean   @default(false)
  autonomousWateringUpdatedAt DateTime?

  // Optional assignment (Batch 4, Health Engine) — never blocking, same logic as the Plant Dr
  // calibration (section 7.11): a device works perfectly fine with no profile assigned.
  plantProfileId Int?
  plantProfile   PlantProfile? @relation(fields: [plantProfileId], references: [id])

  readings          Reading[]
  wateringEvents    WateringEvent[]
  syncEvents        SyncEvent[]
  schedule          Schedule?
  shadowDivergences ShadowDivergence[]
}
```

Then find the `SyncSource` enum (around line 433) and add the new value:

```prisma
enum SyncSource {
  POLL // scanner's own throttled polling loop (ble/scanner.ts's pollDeviceNow)
  MANUAL // devices.sync / devices.forceSyncAll (user-triggered)
  CONFIG_PUSH // device-side autonomous watering config push failures (wateringConfigPush.ts)
}
```

- [ ] **Step 2: Run the migration**

Run: `cd backend && pnpm prisma:migrate --name add_autonomous_watering`
Expected: prompts complete non-interactively (the `--name` flag supplies the name), a new folder
appears under `backend/prisma/migrations/` containing SQL that adds the two `Device` columns and
extends the `SyncSource` check/enum, and the command ends with "Your database is now in sync with
your schema." `@prisma/client` is regenerated automatically.

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean (no code references the new fields yet, so this just confirms the generated
client compiles).

- [ ] **Step 4: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "db: add Device.autonomousWateringActive and SyncSource.CONFIG_PUSH"
```

---

### Task 2: Pure module `backend/src/ble/parrot/wateringConfig.ts`, with real tests

**Files:**

- Create: `backend/src/ble/parrot/wateringConfig.ts`
- Create: `backend/src/ble/parrot/wateringConfig.test.ts`
- Modify: `backend/package.json` (widen the `test` script's glob)

**Interfaces:**

- Produces: `WateringConfigEnableValues` (`{ vwcIrrRaw: number; vwcCmdRaw: number; nIrr: number }`),
  `WateringConfigWrite` (`{ mode: 'enable'; values: WateringConfigEnableValues } | { mode:
  'disable' }`), `WateringConfigRaw` (`{ vwcIrrRaw: number | null; vwcCmdRaw: number | null; nIrr:
  number | null; algorithmEnabled: boolean | null }`), and
  `buildWateringConfigEnableValues(vwcIrrPercent: number, vwcCmdPercent: number, nIrr: number):
  WateringConfigEnableValues`. Consumed by Task 3 (provider interface + mock), Task 4 (node-ble),
  and Task 5 (`wateringConfigPush.ts`).

- [ ] **Step 1: Write the failing tests**

Create `backend/src/ble/parrot/wateringConfig.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWateringConfigEnableValues } from './wateringConfig.js';

test('buildWateringConfigEnableValues encodes percentages as ×10 raw integers', () => {
  const values = buildWateringConfigEnableValues(32, 38, 48);
  assert.deepEqual(values, { vwcIrrRaw: 320, vwcCmdRaw: 380, nIrr: 48 });
});

test('buildWateringConfigEnableValues rounds fractional percentages to the nearest ×10 integer', () => {
  const values = buildWateringConfigEnableValues(32.04, 37.96, 0);
  assert.deepEqual(values, { vwcIrrRaw: 320, vwcCmdRaw: 380, nIrr: 0 });
});

test('buildWateringConfigEnableValues passes nIrr through unchanged (already raw 15-minute units)', () => {
  const values = buildWateringConfigEnableValues(30, 40, 672);
  assert.equal(values.nIrr, 672);
});
```

- [ ] **Step 2: Widen the test glob so this file is picked up**

Open `backend/package.json`, find the `"test"` script, and change it from:

```json
    "test": "tsx --test 'src/inference/**/*.test.ts' 'src/health/**/*.test.ts'"
```

to:

```json
    "test": "tsx --test 'src/inference/**/*.test.ts' 'src/health/**/*.test.ts' 'src/ble/**/*.test.ts'"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && pnpm test`
Expected: FAIL — `wateringConfig.ts` does not exist yet, so the import throws
`Cannot find module './wateringConfig.js'`.

- [ ] **Step 4: Implement `wateringConfig.ts`**

Create `backend/src/ble/parrot/wateringConfig.ts`:

```typescript
// Device-side autonomous watering config (f900 service), Batch "device-side autonomous
// watering". See docs/superpowers/specs/2026-08-30-parrot-device-side-autonomous-watering-
// design.md. Unlike Plant Dr's fd8x block, no checksum/commit field is involved here — each
// characteristic in f900 is independently writable, confirmed by the sniffing captures showing
// no composite validation value anywhere in that service.

// Values as they must be written to the device — providers stay "dumb", they just encode+write
// these in the required order (see writeWateringConfig in each provider), f908 written last.
export interface WateringConfigEnableValues {
  vwcIrrRaw: number; // already ×10, e.g. 32.0% -> 320 (f903, trigger threshold)
  vwcCmdRaw: number; // already ×10 (f904, target/consigne)
  nIrr: number; // raw 15-minute units, written as-is (f905, anti-repeat delay) — this is the same
  // value stored in PlantProfile.irrigateCalibrationSampleCount, misnamed at Parrot-plant-database
  // import time: real sniffing (2026-08-29) showed it's a delay preset (e.g. 384 = 4 days), not a
  // calibration sample count.
}

export type WateringConfigWrite = { mode: 'enable'; values: WateringConfigEnableValues } | { mode: 'disable' };

// Live-read shape (f903/f904/f905/f908), returned by readWateringConfig. `algorithmEnabled` is
// f908 decoded as a boolean (1 -> true, 0 -> false).
export interface WateringConfigRaw {
  vwcIrrRaw: number | null;
  vwcCmdRaw: number | null;
  nIrr: number | null;
  algorithmEnabled: boolean | null;
}

export function buildWateringConfigEnableValues(vwcIrrPercent: number, vwcCmdPercent: number, nIrr: number): WateringConfigEnableValues {
  return {
    vwcIrrRaw: Math.round(vwcIrrPercent * 10),
    vwcCmdRaw: Math.round(vwcCmdPercent * 10),
    nIrr,
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && pnpm test`
Expected: PASS — all 3 new tests green, plus every pre-existing test in `src/health/` and
`src/inference/` still green (the glob widening only adds a third pattern, it doesn't remove the
other two).

- [ ] **Step 6: Typecheck and lint**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json` — expected clean.
Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint` — expected clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/ble/parrot/wateringConfig.ts backend/src/ble/parrot/wateringConfig.test.ts backend/package.json
git commit -m "ble: add wateringConfig.ts encode helper for device-side autonomous watering"
```

---

### Task 3: `DeviceProvider` interface + mock provider implementation

**Files:**

- Modify: `backend/src/providers/types.ts`
- Modify: `backend/src/providers/mock/index.ts`

**Interfaces:**

- Consumes: `WateringConfigRaw`/`WateringConfigWrite` (Task 2).
- Produces: `DeviceProvider.readWateringConfig(deviceId: string): Promise<WateringConfigRaw>` and
  `DeviceProvider.writeWateringConfig(deviceId: string, write: WateringConfigWrite):
  Promise<void>` — consumed by Task 4 (node-ble) and Task 5 (`wateringConfigPush.ts`).

- [ ] **Step 1: Add the two methods to `DeviceProvider`**

Open `backend/src/providers/types.ts`. Add the import at the top, alongside the existing
`plantDr.js` import:

```typescript
import type { PlantDrCalibration, PlantDrWriteValues } from '../ble/parrot/plantDr.js';
import type { WateringConfigRaw, WateringConfigWrite } from '../ble/parrot/wateringConfig.js';
```

Then add the two methods at the end of the `DeviceProvider` interface, right after
`writePlantDrCalibration`:

```typescript
  // Plant Dr device-side calibration (Batch 6, docs/STROYPLANT_SPEC.md section 7.11), Parrot Pot
  // only. Providers are "dumb" here — the checksum/encoding logic lives once in
  // ble/parrot/plantDr.ts, callers pass already-computed write values.
  readPlantDrCalibration(deviceId: string): Promise<PlantDrCalibration>;
  writePlantDrCalibration(deviceId: string, values: PlantDrWriteValues): Promise<void>;

  // Device-side autonomous watering (docs/superpowers/specs/2026-08-30-parrot-device-side-
  // autonomous-watering-design.md), Parrot Pot only. Same "dumb provider" pattern as Plant Dr
  // above — backend/src/wateringConfigPush.ts decides eligibility and computes the values,
  // providers just read/write the f900 characteristics.
  readWateringConfig(deviceId: string): Promise<WateringConfigRaw>;
  writeWateringConfig(deviceId: string, write: WateringConfigWrite): Promise<void>;
}
```

(Remove the old closing `}` that followed `writePlantDrCalibration` — the new methods go inside
the same interface body, so there is still exactly one closing brace at the end.)

- [ ] **Step 2: Typecheck to confirm the mock provider now fails to satisfy the interface**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: FAIL — `backend/src/providers/mock/index.ts`'s returned object no longer satisfies
`DeviceProvider` (missing `readWateringConfig`/`writeWateringConfig`). This confirms the interface
change is wired correctly before implementing the mock.

- [ ] **Step 3: Add mock state and implement the two methods**

Open `backend/src/providers/mock/index.ts`. Add the import at the top:

```typescript
import type { PlantDrCalibration, PlantDrWriteValues } from '../../ble/parrot/plantDr.js';
import type { WateringConfigRaw, WateringConfigWrite } from '../../ble/parrot/wateringConfig.js';
```

Add a `wateringConfig` field to `MockPotState` (right after `plantDr`):

```typescript
interface MockPotState {
  id: string;
  name: string;
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent: number;
  soilConductivityRaw: number;
  declinePerMinute: number;
  lastUpdate: number;
  plantDr: PlantDrCalibration;
  wateringConfig: WateringConfigRaw;
}
```

Add a factory function right after `defaultPlantDrCalibration`:

```typescript
// "Never configured" starting state — unlike Plant Dr, no real factory default has been captured
// for f903/f904/f905/f908 (this project has never been the first writer of these fields on real
// hardware), so null/false is the honest starting point for a pot nobody has pushed a config to
// yet.
function defaultWateringConfig(): WateringConfigRaw {
  return { vwcIrrRaw: null, vwcCmdRaw: null, nIrr: null, algorithmEnabled: false };
}
```

Add `wateringConfig: defaultWateringConfig(),` to both pot objects in `createInitialPots()` (right
after each `plantDr: defaultPlantDrCalibration(),` line — there are two, `MOCK-POT-NORMAL` and
`MOCK-POT-DECLINE`).

Add the two methods right after the existing `writePlantDrCalibration` method (find it by
searching for `async writePlantDrCalibration`, then add after its closing `},`):

```typescript
    async readWateringConfig(deviceId: string): Promise<WateringConfigRaw> {
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      return pot.wateringConfig;
    },

    async writeWateringConfig(deviceId: string, write: WateringConfigWrite): Promise<void> {
      const pot = pots.get(deviceId);
      if (!pot) throw new Error(`Mock device ${deviceId} inconnu`);
      if (write.mode === 'enable') {
        pot.wateringConfig = {
          vwcIrrRaw: write.values.vwcIrrRaw,
          vwcCmdRaw: write.values.vwcCmdRaw,
          nIrr: write.values.nIrr,
          algorithmEnabled: true,
        };
      } else {
        pot.wateringConfig = { ...pot.wateringConfig, algorithmEnabled: false };
      }
      log({
        direction: 'WRITE',
        label: 'Watering config written (mock)',
        deviceId,
        result: 'OK',
        detail: JSON.stringify(pot.wateringConfig),
      });
    },
```

- [ ] **Step 4: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 5: Manually verify against the mock provider**

From the repo root, run this one-off script:

```bash
cd backend
pnpm exec tsx <<'EOF'
import { createMockProvider } from './src/providers/mock/index.js';

const provider = createMockProvider();

console.log('Before:', await provider.readWateringConfig('MOCK-POT-NORMAL'));

await provider.writeWateringConfig('MOCK-POT-NORMAL', {
  mode: 'enable',
  values: { vwcIrrRaw: 320, vwcCmdRaw: 380, nIrr: 48 },
});
console.log('After enable:', await provider.readWateringConfig('MOCK-POT-NORMAL'));

await provider.writeWateringConfig('MOCK-POT-NORMAL', { mode: 'disable' });
console.log('After disable:', await provider.readWateringConfig('MOCK-POT-NORMAL'));
EOF
```

Expected output: `Before:` shows `{ vwcIrrRaw: null, vwcCmdRaw: null, nIrr: null, algorithmEnabled:
false }`; `After enable:` shows `{ vwcIrrRaw: 320, vwcCmdRaw: 380, nIrr: 48, algorithmEnabled: true
}`; `After disable:` shows the same 3 values unchanged but `algorithmEnabled: false`.

- [ ] **Step 6: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/providers/types.ts backend/src/providers/mock/index.ts
git commit -m "providers: add readWateringConfig/writeWateringConfig to DeviceProvider + mock"
```

---

### Task 4: `node-ble` provider implementation

**Files:**

- Modify: `backend/src/providers/node-ble/index.ts`

**Interfaces:**

- Consumes: `WateringConfigRaw`/`WateringConfigWrite` (Task 2); `WATERING_SERVICE_UUID`,
  `UUIDS.watering.vwcIrr`/`vwcCmd`/`nIrr`/`pumpDutyCycle` (already exported from
  `ble/parrot/uuids.ts`, unchanged by this plan); `connectDevice`, `withGattRetry`, `withTimeout`,
  `trackedCharacteristic`, `releaseDbusListeners`, `isGattError133`, `restartAdapter`,
  `CONNECT_TIMEOUT_MS`, `log` (all already defined/imported in this file, used identically by the
  existing `readPlantDrCalibration`/`writePlantDrCalibration` methods right above where these two
  new methods go).
- Produces: `readWateringConfig`/`writeWateringConfig` on the `node-ble` provider — satisfies the
  `DeviceProvider` interface from Task 3 for the production provider.

- [ ] **Step 1: Add the import**

Open `backend/src/providers/node-ble/index.ts`. Add to the existing import from `wateringConfig.js`
(new import line, placed alphabetically with the other `../../ble/parrot/*` imports near the top):

```typescript
import type { WateringConfigRaw, WateringConfigWrite } from '../../ble/parrot/wateringConfig.js';
```

- [ ] **Step 2: Implement the two methods**

Find `writePlantDrCalibration` (search for `async writePlantDrCalibration(deviceId: string,
values: PlantDrWriteValues): Promise<void> {`) and add the two new methods right after its closing
`},`:

```typescript
    async readWateringConfig(deviceId: string): Promise<WateringConfigRaw> {
      return withGattRetry({
        label: 'readWateringConfig',
        deviceId,
        isGattError133,
        restartAdapter,
        attempt: async () => {
          const device = await connectDevice(deviceId);
          const characteristics: GattCharacteristic[] = [];
          try {
            const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
            const wateringService = await gatt.getPrimaryService(WATERING_SERVICE_UUID);
            const readU16Value = async (uuid: string) =>
              (await (await trackedCharacteristic(wateringService, uuid, characteristics)).readValue()).readUInt16LE(0);
            const readU8Value = async (uuid: string) =>
              (await (await trackedCharacteristic(wateringService, uuid, characteristics)).readValue()).readUInt8(0);

            const vwcIrrRaw = await readU16Value(UUIDS.watering.vwcIrr);
            const vwcCmdRaw = await readU16Value(UUIDS.watering.vwcCmd);
            const nIrr = await readU16Value(UUIDS.watering.nIrr);
            const algorithmEnabledRaw = await readU8Value(UUIDS.watering.pumpDutyCycle);

            const config: WateringConfigRaw = { vwcIrrRaw, vwcCmdRaw, nIrr, algorithmEnabled: algorithmEnabledRaw === 1 };
            log({ direction: 'READ', label: 'Watering config read', deviceId, result: 'OK', detail: JSON.stringify(config) });
            return config;
          } finally {
            for (const characteristic of characteristics) releaseDbusListeners(characteristic);
            await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
            releaseDbusListeners(device);
          }
        },
      });
    },

    async writeWateringConfig(deviceId: string, write: WateringConfigWrite): Promise<void> {
      await withGattRetry({
        label: 'writeWateringConfig',
        deviceId,
        isGattError133,
        restartAdapter,
        attempt: async () => {
          const device = await connectDevice(deviceId);
          const characteristics: GattCharacteristic[] = [];
          try {
            const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');
            const wateringService = await gatt.getPrimaryService(WATERING_SERVICE_UUID);

            const writeU16 = async (uuid: string, value: number, label: string) => {
              const characteristic = await trackedCharacteristic(wateringService, uuid, characteristics);
              const payload = Buffer.alloc(2);
              payload.writeUInt16LE(value & 0xffff, 0);
              await characteristic.writeValueWithResponse(payload);
              log({ direction: 'WRITE', label, uuid, deviceId, payloadHex: payload.toString('hex'), result: 'OK' });
            };
            const writeU8 = async (uuid: string, value: number, label: string) => {
              const characteristic = await trackedCharacteristic(wateringService, uuid, characteristics);
              const payload = Buffer.from([value & 0xff]);
              await characteristic.writeValueWithResponse(payload);
              log({ direction: 'WRITE', label, uuid, deviceId, payloadHex: payload.toString('hex'), result: 'OK' });
            };

            if (write.mode === 'enable') {
              // f908 (algorithm enable) is written last — a failure partway through never leaves
              // the algorithm active with a half-applied config.
              await writeU16(UUIDS.watering.vwcIrr, write.values.vwcIrrRaw, 'Watering config VWC_IRR');
              await writeU16(UUIDS.watering.vwcCmd, write.values.vwcCmdRaw, 'Watering config VWC_CMD');
              await writeU16(UUIDS.watering.nIrr, write.values.nIrr, 'Watering config N_IRR');
              await writeU8(UUIDS.watering.pumpDutyCycle, 1, 'Watering config algorithm enable');
            } else {
              await writeU8(UUIDS.watering.pumpDutyCycle, 0, 'Watering config algorithm disable');
            }
          } finally {
            for (const characteristic of characteristics) releaseDbusListeners(characteristic);
            await withTimeout(device.disconnect(), CONNECT_TIMEOUT_MS, 'disconnect').catch(() => {});
            releaseDbusListeners(device);
          }
        },
      });
    },
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 4: Manual verification note**

This method cannot be exercised without real Parrot Pot hardware reachable over BlueZ, which this
development environment does not have. Do not attempt to run it here — it will be validated on
the production server as part of the real rollout described in the spec's "Rollout on real
hardware" section, after every other task in this plan is complete and reviewed. Confirming it
typechecks and structurally mirrors `readPlantDrCalibration`/`writePlantDrCalibration` (already
validated on real hardware in this project's history) is sufficient for this task.

- [ ] **Step 5: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/providers/node-ble/index.ts
git commit -m "providers(node-ble): implement readWateringConfig/writeWateringConfig"
```

---

### Task 5: Push session tracker, eligibility/push orchestration, and the `wateringConfig` tRPC router

**Files:**

- Create: `backend/src/wateringConfigPushSession.ts`
- Create: `backend/src/wateringConfigPush.ts`
- Create: `backend/src/api/trpc/routers/wateringConfig.ts`
- Modify: `backend/src/api/trpc/router.ts`

**Interfaces:**

- Consumes: `buildWateringConfigEnableValues`/`WateringConfigWrite` (Task 2);
  `DeviceProvider.readWateringConfig`/`writeWateringConfig` (Task 3); `resolveEffectiveSchedule`
  from `backend/src/health/scheduler.ts` (already exported, unchanged).
- Produces: `resolveWateringConfigEligibility(device, schedule, plantProfile):
  WateringConfigEligibility`, `runWateringConfigPush(ctx: {provider: DeviceProvider;
  connectionQueue: ConnectionQueue}, deviceId: string): Promise<void>`,
  `kickOffWateringConfigPush(ctx, deviceId: string): void` — all from
  `backend/src/wateringConfigPush.ts`, consumed by Task 6 (`health.ts`/`schedule.ts` wiring). The
  `wateringConfig` tRPC router (`getConfig`, `pushRunStatus`, `push`) is consumed by Task 8
  (frontend).

- [ ] **Step 1: Create the session tracker**

Create `backend/src/wateringConfigPushSession.ts`:

```typescript
// Tracks the in-flight/last-outcome state of a device-side autonomous watering config push per
// device, so the triggering mutation (health.assignPlantProfile, schedule.upsert, or the manual
// wateringConfig.push button) can return immediately instead of blocking on the full BLE
// read+write sequence — same reasoning and shape as plantDrCalibrationSession.ts (a config push is
// 3-4 sequential connectionQueue-serialized BLE writes, easily exceeding Cloudflare's ~100s origin
// timeout if awaited inline, see docs/superpowers/specs/2026-08-30-parrot-device-side-autonomous-
// watering-design.md).
export type WateringConfigPushState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: number }
  | { status: 'success'; enabled: boolean; finishedAt: number }
  | { status: 'error'; message: string; finishedAt: number };

const states = new Map<string, WateringConfigPushState>();

export function getWateringConfigPushState(deviceId: string): WateringConfigPushState {
  return states.get(deviceId) ?? { status: 'idle' };
}

export function isWateringConfigPushRunning(deviceId: string): boolean {
  return states.get(deviceId)?.status === 'running';
}

export function setWateringConfigPushState(deviceId: string, state: WateringConfigPushState): void {
  states.set(deviceId, state);
}
```

- [ ] **Step 2: Create the eligibility/push orchestration**

Create `backend/src/wateringConfigPush.ts`:

```typescript
// Device-side autonomous watering — the only file that decides eligibility and calls the
// provider's readWateringConfig/writeWateringConfig. See docs/superpowers/specs/2026-08-30-
// parrot-device-side-autonomous-watering-design.md.
import type { Device, PlantProfile, Schedule } from '@prisma/client';
import { buildWateringConfigEnableValues } from './ble/parrot/wateringConfig.js';
import type { ConnectionQueue } from './ble/connectionQueue.js';
import { prisma } from './db/client.js';
import { resolveEffectiveSchedule } from './health/scheduler.js';
import { log } from './logger.js';
import type { DeviceProvider } from './providers/types.js';
import { isWateringConfigPushRunning, setWateringConfigPushState } from './wateringConfigPushSession.js';

export type WateringConfigEligibility =
  | { eligible: false }
  | { eligible: true; vwcIrrPercent: number; vwcCmdPercent: number; nIrr: number };

// A device is a push candidate exactly when the backend scheduler already considers it a
// watering candidate (resolveEffectiveSchedule's active flag) AND its assigned species has
// Parrot-sourced threshold data — the ~3400 WatchFlower-only species have neither field, and stay
// silently ineligible (not an error, an expected common case). A discriminated union rather than
// optional fields, so a caller checking `eligibility.eligible` gets the 3 values narrowed as
// definitely present with no cast needed.
export function resolveWateringConfigEligibility(
  device: Pick<Device, 'plantProfileId'>,
  schedule: Schedule | null,
  plantProfile: Pick<PlantProfile, 'soilMoistureIrrigatePercent' | 'soilMoistureCommandPercent' | 'irrigateCalibrationSampleCount'> | null,
): WateringConfigEligibility {
  if (!resolveEffectiveSchedule(device, schedule).active || !plantProfile) return { eligible: false };

  const { soilMoistureIrrigatePercent, soilMoistureCommandPercent, irrigateCalibrationSampleCount } = plantProfile;
  if (soilMoistureIrrigatePercent == null || soilMoistureCommandPercent == null) return { eligible: false };

  return {
    eligible: true,
    vwcIrrPercent: soilMoistureIrrigatePercent,
    vwcCmdPercent: soilMoistureCommandPercent,
    nIrr: irrigateCalibrationSampleCount ?? 0,
  };
}

export interface WateringConfigPushDeps {
  provider: DeviceProvider;
  connectionQueue: ConnectionQueue;
}

// Self-contained: always re-fetches the device fresh from the DB rather than requiring callers to
// pass an already-loaded object with the right relations — this is shared by 3 call sites
// (assignPlantProfile, schedule.upsert, the manual wateringConfig.push mutation) which don't all
// have the same relations loaded already.
export async function runWateringConfigPush(deps: WateringConfigPushDeps, deviceId: string): Promise<void> {
  setWateringConfigPushState(deviceId, { status: 'running', startedAt: Date.now() });
  try {
    const device = await prisma.device.findUnique({ where: { id: deviceId }, include: { plantProfile: true, schedule: true } });
    if (!device) throw new Error('Device not found');
    if (device.kind !== 'PARROT_POT') throw new Error('Device-side autonomous watering is Parrot Pot only');

    const eligibility = resolveWateringConfigEligibility(device, device.schedule, device.plantProfile);

    if (eligibility.eligible) {
      const values = buildWateringConfigEnableValues(eligibility.vwcIrrPercent, eligibility.vwcCmdPercent, eligibility.nIrr);
      await deps.connectionQueue.run(() => deps.provider.writeWateringConfig(deviceId, { mode: 'enable', values }));
      await prisma.device.update({ where: { id: deviceId }, data: { autonomousWateringActive: true, autonomousWateringUpdatedAt: new Date() } });
      setWateringConfigPushState(deviceId, { status: 'success', enabled: true, finishedAt: Date.now() });
    } else {
      // Only bother writing "disable" if the device might currently be autonomous — avoids a
      // needless BLE write for a device that was never eligible in the first place.
      if (device.autonomousWateringActive) {
        await deps.connectionQueue.run(() => deps.provider.writeWateringConfig(deviceId, { mode: 'disable' }));
      }
      await prisma.device.update({ where: { id: deviceId }, data: { autonomousWateringActive: false, autonomousWateringUpdatedAt: new Date() } });
      setWateringConfigPushState(deviceId, { status: 'success', enabled: false, finishedAt: Date.now() });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log({ direction: 'WRITE', label: 'Watering config push failed', deviceId, result: 'ERROR', detail });
    await prisma.device.update({ where: { id: deviceId }, data: { autonomousWateringActive: false } }).catch(() => {});
    await prisma.syncEvent.create({ data: { deviceId, source: 'CONFIG_PUSH', errorDetail: detail } }).catch(() => {});
    setWateringConfigPushState(deviceId, { status: 'error', message: detail, finishedAt: Date.now() });
  }
}

// Fire-and-forget entry point for the two automatic call sites (assignPlantProfile,
// schedule.upsert) — silently skips if a push is already running for this device (a rare race
// between two rapid saves), never surfaces a CONFLICT to a mutation whose primary purpose isn't
// this push. The manual wateringConfig.push tRPC mutation calls runWateringConfigPush directly
// instead, after throwing its own CONFLICT synchronously (see Task 5's router).
export function kickOffWateringConfigPush(deps: WateringConfigPushDeps, deviceId: string): void {
  if (isWateringConfigPushRunning(deviceId)) return;
  void runWateringConfigPush(deps, deviceId);
}
```

- [ ] **Step 3: Create the tRPC router**

Create `backend/src/api/trpc/routers/wateringConfig.ts`:

```typescript
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { runWateringConfigPush } from '../../../wateringConfigPush.js';
import { getWateringConfigPushState, isWateringConfigPushRunning } from '../../../wateringConfigPushSession.js';
import { protectedProcedure, router } from '../trpc.js';

export const wateringConfigRouter = router({
  // Live read from the device, not from our DB — same "device is the source of truth" pattern as
  // plantDr.getCalibration.
  getConfig: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
    if (device.kind !== 'PARROT_POT') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Watering config is Parrot Pot only' });

    try {
      return await ctx.connectionQueue.run(() => ctx.provider.readWateringConfig(device.id));
    } catch (error) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: error instanceof Error ? error.message : String(error) });
    }
  }),

  // Polled by the frontend instead of blocking on the mutation's HTTP response — same shape as
  // plantDr.calibrationRunStatus.
  pushRunStatus: protectedProcedure.input(z.object({ deviceId: z.string() })).query(({ input }) => getWateringConfigPushState(input.deviceId)),

  // Manual "Repousser maintenant" button — unlike the automatic call sites
  // (health.assignPlantProfile, schedule.upsert), this one throws CONFLICT synchronously instead
  // of silently skipping, since the user just pressed a button and expects immediate feedback.
  push: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
    if (device.kind !== 'PARROT_POT') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Watering config is Parrot Pot only' });
    if (isWateringConfigPushRunning(input.deviceId)) throw new TRPCError({ code: 'CONFLICT', message: 'A config push is already running for this device' });

    void runWateringConfigPush({ provider: ctx.provider, connectionQueue: ctx.connectionQueue }, input.deviceId);
    return { status: 'started' as const };
  }),
});
```

- [ ] **Step 4: Mount the router**

Open `backend/src/api/trpc/router.ts`. Add the import (alphabetically, between `readingsRouter`
and `scheduleRouter`... actually `wateringConfig` sorts after `schedule` — add it last,
alphabetically after `scheduleRouter`):

```typescript
import { devicesRouter } from './routers/devices.js';
import { discoverySessionRouter } from './routers/discoverySession.js';
import { healthRouter } from './routers/health.js';
import { historyRouter } from './routers/history.js';
import { liveSessionRouter } from './routers/liveSession.js';
import { mqttRouter } from './routers/mqtt.js';
import { plantDrRouter } from './routers/plantDr.js';
import { pollSettingsRouter } from './routers/pollSettings.js';
import { readingsRouter } from './routers/readings.js';
import { scheduleRouter } from './routers/schedule.js';
import { wateringConfigRouter } from './routers/wateringConfig.js';
import { router } from './trpc.js';

export const appRouter = router({
  devices: devicesRouter,
  discoverySession: discoverySessionRouter,
  health: healthRouter,
  history: historyRouter,
  liveSession: liveSessionRouter,
  mqtt: mqttRouter,
  plantDr: plantDrRouter,
  pollSettings: pollSettingsRouter,
  readings: readingsRouter,
  schedule: scheduleRouter,
  wateringConfig: wateringConfigRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 5: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 6: Manually verify end-to-end against the mock provider**

This exercises Prisma + the tRPC router + the mock provider together — impure, verified manually
per the Global Constraints. From the repo root:

```bash
cp backend/dev.db /tmp/watering-config-scratch.db
cd backend
DATABASE_URL="file:/tmp/watering-config-scratch.db" pnpm exec prisma migrate deploy
```

Then run this one-off script (still with `DATABASE_URL` pointed at the scratch copy) against the
mock provider's `MOCK-POT-NORMAL`, first assigning it a species with real Parrot data so the push
actually has values to write (replace the `plantProfile.findFirst` filter with an id from your own
`dev.db` if `MOCK-POT-NORMAL` isn't present — check with `sqlite3
/tmp/watering-config-scratch.db "select id from Device where kind = 'PARROT_POT';"` first):

```bash
DATABASE_URL="file:/tmp/watering-config-scratch.db" pnpm exec tsx <<'EOF'
import { prisma } from './src/db/client.js';
import { createMockProvider } from './src/providers/mock/index.js';
import { ConnectionQueue } from './src/ble/connectionQueue.js';
import { runWateringConfigPush } from './src/wateringConfigPush.js';
import { getWateringConfigPushState } from './src/wateringConfigPushSession.js';

const deviceId = 'MOCK-POT-NORMAL';
const profile = await prisma.plantProfile.findFirst({
  where: { soilMoistureIrrigatePercent: { not: null }, soilMoistureCommandPercent: { not: null } },
});
if (!profile) throw new Error('No Parrot-sourced species found in this DB.');

await prisma.device.upsert({
  where: { id: deviceId },
  update: { plantProfileId: profile.id },
  create: { id: deviceId, kind: 'PARROT_POT', name: 'scratch test pot', plantProfileId: profile.id },
});

const provider = createMockProvider();
const connectionQueue = new ConnectionQueue();

console.log('Pushing (should enable)...');
await runWateringConfigPush({ provider, connectionQueue }, deviceId);
console.log('Push state:', getWateringConfigPushState(deviceId));
console.log('Device flag:', (await prisma.device.findUnique({ where: { id: deviceId } }))?.autonomousWateringActive);
console.log('Live config:', await provider.readWateringConfig(deviceId));

console.log('Unassigning species and pushing again (should disable)...');
await prisma.device.update({ where: { id: deviceId }, data: { plantProfileId: null } });
await runWateringConfigPush({ provider, connectionQueue }, deviceId);
console.log('Push state:', getWateringConfigPushState(deviceId));
console.log('Device flag:', (await prisma.device.findUnique({ where: { id: deviceId } }))?.autonomousWateringActive);
console.log('Live config:', await provider.readWateringConfig(deviceId));
EOF
```

Expected: first block ends with `Push state: { status: 'success', enabled: true, ... }`, `Device
flag: true`, and `Live config` showing non-null `vwcIrrRaw`/`vwcCmdRaw`/`nIrr` with
`algorithmEnabled: true`. Second block ends with `enabled: false`, `Device flag: false`, and
`Live config` showing `algorithmEnabled: false` (the numeric fields stay at their last-pushed
values, per the design's "leave f903/f904/f905 untouched on disable" decision).

Clean up afterward: `rm /tmp/watering-config-scratch.db*`.

- [ ] **Step 7: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/wateringConfigPushSession.ts backend/src/wateringConfigPush.ts backend/src/api/trpc/routers/wateringConfig.ts backend/src/api/trpc/router.ts
git commit -m "backend: add wateringConfigPush orchestration and wateringConfig tRPC router"
```

---

### Task 6: Wire the automatic push into `assignPlantProfile` and `schedule.upsert`

**Files:**

- Modify: `backend/src/api/trpc/routers/health.ts`
- Modify: `backend/src/api/trpc/routers/schedule.ts`

**Interfaces:**

- Consumes: `kickOffWateringConfigPush` (Task 5); `resolveEffectiveSchedule` (already imported in
  `schedule.ts`, unchanged).

- [ ] **Step 1: Wire `health.ts`'s `assignPlantProfile`**

Open `backend/src/api/trpc/routers/health.ts`. Add the import:

```typescript
import { kickOffWateringConfigPush } from '../../../wateringConfigPush.js';
```

Change `assignPlantProfile` from:

```typescript
  assignPlantProfile: protectedProcedure
    .input(z.object({ deviceId: z.string(), plantProfileId: z.number().nullable() }))
    .mutation(async ({ input }) => {
      const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

      if (input.plantProfileId != null) {
        const profile = await prisma.plantProfile.findUnique({ where: { id: input.plantProfileId } });
        if (!profile) throw new TRPCError({ code: 'NOT_FOUND', message: 'Plant profile not found' });
      }

      const updated = await prisma.device.update({
        where: { id: device.id },
        data: { plantProfileId: input.plantProfileId },
        include: { plantProfile: true },
      });
      return { ...updated, lastSeenAt: serializeDate(updated.lastSeenAt) };
    }),
```

to:

```typescript
  assignPlantProfile: protectedProcedure
    .input(z.object({ deviceId: z.string(), plantProfileId: z.number().nullable() }))
    .mutation(async ({ ctx, input }) => {
      const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

      if (input.plantProfileId != null) {
        const profile = await prisma.plantProfile.findUnique({ where: { id: input.plantProfileId } });
        if (!profile) throw new TRPCError({ code: 'NOT_FOUND', message: 'Plant profile not found' });
      }

      const updated = await prisma.device.update({
        where: { id: device.id },
        data: { plantProfileId: input.plantProfileId },
        include: { plantProfile: true },
      });

      // Species assignment is already a deliberate, infrequent user action — always recompute
      // eligibility and push (enable or disable) in the background. runWateringConfigPush itself
      // no-ops for non-Parrot-Pot devices (see wateringConfigPush.ts).
      kickOffWateringConfigPush({ provider: ctx.provider, connectionQueue: ctx.connectionQueue }, device.id);

      return { ...updated, lastSeenAt: serializeDate(updated.lastSeenAt) };
    }),
```

- [ ] **Step 2: Wire `schedule.ts`'s `upsert`**

Open `backend/src/api/trpc/routers/schedule.ts`. Add the import:

```typescript
import { kickOffWateringConfigPush } from '../../../wateringConfigPush.js';
```

Change `upsert` from:

```typescript
  upsert: protectedProcedure
    .input(
      z.object({
        deviceId: z.string(),
        active: z.boolean(),
        allowedStartHour: z.number().int().min(0).max(23),
        allowedEndHour: z.number().int().min(0).max(23),
        cooldownHours: z.number().int().min(1).max(168),
      }),
    )
    .mutation(async ({ input }) => {
      const { deviceId, ...data } = input;
      const device = await prisma.device.findUnique({ where: { id: deviceId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

      const schedule = await prisma.schedule.upsert({
        where: { deviceId },
        update: data,
        create: { deviceId, ...data },
      });
      return { ...schedule, updatedAt: serializeDate(schedule.updatedAt) };
    }),
```

to:

```typescript
  upsert: protectedProcedure
    .input(
      z.object({
        deviceId: z.string(),
        active: z.boolean(),
        allowedStartHour: z.number().int().min(0).max(23),
        allowedEndHour: z.number().int().min(0).max(23),
        cooldownHours: z.number().int().min(1).max(168),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { deviceId, ...data } = input;
      const device = await prisma.device.findUnique({ where: { id: deviceId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

      const existingSchedule = await prisma.schedule.findUnique({ where: { deviceId } });
      const wasActive = resolveEffectiveSchedule(device, existingSchedule).active;

      const schedule = await prisma.schedule.upsert({
        where: { deviceId },
        update: data,
        create: { deviceId, ...data },
      });

      // Only push when eligibility actually changed — avoids a needless BLE write on every
      // unrelated save (e.g. adjusting cooldownHours while already active never re-pushes).
      const isActiveNow = resolveEffectiveSchedule(device, schedule).active;
      if (wasActive !== isActiveNow) {
        kickOffWateringConfigPush({ provider: ctx.provider, connectionQueue: ctx.connectionQueue }, deviceId);
      }

      return { ...schedule, updatedAt: serializeDate(schedule.updatedAt) };
    }),
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 4: Manually verify against a scratch copy of `dev.db`**

```bash
cp backend/dev.db /tmp/watering-config-wiring-scratch.db
cd backend
DATABASE_URL="file:/tmp/watering-config-wiring-scratch.db" pnpm exec prisma migrate deploy
```

This step needs a running backend (the mutations go through Fastify/tRPC, not just direct
function calls). First make sure `MOCK-POT-NORMAL` exists as a named `Device` row in the scratch
DB (it may already, from earlier manual testing sessions against this project's `dev.db` — this
upsert is a no-op if so):

```bash
DATABASE_URL="file:/tmp/watering-config-wiring-scratch.db" pnpm exec tsx <<'EOF'
import { prisma } from './src/db/client.js';
await prisma.device.upsert({
  where: { id: 'MOCK-POT-NORMAL' },
  update: {},
  create: { id: 'MOCK-POT-NORMAL', kind: 'PARROT_POT', name: 'Parrot pot mock1' },
});
EOF
```

Then start the backend against the scratch DB with the mock provider, on a port that won't
collide with any other locally running instance:

```bash
DATABASE_URL="file:/tmp/watering-config-wiring-scratch.db" BLE_PROVIDER=mock PORT=3050 pnpm dev
```

In a second terminal, find a Parrot-sourced species id and sign in (`$ADMIN_EMAIL`/
`$ADMIN_PASSWORD` from `backend/.env`, same admin account `pnpm seed:admin` creates — this is
local `dev.db`-derived data, never a shared/production database):

```bash
sqlite3 /tmp/watering-config-wiring-scratch.db \
  "select id from PlantProfile where soilMoistureIrrigatePercent is not null and soilMoistureCommandPercent is not null limit 1;"
# note the printed id as PROFILE_ID below

curl -c /tmp/wc-cookies.txt -s -X POST http://localhost:3050/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" | head -c 200
```

Assign the species to `MOCK-POT-NORMAL` (replace `PROFILE_ID` with the id from above; the device
row is created automatically by the mock provider's own seed data, no manual insert needed):

```bash
curl -b /tmp/wc-cookies.txt -s -X POST http://localhost:3050/api/trpc/health.assignPlantProfile \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"MOCK-POT-NORMAL","plantProfileId":PROFILE_ID}'
```

Expected: a successful tRPC JSON response. A few seconds later (the push runs in the background),
confirm the flag flipped:

```bash
sqlite3 /tmp/watering-config-wiring-scratch.db "select autonomousWateringActive from Device where id = 'MOCK-POT-NORMAL';"
```

Expected: `1` (true). Now deactivate the schedule and confirm it flips back:

```bash
curl -b /tmp/wc-cookies.txt -s -X POST http://localhost:3050/api/trpc/schedule.upsert \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"MOCK-POT-NORMAL","active":false,"allowedStartHour":6,"allowedEndHour":20,"cooldownHours":24}'

sleep 2
sqlite3 /tmp/watering-config-wiring-scratch.db "select autonomousWateringActive from Device where id = 'MOCK-POT-NORMAL';"
```

Expected: `0` (false).

Stop the dev server (Ctrl-C in the first terminal) and clean up:
`rm /tmp/watering-config-wiring-scratch.db* /tmp/wc-cookies.txt`.

- [ ] **Step 5: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/api/trpc/routers/health.ts backend/src/api/trpc/routers/schedule.ts
git commit -m "backend: push device-side watering config on species assignment and schedule changes"
```

---

### Task 7: Scheduler degraded safety net

**Files:**

- Modify: `backend/src/health/scheduler.ts`

**Interfaces:**

- Consumes: `Device.autonomousWateringActive` (Task 1); `health.parameters.soilMoisturePercent`
  and `device.plantProfile?.soilMoistureCommandPercent` (both already available in
  `evaluateDevice`'s existing scope, no new imports needed).

- [ ] **Step 1: Add the two new constants**

Open `backend/src/health/scheduler.ts`. Add these two constants right after the existing
`DEFAULT_SCHEDULE` export:

```typescript
// Device-side autonomous watering (docs/superpowers/specs/2026-08-30-parrot-device-side-
// autonomous-watering-design.md) — once a device's pot decides and waters itself, the backend
// scheduler becomes a degraded safety net rather than the primary decision-maker: a much longer
// cooldown, and only acting on a huge gap (DestCom's own example: target 40%, actual only 15%),
// never a marginal one the pot's own algorithm should already be handling.
const DEGRADED_MIN_COOLDOWN_HOURS = 72;
const LARGE_DELTA_THRESHOLD_POINTS = 20;
```

- [ ] **Step 2: Change the cooldown check**

Find this block inside `evaluateDevice`:

```typescript
  const lastWatering = await prisma.wateringEvent.findFirst({ where: { deviceId: device.id }, orderBy: { timestamp: 'desc' } });
  if (lastWatering && Date.now() - lastWatering.timestamp.getTime() < effective.cooldownHours * 3600_000) return;
```

Replace it with:

```typescript
  const cooldownHours = device.autonomousWateringActive ? Math.max(effective.cooldownHours, DEGRADED_MIN_COOLDOWN_HOURS) : effective.cooldownHours;
  const lastWatering = await prisma.wateringEvent.findFirst({ where: { deviceId: device.id }, orderBy: { timestamp: 'desc' } });
  if (lastWatering && Date.now() - lastWatering.timestamp.getTime() < cooldownHours * 3600_000) return;
```

- [ ] **Step 3: Change the trigger condition**

Find this line near the end of `evaluateDevice`:

```typescript
  if (health.parameters.soilMoisturePercent?.status !== 'too_low') return;
```

Replace it with:

```typescript
  const soilMoisture = health.parameters.soilMoisturePercent;
  if (device.autonomousWateringActive) {
    const target = device.plantProfile?.soilMoistureCommandPercent;
    if (soilMoisture?.value == null || target == null) return; // no signal to act on
    if (soilMoisture.value >= target - LARGE_DELTA_THRESHOLD_POINTS) return; // gap not large enough for the safety net to act
  } else {
    if (soilMoisture?.status !== 'too_low') return;
  }
```

- [ ] **Step 4: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 5: Manually verify against a scratch copy of `dev.db`**

```bash
cp backend/dev.db /tmp/scheduler-degraded-scratch.db
cd backend
DATABASE_URL="file:/tmp/scheduler-degraded-scratch.db" pnpm exec prisma migrate deploy
```

`evaluateDevice` isn't exported today — temporarily add `export` in front of `async function
evaluateDevice` in `scheduler.ts` (it stays an internal implementation detail otherwise; `tick()`
is the module's real public entry point and stays the only export used in production — revert
this temporary export once this step is done).

With the temporary export in place, run this single script — it seeds a huge-gap scenario and
calls `evaluateDevice` directly:

```bash
DATABASE_URL="file:/tmp/scheduler-degraded-scratch.db" pnpm exec tsx <<'EOF'
import { prisma } from './src/db/client.js';
import { createMockProvider } from './src/providers/mock/index.js';
import { ConnectionQueue } from './src/ble/connectionQueue.js';
import { evaluateDevice } from './src/health/scheduler.js';

const deviceId = 'MOCK-POT-NORMAL';
const profile = await prisma.plantProfile.findFirst({ where: { soilMoistureCommandPercent: { not: null } } });
if (!profile) throw new Error('No species with soilMoistureCommandPercent found in this DB.');

await prisma.device.upsert({
  where: { id: deviceId },
  update: { plantProfileId: profile.id, autonomousWateringActive: true },
  create: { id: deviceId, kind: 'PARROT_POT', name: 'scratch test pot', plantProfileId: profile.id, autonomousWateringActive: true },
});
await prisma.schedule.upsert({
  where: { deviceId },
  update: { active: true, cooldownHours: 1 },
  create: { deviceId, active: true, allowedStartHour: 0, allowedEndHour: 23, cooldownHours: 1 },
});
// Backdate a recent reading whose soilMoisturePercent is far below the target, to force the
// health engine to see a huge gap.
await prisma.reading.create({
  data: {
    deviceId,
    timestamp: new Date(),
    source: 'POLL',
    soilMoisturePercent: Math.max(0, profile.soilMoistureCommandPercent - 25),
    temperatureC: 21,
    luminosity: 5,
  },
});

const device = await prisma.device.findUnique({ where: { id: deviceId }, include: { plantProfile: true, schedule: true } });
const provider = createMockProvider();
const connectionQueue = new ConnectionQueue();
await evaluateDevice(device, provider, connectionQueue);
const events = await prisma.wateringEvent.findMany({ where: { deviceId } });
console.log('WateringEvent rows:', events);
EOF
```

Expected: with the huge gap (target minus 25 points) and `cooldownHours: 1` on the `Schedule` row
(well under the 72h floor), exactly one `WateringEvent` row appears — confirming the degraded gate
still triggers on a genuinely huge delta despite the schedule's own short configured cooldown
(the 72h floor is enforced regardless, not the schedule's own shorter setting). Re-run the same
script with `- 25` changed to `- 5` (a marginal gap instead of a huge one) — expected: zero
`WateringEvent` rows, confirming a marginal gap does not trigger the degraded safety net.

Revert the temporary `export` on `evaluateDevice` afterward, then clean up:
`rm /tmp/scheduler-degraded-scratch.db*`.

- [ ] **Step 6: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/health/scheduler.ts
git commit -m "health(scheduler): degrade to a huge-delta/long-cooldown safety net once a device is autonomous"
```

---

### Task 8: Frontend — `AutonomousWateringSection` component

**Files:**

- Create: `frontend/src/components/autonomous-watering-section.tsx`
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`

**Interfaces:**

- Consumes: `trpc.wateringConfig.getConfig`/`pushRunStatus`/`push` (Task 5);
  `device.autonomousWateringActive` and `device.plantProfile` (both already returned by
  `trpc.devices.list`, no backend change needed — `autonomousWateringActive` is a plain scalar
  column, `plantProfile` is already an included relation).

- [ ] **Step 1: Create the component**

Create `frontend/src/components/autonomous-watering-section.tsx`:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { Button } from './ui/button';

interface AutonomousWateringSectionProps {
  deviceId: string;
  plantProfile: { soilMoistureIrrigatePercent: number | null; soilMoistureCommandPercent: number | null } | null;
  autonomousWateringActive: boolean;
}

// Only meaningful for a Parrot Pot with a species assigned — mounted next to AutoWateringSection
// on the device detail page, gated by the same canWater check. See docs/superpowers/specs/
// 2026-08-30-parrot-device-side-autonomous-watering-design.md.
export function AutonomousWateringSection({ deviceId, plantProfile, autonomousWateringActive }: AutonomousWateringSectionProps) {
  const queryClient = useQueryClient();
  const hasParrotData = plantProfile?.soilMoistureIrrigatePercent != null && plantProfile?.soilMoistureCommandPercent != null;

  const { data: config, isLoading } = useQuery({ ...trpc.wateringConfig.getConfig.queryOptions({ deviceId }), enabled: hasParrotData });

  // The mutation only confirms the push was queued (same reasoning as calibrateWet — the BLE
  // sequence can exceed Cloudflare's origin timeout). Actual completion is observed by polling
  // pushRunStatus, same shape as the Plant Dr calibration page's precedent.
  const { data: runState } = useQuery({
    ...trpc.wateringConfig.pushRunStatus.queryOptions({ deviceId }),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });
  const isRunning = runState?.status === 'running';
  const lastHandledFinishRef = useRef<number | null>(null);

  useEffect(() => {
    if (!runState || runState.status === 'idle' || runState.status === 'running') return;
    if (lastHandledFinishRef.current === runState.finishedAt) return;
    lastHandledFinishRef.current = runState.finishedAt;

    if (runState.status === 'success') {
      void queryClient.invalidateQueries({ queryKey: trpc.wateringConfig.getConfig.queryKey({ deviceId }) });
      void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
      toast.success(runState.enabled ? 'Arrosage autonome activé sur le pot' : 'Arrosage autonome désactivé sur le pot');
    } else {
      toast.error('Échec de la configuration', { description: runState.message });
    }
  }, [runState, queryClient, deviceId]);

  const pushMutation = useMutation(
    trpc.wateringConfig.push.mutationOptions({
      onError: (error) => {
        toast.error('Échec du lancement', { description: error.message });
      },
    }),
  );

  return (
    <div className="my-7 rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-foreground">Arrosage autonome (sur le pot)</div>
          <div className="text-sm text-muted-foreground">
            {!hasParrotData
              ? "Espèce sans données Parrot — le pot ne peut pas décider seul, StroyPlant reste le seul décideur."
              : autonomousWateringActive
                ? 'Le pot décide et arrose lui-même en continu. StroyPlant ne sert plus que de filet de sécurité en cas de gros écart.'
                : "Le pot suit encore StroyPlant pour toute décision d'arrosage."}
          </div>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${
            autonomousWateringActive ? 'bg-emerald-100 text-emerald-800' : 'bg-muted text-muted-foreground'
          }`}
        >
          {autonomousWateringActive ? 'Actif' : 'Inactif'}
        </span>
      </div>

      {hasParrotData && (
        <div className="mt-4">
          {isLoading && <div className="text-sm text-muted-foreground">Lecture en cours…</div>}
          {config && (
            <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
              <div>
                Seuil déclenchement : <span className="font-medium text-foreground">{config.vwcIrrRaw != null ? (config.vwcIrrRaw / 10).toFixed(1) : '—'}%</span>
              </div>
              <div>
                Cible : <span className="font-medium text-foreground">{config.vwcCmdRaw != null ? (config.vwcCmdRaw / 10).toFixed(1) : '—'}%</span>
              </div>
            </div>
          )}
          <Button variant="outline" size="sm" className="mt-3.5" disabled={pushMutation.isPending || isRunning} onClick={() => pushMutation.mutate({ deviceId })}>
            {pushMutation.isPending || isRunning ? 'Configuration en cours…' : 'Repousser la configuration'}
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it on the device detail page**

Open `frontend/src/routes/_authenticated/devices.$deviceId.tsx`. Add the import:

```tsx
import { AutonomousWateringSection } from '@/components/autonomous-watering-section';
```

Find this line (search for `AutoWateringSection`):

```tsx
      {canWater && <AutoWateringSection deviceId={deviceId} hasSpeciesAssigned={device.plantProfile != null} />}
```

Add the new section right after it:

```tsx
      {canWater && <AutoWateringSection deviceId={deviceId} hasSpeciesAssigned={device.plantProfile != null} />}
      {canWater && (
        <AutonomousWateringSection deviceId={deviceId} plantProfile={device.plantProfile} autonomousWateringActive={device.autonomousWateringActive} />
      )}
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json` — expected clean (unaffected by
frontend changes, run for completeness).
Run: `cd frontend && pnpm exec tsc -b` — expected clean, unless the pre-existing unrelated
`erasableSyntaxOnly` failure documented in `CLAUDE.md`'s "Inference engine — Phase B" entry is
still present on this branch; if so, confirm the failing files are only
`backend/src/inference/engine.ts` (unrelated to this task) and not anything this task touched.

- [ ] **Step 4: Manual verification in a real browser**

Start the mock-provider dev stack (`cd backend && pnpm dev` in one terminal,
`cd frontend && pnpm dev` in another, both against a scratch or the existing local `dev.db`).
Sign in, open a Parrot Pot device's detail page:

- With no species assigned: the new section shows "Espèce sans données Parrot..." copy and no
  threshold values or button (matches `hasParrotData: false`).
- Assign a species that has Parrot-sourced data (search for one with real numeric soil-moisture
  thresholds in the species picker — most of the ~9120 Parrot-imported species qualify): the badge
  flips to "Actif" within a couple seconds (poll interval), the threshold values populate, and a
  toast "Arrosage autonome activé sur le pot" appears.
- Click "Repousser la configuration": button shows "Configuration en cours…" briefly, then reverts
  with a fresh success toast.
- Unassign the species: badge flips back to "Inactif".

- [ ] **Step 5: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add frontend/src/components/autonomous-watering-section.tsx frontend/src/routes/_authenticated/devices.\$deviceId.tsx
git commit -m "frontend: add AutonomousWateringSection to the device detail page"
```

---

## After all tasks: real hardware rollout

Not part of this plan's task list (no automated or scratch-DB verification can validate real
on-device behavior) — per the spec's "Rollout on real hardware" section, DestCom triggers the
first real push deliberately (by reassigning a species or resaving a schedule on one real pot
after this plan is merged and deployed) and observes over several real days whether that pot
waters itself consistent with the pushed thresholds, with StroyPlant's own manual/scheduled
triggers left alone during that window.
