# Soil Conductivity Self-Calibration + Full Raw Sensor Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WatchFlower's unvalidated fixed soil-conductivity calibration constants with a
per-device calibration derived from real accumulated raw readings, and add a comprehensive raw
sensor debug log covering every known Parrot Pot / Xiaomi characteristic.

**Architecture:** BLE providers stop computing "fertility" at read time — they persist only the raw
`39e1fa02` value (plus every other known raw characteristic, into a new `RawSensorLog` table).
Interpretation happens at read time (Health Engine scoring, frontend gauge, history chart), using a
per-device calibration derived on the fly from that device's all-time observed raw min/max — with an
explicit confidence gate so an under-calibrated device shows "calibrating," never a misleading
number.

**Tech Stack:** Fastify + Prisma/SQLite backend (`backend/`), Vite + React frontend (`frontend/`).
**No automated test suite exists in this repo** (no `vitest`/`jest`, confirmed via `grep` — every
prior batch documented in `CLAUDE.md` was verified manually against the mock provider via
`curl`/tRPC calls and scratch copies of `dev.db`). This plan follows that same established
verification style instead of inventing a test framework the codebase doesn't have — each task's
"verify" step is a concrete command to run and an expected real output to check, not a unit test.

## Global Constraints

- `pnpm` exclusively, never `npm`/`yarn` (`CLAUDE.md`).
- TypeScript everywhere, no Python.
- Never silently swallow a BLE error — every new best-effort characteristic read must be
  individually try/caught and logged, matching the existing pattern in
  `backend/src/providers/node-ble/index.ts` (spec section 7.1).
- No backfill of historical data — `RawSensorLog` starts empty at deploy time, only fills going
  forward (design spec, "Migration/rollout").
- No expiry on the conductivity calibration bounds once established — all-time min/max, never a
  rolling window (design spec, Part 3, DestCom's explicit choice).
- Confidence gate constants (`MIN_CALIBRATION_DAYS = 14`, `MIN_CALIBRATION_RAW_RANGE = 50`) are
  plain exported constants, not a `Settings` DB row — YAGNI (design spec, Part 3).
- Full design context: `docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-and-raw-sensor-log-design.md`.

---

## File Structure Overview

| File | Responsibility |
| --- | --- |
| `backend/prisma/schema.prisma` | New `RawSensorLog` model, 1:1 relation to `Reading` |
| `backend/src/providers/types.ts` | `ParrotPotReading`/`XiaomiReading` gain raw fields; `soilConductivityUsCm` removed (providers stop computing it) |
| `backend/src/ble/parrot/soilConductivity.ts` | Split into raw-extraction (`readSoilConductivityRawValue`) + parameterized mapping (`decodeSoilConductivityRaw(raw, bounds)`) |
| `backend/src/ble/parrot/uuids.ts` | New UUID constants for every raw characteristic not already tracked |
| `backend/src/readings.ts` | `persistReading()` also writes the new `RawSensorLog` row |
| `backend/src/health/soilConductivityCalibration.ts` | **New file** — `getCalibration()`, `resolveConductivityValue()`, confidence-gate constants |
| `backend/src/health/scoring.ts` | `computeDeviceHealth()` gains a `conductivityCalibration` param and a `'calibrating'` status |
| `backend/src/api/trpc/routers/health.ts`, `backend/src/health/scheduler.ts`, `backend/src/mqtt/publisher.ts` | The 3 `computeDeviceHealth()` call sites — fetch calibration + join `rawSensorLog` |
| `backend/src/api/trpc/routers/devices.ts` | `history` + `withLastReading` recompute `soilConductivityUsCm` live |
| `backend/src/providers/mock/index.ts` | Simulates all new raw fields, including realistic EC variance |
| `backend/src/providers/node-ble/index.ts` | Reads all new characteristics every poll (production) |
| `backend/src/providers/noble-bridge/index.ts` + `noble-bridge/src/parrot.ts` | Best-effort: Live-service raw fields only (Mac dev tool, lower priority) |
| `frontend/src/lib/types.ts`, `frontend/src/routes/_authenticated/devices.$deviceId.tsx` | `'calibrating'` status + nullable `ParameterHealth.value`; "Calibration en cours" UI |
| `docs/HEALTH_ENGINE.md`, `CLAUDE.md` | Doc updates (final task) |

---

### Task 1: Prisma schema — `RawSensorLog` model

**Files:**
- Modify: `backend/prisma/schema.prisma`

**Interfaces:**
- Produces: `RawSensorLog` Prisma model, `Reading.rawSensorLog` back-relation, all consumed by
  Tasks 5, 6, 8, 9.

- [ ] **Step 1: Add the `rawSensorLog` back-relation to `Reading`**

In `backend/prisma/schema.prisma`, inside `model Reading { ... }`, add one line right after the
`@@index([deviceId, timestamp])` line (before the closing `}`):

```prisma
  rawSensorLog RawSensorLog?
```

- [ ] **Step 2: Add the `RawSensorLog` model**

Append this new model right after `model Reading { ... }` closes (before `enum TriggerSource`):

```prisma
// Comprehensive raw-sensor debug log (docs/superpowers/specs/2026-07-31-soil-conductivity-self-
// calibration-and-raw-sensor-log-design.md) — one row per successful Reading, every known Parrot
// Pot/Xiaomi characteristic logged verbatim, decoded or not, used elsewhere or not. Every field
// nullable: absent/unreadable on a given poll (e.g. eaRaw/ecbRaw/ecPorousRaw, confirmed unavailable
// on real Pot firmware) is recorded as null, not omitted — a null here is informative ("still
// absent as of this poll"), not ambiguous with "we didn't try." No UI-facing exposure, no retention
// policy yet (same open-ended stance as SyncEvent).
model RawSensorLog {
  id        Int     @id @default(autoincrement())
  readingId Int     @unique
  reading   Reading @relation(fields: [readingId], references: [id])

  // Parrot Pot — Live service (39e1fa00)
  lightRaw               Int?
  soilConductivityRaw    Int?
  soilTempRaw            Int?
  airTempRaw             Int?
  soilMoistureRaw        Int?
  soilMoistureCalibrated Float? // fa09, duplicated from Reading.soilMoisturePercent
  airTempCalibrated      Float? // fa0a, duplicated from Reading.temperatureC
  luminosityCalibrated   Float? // fa0b, duplicated from Reading.luminosity
  eaRaw                  Float? // fa0c — expected null, characteristic confirmed absent on real hardware
  ecbRaw                 Float? // fa0d — expected null, same
  ecPorousRaw            Float? // fa0e — expected null, same

  // Parrot Pot — Watering service (39e1f900)
  waterTankLevelPercent Int?    // f907, duplicated from Reading.waterTankLevelPercent
  watVwcIrr             Int?
  watVwcCmd             Int?
  watNIrr               Int?
  watPumpDutyCycle      Int?
  watVwcIrrEco          Int?
  watVwcCmdEco          Int?
  watNIrrEco            Int?
  watMode               Int?
  watTimeSlotStart      Int?
  watTimeSlotDurr       Int?
  watVacationStart      Int?
  watVacationEnd        Int?
  algorithmStatus       Int?

  // Parrot Pot — Plant Dr service (39e1fd80)
  plantDrStatusFlagsRaw    Int? // fd86, raw byte (in addition to the decoded booleans on Reading)
  plantDrDryN              Int? // fd82
  plantDrDryVwcRaw         Int? // fd83
  plantDrWetN              Int? // fd84
  plantDrWetVwcRaw         Int? // fd85
  plantDrConfigId          Int? // fd81
  plantDrNextWateringDate  Int? // fd87
  plantDrNextEmptyTankDate Int? // fd88
  plantDrFullTankAutonomy  Int? // fd89

  // Parrot Pot — Calibration service (39e1fe00)
  calibrationDataBlobHex String? // fe01, 28 raw bytes as hex — no known decode
  colorRaw               Int?    // fe04

  // Xiaomi LYWSD03MMC
  tempRaw      Int?
  humidityRaw  Int?
  voltageRawMv Int?
}
```

- [ ] **Step 3: Generate and apply the migration**

Run: `cd backend && pnpm prisma:migrate -- --name add_raw_sensor_log`

Expected: prompts for a migration name (already passed via `--name`), creates a new folder under
`backend/prisma/migrations/` containing `migration.sql` with a `CREATE TABLE "RawSensorLog"` and an
`ALTER TABLE` (SQLite recreates the table to add the FK, this is normal for SQLite migrations), then
applies it to `backend/prisma/dev.db` and regenerates the Prisma Client. Command exits 0 with
"Your database is now in sync with your schema."

- [ ] **Step 4: Verify the table exists**

Run: `cd backend && sqlite3 prisma/dev.db ".schema RawSensorLog"`

Expected: prints the `CREATE TABLE "RawSensorLog" (...)` statement with all the columns from Step 2.

- [ ] **Step 5: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "Add RawSensorLog table for comprehensive per-poll sensor debug logging"
```

---

### Task 2: `providers/types.ts` — raw fields on `SensorReading`

**Files:**
- Modify: `backend/src/providers/types.ts`

**Interfaces:**
- Produces: extended `ParrotPotReading`/`XiaomiReading` interfaces, consumed by Tasks 5, 10, 11, 12
  (mock, node-ble, noble-bridge providers, and `readings.ts`).

- [ ] **Step 1: Replace `ParrotPotReading` and `XiaomiReading`**

In `backend/src/providers/types.ts`, replace the existing `ParrotPotReading` and `XiaomiReading`
interfaces (lines 5-30) with:

```ts
export interface ParrotPotReading {
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent?: number;
  // Plant Dr STATUS_FLAGS (Batch 6, docs/STROYPLANT_SPEC.md section 7.11) — firmware-computed
  // soil/reservoir/probe state. Best-effort (never used by the official app's live mode, behavior
  // not guaranteed on every firmware revision).
  isDrySoil?: boolean;
  isWetSoil?: boolean;
  isEmptyTank?: boolean;
  // A reading taken while the probe isn't in the soil doesn't represent a plant state — the Health
  // Engine excludes it from rolling-baseline calculations (docs/STROYPLANT_SPEC.md section 7.3).
  isInAir?: boolean;

  // Raw sensor debug log (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-
  // and-raw-sensor-log-design.md) — persisted verbatim into RawSensorLog, never used directly for
  // scoring except soilConductivityRaw (see health/soilConductivityCalibration.ts). Deliberately NOT
  // computed into a "fertility" value here anymore — that interpretation now happens at read time,
  // using a per-device calibration that improves as more history accumulates, not at write time
  // against a fixed global constant.
  lightRaw?: number;
  soilConductivityRaw?: number;
  soilTempRaw?: number;
  airTempRaw?: number;
  soilMoistureRaw?: number;
  eaRaw?: number;
  ecbRaw?: number;
  ecPorousRaw?: number;
  watVwcIrr?: number;
  watVwcCmd?: number;
  watNIrr?: number;
  watPumpDutyCycle?: number;
  watVwcIrrEco?: number;
  watVwcCmdEco?: number;
  watNIrrEco?: number;
  watMode?: number;
  watTimeSlotStart?: number;
  watTimeSlotDurr?: number;
  watVacationStart?: number;
  watVacationEnd?: number;
  algorithmStatus?: number;
  plantDrStatusFlagsRaw?: number;
  plantDrDryN?: number;
  plantDrDryVwcRaw?: number;
  plantDrWetN?: number;
  plantDrWetVwcRaw?: number;
  plantDrConfigId?: number;
  plantDrNextWateringDate?: number;
  plantDrNextEmptyTankDate?: number;
  plantDrFullTankAutonomy?: number;
  calibrationDataBlobHex?: string;
  colorRaw?: number;
}

export interface XiaomiReading {
  temperatureC: number;
  humidityPercent: number;
  batteryPercent?: number;

  // Raw sensor debug log — same rationale as ParrotPotReading above.
  tempRaw?: number;
  humidityRaw?: number;
  voltageRawMv?: number;
}
```

- [ ] **Step 2: Verify the backend still typechecks (it won't fully yet — later tasks fix the
  remaining errors, this step just confirms this file itself has no syntax error)**

Run: `cd backend && pnpm build 2>&1 | head -40`

Expected: errors referencing `soilConductivityUsCm` missing from `ParrotPotReading` in
`providers/mock/index.ts`, `providers/noble-bridge/index.ts`, `providers/node-ble/index.ts`, and
`readings.ts` — these are exactly the files Tasks 5/10/11/13 fix next. No error should reference
`providers/types.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add backend/src/providers/types.ts
git commit -m "Extend SensorReading with raw sensor fields, drop provider-computed soilConductivityUsCm"
```

---

### Task 3: `ble/parrot/soilConductivity.ts` — parameterized formula

**Files:**
- Modify: `backend/src/ble/parrot/soilConductivity.ts`

**Interfaces:**
- Produces: `readSoilConductivityRawValue(buf: Buffer): number`,
  `decodeSoilConductivityRaw(raw: number, bounds: ConductivityCalibrationBounds): number`,
  `ConductivityCalibrationBounds` type — consumed by Task 6 (calibration module) and Task 11
  (node-ble provider).

- [ ] **Step 1: Rewrite the file**

Replace the full contents of `backend/src/ble/parrot/soilConductivity.ts` with:

```ts
// Soil conductivity ("fertility index" on WatchFlower/the official app) — decoded from the RAW
// `39e1fa02` characteristic (uint16 LE), NOT from the "calibrated" `39e1fa0d`/`0e` characteristics
// this project originally tried (confirmed unavailable on real hardware, see
// docs/HEALTH_ENGINE.md).
//
// The clamp+inverted-map formula below is WatchFlower's own (github.com/emericg/WatchFlower,
// device_parrotpot.cpp) — empirically tuned against their own hardware, NOT validated against
// ours (real Parrot Pots read raw=775/983, both far outside WatchFlower's assumed [1500,2036]
// window, permanently pegging the old fixed-constant version of this formula at the top of the
// output scale). Cross-checked against 16 community repos + the 3 official Parrot-Developers org
// repos (2026-07-31): no alternative formula found anywhere is validated either — even WatchFlower's
// own app compares this same [0,1000]-clamped value directly against its own CSV's real µS/cm
// thresholds with no unit conversion (qml/DeviceWidget.qml, UtilsNumber.normalize) — an apparent
// scale question baked into the reference implementation itself.
//
// Since 2026-07-31 (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-and-raw-
// sensor-log-design.md), this formula's bounds are no longer WatchFlower's fixed global constants —
// they're derived per-device from real accumulated history (see
// health/soilConductivityCalibration.ts). This file only keeps the pure math, parameterized.

export interface ConductivityCalibrationBounds {
  rawMin: number; // maps to the top of the output range (most conductive observed for this device)
  rawMax: number; // maps to 0 (no soil / driest observed for this device)
}

const OUTPUT_MAX = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Extracts the raw uint16 ADC-ish value from the characteristic payload — this is what gets
// persisted (RawSensorLog.soilConductivityRaw), never the mapped output.
export function readSoilConductivityRawValue(buf: Buffer): number {
  return buf.readUInt16LE(0);
}

// Same output scale WatchFlower stores directly against its own CSV's "Soil conductivity" column
// (μS/cm) — no further unit conversion applied here, matching WatchFlower's own comparison
// (unit-scale caveat documented above). Inverted: a higher raw ADC reading means LESS conductive
// soil.
export function decodeSoilConductivityRaw(raw: number, bounds: ConductivityCalibrationBounds): number {
  const clamped = clamp(raw, bounds.rawMin, bounds.rawMax);
  return ((bounds.rawMax - clamped) / (bounds.rawMax - bounds.rawMin)) * OUTPUT_MAX;
}
```

- [ ] **Step 2: Verify the pure math with a one-off Node script**

Run:
```bash
cd backend && npx tsx -e "
import { decodeSoilConductivityRaw } from './src/ble/parrot/soilConductivity.js';
const bounds = { rawMin: 1495, rawMax: 2089 };
console.log(decodeSoilConductivityRaw(775, bounds));
console.log(decodeSoilConductivityRaw(983, bounds));
console.log(decodeSoilConductivityRaw(2089, bounds));
console.log(decodeSoilConductivityRaw(1495, bounds));
"
```

Expected: first two lines print a value close to 1000 (both raw values are below `rawMin`, so
clamped to the max end — same "always maxed with too-narrow a window" symptom, now visible with
real per-device bounds instead of WatchFlower's constants, confirming the math didn't change).
Third line prints `0`, fourth line prints `1000` — confirms the inversion direction is intact.

- [ ] **Step 3: Commit**

```bash
git add backend/src/ble/parrot/soilConductivity.ts
git commit -m "Parameterize soil conductivity formula by per-device calibration bounds"
```

---

### Task 4: `ble/parrot/uuids.ts` — new characteristic constants

**Files:**
- Modify: `backend/src/ble/parrot/uuids.ts`

**Interfaces:**
- Produces: new UUID string constants, consumed by Task 11 (node-ble provider).

- [ ] **Step 1: Add the Calibration service UUID + extend `UUIDS`**

In `backend/src/ble/parrot/uuids.ts`, add this new exported constant right after
`export const PLANT_DR_SERVICE_UUID = ...` (before `export const UUIDS = {`):

```ts
// Calibration service (Flower Power base, shared by the Parrot Pot) — only `fe01` (raw factory
// calibration blob, no known decode) and `fe04` (color) are read; confirmed dead-end for our
// purposes (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-and-raw-sensor-
// log-design.md), logged raw for the debug table only.
export const CALIBRATION_SERVICE_UUID = '39e1fe00-84a8-11e2-afba-0002a5d5c51b';
```

Then, inside `export const UUIDS = { ... }`, extend the `live` block by adding these entries right
after `soilConductivityRaw: '...fa02...',` (keep the trailing comma):

```ts
    // Raw (uncalibrated) characteristics — vestigial per the official app (never subscribed to),
    // logged for the raw sensor debug table only (docs/superpowers/specs/2026-07-31-...).
    lightRaw: '39e1fa01-84a8-11e2-afba-0002a5d5c51b',
    soilTempRaw: '39e1fa03-84a8-11e2-afba-0002a5d5c51b',
    airTempRaw: '39e1fa04-84a8-11e2-afba-0002a5d5c51b',
    soilMoistureRaw: '39e1fa05-84a8-11e2-afba-0002a5d5c51b',
    // "Calibrated" Ea/Ecb/EcPorous — confirmed "Characteristic not available" on both real Parrot
    // Pots (docs/HEALTH_ENGINE.md). Still attempted every poll and logged raw (null expected).
    eaCal: '39e1fa0c-84a8-11e2-afba-0002a5d5c51b',
    ecbCal: '39e1fa0d-84a8-11e2-afba-0002a5d5c51b',
    ecPorousCal: '39e1fa0e-84a8-11e2-afba-0002a5d5c51b',
```

Extend the `watering` block by adding these entries right after `waterTankLevel: ...,` (before
`algorithmStatus`):

```ts
    vwcIrr: '39e1f903-84a8-11e2-afba-0002a5d5c51b',
    vwcCmd: '39e1f904-84a8-11e2-afba-0002a5d5c51b',
    nIrr: '39e1f905-84a8-11e2-afba-0002a5d5c51b',
    pumpDutyCycle: '39e1f908-84a8-11e2-afba-0002a5d5c51b',
    vwcIrrEco: '39e1f90a-84a8-11e2-afba-0002a5d5c51b',
    vwcCmdEco: '39e1f90b-84a8-11e2-afba-0002a5d5c51b',
    nIrrEco: '39e1f90c-84a8-11e2-afba-0002a5d5c51b',
    mode: '39e1f90d-84a8-11e2-afba-0002a5d5c51b',
    timeSlotStart: '39e1f90e-84a8-11e2-afba-0002a5d5c51b',
    timeSlotDurr: '39e1f90f-84a8-11e2-afba-0002a5d5c51b',
    vacationStart: '39e1f910-84a8-11e2-afba-0002a5d5c51b',
    vacationEnd: '39e1f911-84a8-11e2-afba-0002a5d5c51b',
```

Extend the `plantDr` block by adding these entries right after `statusFlags: ...,` (before the
closing `},`):

```ts
    nextWateringDate: '39e1fd87-84a8-11e2-afba-0002a5d5c51b',
    nextEmptyTankDate: '39e1fd88-84a8-11e2-afba-0002a5d5c51b',
    fullTankAutonomy: '39e1fd89-84a8-11e2-afba-0002a5d5c51b',
```

Finally, add a new top-level `calibration` block, right after the `plantDr: { ... },` block closes
(before the final `} as const;`):

```ts
  calibration: {
    dataBlob: '39e1fe01-84a8-11e2-afba-0002a5d5c51b',
    color: '39e1fe04-84a8-11e2-afba-0002a5d5c51b',
  },
```

- [ ] **Step 2: Verify no duplicate/typo'd UUIDs**

Run: `cd backend && npx tsx -e "
import { UUIDS } from './src/ble/parrot/uuids.js';
const all = [...Object.values(UUIDS.live), ...Object.values(UUIDS.watering), ...Object.values(UUIDS.plantDr), ...Object.values(UUIDS.calibration)];
const unique = new Set(all);
console.log('total:', all.length, 'unique:', unique.size);
"`

Expected: `total:` and `unique:` print the same number (no accidental duplicate UUID string across
two different field names).

- [ ] **Step 3: Commit**

```bash
git add backend/src/ble/parrot/uuids.ts
git commit -m "Add UUID constants for all remaining known Parrot Pot characteristics"
```

---

### Task 5: `readings.ts` — persist `RawSensorLog`

**Files:**
- Modify: `backend/src/readings.ts`

**Interfaces:**
- Consumes: `SensorReading` (Task 2), `prisma.rawSensorLog` (Task 1).
- Produces: `persistReading()` now also creates a `RawSensorLog` row — no signature change, same
  callers (`namedDevicePoller.ts`, `devices.ts`'s `sync`/`forceSyncAll`, `liveSession/manager.ts`)
  need no changes.

- [ ] **Step 1: Rewrite `persistReading`**

Replace the `persistReading` function in `backend/src/readings.ts` (lines 17-47) with:

```ts
export async function persistReading(deviceId: string, kind: DeviceKind, reading: SensorReading, source: ReadingSource) {
  const data =
    reading.kind === 'PARROT_POT'
      ? {
          soilMoisturePercent: reading.data.soilMoisturePercent,
          temperatureC: reading.data.temperatureC,
          luminosity: reading.data.luminosity,
          waterTankLevelPercent: reading.data.waterTankLevelPercent,
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

  // Raw sensor debug log (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-
  // and-raw-sensor-log-design.md) — created in the same transaction as the Reading it's 1:1 linked
  // to, so the two can never diverge (e.g. a Reading with no matching RawSensorLog row, which would
  // break the "post-migration reading" detection the history/health call sites rely on).
  const rawData =
    reading.kind === 'PARROT_POT'
      ? {
          lightRaw: reading.data.lightRaw,
          soilConductivityRaw: reading.data.soilConductivityRaw,
          soilTempRaw: reading.data.soilTempRaw,
          airTempRaw: reading.data.airTempRaw,
          soilMoistureRaw: reading.data.soilMoistureRaw,
          soilMoistureCalibrated: reading.data.soilMoisturePercent,
          airTempCalibrated: reading.data.temperatureC,
          luminosityCalibrated: reading.data.luminosity,
          eaRaw: reading.data.eaRaw,
          ecbRaw: reading.data.ecbRaw,
          ecPorousRaw: reading.data.ecPorousRaw,
          waterTankLevelPercent: reading.data.waterTankLevelPercent,
          watVwcIrr: reading.data.watVwcIrr,
          watVwcCmd: reading.data.watVwcCmd,
          watNIrr: reading.data.watNIrr,
          watPumpDutyCycle: reading.data.watPumpDutyCycle,
          watVwcIrrEco: reading.data.watVwcIrrEco,
          watVwcCmdEco: reading.data.watVwcCmdEco,
          watNIrrEco: reading.data.watNIrrEco,
          watMode: reading.data.watMode,
          watTimeSlotStart: reading.data.watTimeSlotStart,
          watTimeSlotDurr: reading.data.watTimeSlotDurr,
          watVacationStart: reading.data.watVacationStart,
          watVacationEnd: reading.data.watVacationEnd,
          algorithmStatus: reading.data.algorithmStatus,
          plantDrStatusFlagsRaw: reading.data.plantDrStatusFlagsRaw,
          plantDrDryN: reading.data.plantDrDryN,
          plantDrDryVwcRaw: reading.data.plantDrDryVwcRaw,
          plantDrWetN: reading.data.plantDrWetN,
          plantDrWetVwcRaw: reading.data.plantDrWetVwcRaw,
          plantDrConfigId: reading.data.plantDrConfigId,
          plantDrNextWateringDate: reading.data.plantDrNextWateringDate,
          plantDrNextEmptyTankDate: reading.data.plantDrNextEmptyTankDate,
          plantDrFullTankAutonomy: reading.data.plantDrFullTankAutonomy,
          calibrationDataBlobHex: reading.data.calibrationDataBlobHex,
          colorRaw: reading.data.colorRaw,
        }
      : {
          tempRaw: reading.data.tempRaw,
          humidityRaw: reading.data.humidityRaw,
          voltageRawMv: reading.data.voltageRawMv,
        };

  const created = await prisma.$transaction(async (tx) => {
    const row = await tx.reading.create({ data: { deviceId, source, ...data } });
    await tx.rawSensorLog.create({ data: { readingId: row.id, ...rawData } });
    return row;
  });
  emitReading({ deviceId, kind, reading: serializeReading(created) });

  const mqttState = getMqttState();
  if (mqttState) {
    publishReadingState(mqttState.client, deviceId, data, mqttState.baseTopic);
    void publishHealthState(mqttState.client, deviceId, mqttState.baseTopic);
  }

  return created;
}
```

- [ ] **Step 2: Verify against a scratch DB copy**

```bash
cd backend
cp prisma/dev.db /tmp/verify-task5.db
DATABASE_URL="file:/tmp/verify-task5.db" npx tsx -e "
import { PrismaClient } from '@prisma/client';
import { persistReading } from './src/readings.js';
const prisma = new PrismaClient();
(globalThis as any).__prismaOverride = prisma;
" 2>&1 | tail -20
```

(If the above override trick doesn't apply cleanly since `db/client.ts` exports a module-level
singleton, instead set `DATABASE_URL=file:/tmp/verify-task5.db` as an environment variable before
running a small script that imports `persistReading` normally — Prisma reads `DATABASE_URL` at
client construction time, so this environment variable alone is sufficient without any override.)

```bash
DATABASE_URL="file:/tmp/verify-task5.db" npx tsx -e "
import { persistReading } from './src/readings.js';
const reading = { kind: 'PARROT_POT' as const, data: { soilMoisturePercent: 40, temperatureC: 21, luminosity: 5, soilConductivityRaw: 775, lightRaw: 0, soilTempRaw: 780, airTempRaw: 787, soilMoistureRaw: 189 } };
persistReading('TEST:DEVICE', 'PARROT_POT', reading, 'POLL').then((r) => console.log('created reading id', r.id));
"
sqlite3 /tmp/verify-task5.db "SELECT r.id, r.soilConductivityUsCm, rsl.soilConductivityRaw FROM Reading r JOIN RawSensorLog rsl ON rsl.readingId = r.id WHERE r.deviceId='TEST:DEVICE';"
rm /tmp/verify-task5.db
```

Expected: the script prints "created reading id N"; the `sqlite3` query returns one row with
`soilConductivityUsCm` = empty/NULL (no longer written) and `soilConductivityRaw` = `775`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/readings.ts
git commit -m "persistReading: write RawSensorLog row, stop writing Reading.soilConductivityUsCm"
```

---

### Task 6: `health/soilConductivityCalibration.ts` (new module)

**Files:**
- Create: `backend/src/health/soilConductivityCalibration.ts`

**Interfaces:**
- Consumes: `prisma` (`db/client.js`), `decodeSoilConductivityRaw` (Task 3).
- Produces: `ConductivityCalibration` type, `getCalibration(deviceId: string): Promise<ConductivityCalibration | null>`,
  `resolveConductivityValue(reading: ReadingWithRawLog, calibration: ConductivityCalibration | null): number | null`,
  `MIN_CALIBRATION_DAYS`, `MIN_CALIBRATION_RAW_RANGE` — consumed by Task 7 (scoring.ts) and Task 9
  (devices.ts router).

- [ ] **Step 1: Write the module**

```ts
import type { Reading, RawSensorLog } from '@prisma/client';
import { prisma } from '../db/client.js';
import { decodeSoilConductivityRaw } from '../ble/parrot/soilConductivity.js';

// Confidence-gate constants (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-
// and-raw-sensor-log-design.md, Part 3) — plain exported constants, not a Settings DB row (YAGNI).
export const MIN_CALIBRATION_DAYS = 14;
export const MIN_CALIBRATION_RAW_RANGE = 50;

export interface ConductivityCalibration {
  rawMin: number;
  rawMax: number;
  readingCount: number;
  daysCovered: number;
  calibrated: boolean;
}

export type ReadingWithRawLog = Reading & { rawSensorLog: RawSensorLog | null };

// All-time (never expiring, DestCom's explicit choice) min/max of the raw 39e1fa02 value this
// specific device has ever reported during a normal poll — a calibration should reflect the widest
// real range this device has ever shown, not "recent" behavior. Scoped to source='POLL' like every
// other Health Engine baseline calculation, so a live session can never skew it.
export async function getCalibration(deviceId: string): Promise<ConductivityCalibration | null> {
  const agg = await prisma.rawSensorLog.aggregate({
    where: { reading: { deviceId, source: 'POLL' }, soilConductivityRaw: { not: null } },
    _min: { soilConductivityRaw: true },
    _max: { soilConductivityRaw: true },
    _count: { soilConductivityRaw: true },
  });
  if (agg._count.soilConductivityRaw === 0 || agg._min.soilConductivityRaw == null || agg._max.soilConductivityRaw == null) {
    return null;
  }

  const oldest = await prisma.rawSensorLog.findFirst({
    where: { reading: { deviceId, source: 'POLL' }, soilConductivityRaw: { not: null } },
    orderBy: { reading: { timestamp: 'asc' } },
    include: { reading: { select: { timestamp: true } } },
  });
  const daysCovered = oldest ? (Date.now() - oldest.reading.timestamp.getTime()) / (24 * 3600_000) : 0;

  const rawMin = agg._min.soilConductivityRaw;
  const rawMax = agg._max.soilConductivityRaw;
  const readingCount = agg._count.soilConductivityRaw;
  const calibrated = daysCovered >= MIN_CALIBRATION_DAYS && rawMax - rawMin >= MIN_CALIBRATION_RAW_RANGE;

  return { rawMin, rawMax, readingCount, daysCovered, calibrated };
}

// Resolves the "fertility" value for one Reading: readings created after this feature shipped
// always have a RawSensorLog row (even if soilConductivityRaw itself is null, e.g. a failed read) —
// for those, recompute fresh using the device's CURRENT calibration (null if not calibrated yet,
// i.e. "calibrating", never a stale number). Readings that predate this feature have no
// RawSensorLog row at all — for those only, fall back to whatever Reading.soilConductivityUsCm the
// old fixed-formula already computed and stored, so historical charts don't go blank.
export function resolveConductivityValue(reading: ReadingWithRawLog, calibration: ConductivityCalibration | null): number | null {
  if (!reading.rawSensorLog) return reading.soilConductivityUsCm;
  if (reading.rawSensorLog.soilConductivityRaw == null || !calibration?.calibrated) return null;
  return decodeSoilConductivityRaw(reading.rawSensorLog.soilConductivityRaw, { rawMin: calibration.rawMin, rawMax: calibration.rawMax });
}
```

- [ ] **Step 2: Verify against a scratch DB copy**

```bash
cd backend
cp prisma/dev.db /tmp/verify-task6.db
DATABASE_URL="file:/tmp/verify-task6.db" npx tsx -e "
import { prisma } from './src/db/client.js';
import { getCalibration, resolveConductivityValue } from './src/health/soilConductivityCalibration.js';

async function main() {
  await prisma.device.create({ data: { id: 'TEST:CAL', kind: 'PARROT_POT' } });
  const now = Date.now();
  // 3 readings spanning 20 days, raw range 700-1900 (>50, satisfies both gates)
  for (const [daysAgo, raw] of [[20, 1900], [10, 700], [0, 1200]] as const) {
    const reading = await prisma.reading.create({
      data: { deviceId: 'TEST:CAL', source: 'POLL', timestamp: new Date(now - daysAgo * 24 * 3600_000) },
    });
    await prisma.rawSensorLog.create({ data: { readingId: reading.id, soilConductivityRaw: raw } });
  }
  const calibration = await getCalibration('TEST:CAL');
  console.log('calibration:', calibration);

  const readings = await prisma.reading.findMany({ where: { deviceId: 'TEST:CAL' }, include: { rawSensorLog: true }, orderBy: { timestamp: 'asc' } });
  for (const r of readings) console.log('resolved:', resolveConductivityValue(r, calibration));
}
main().then(() => process.exit(0));
"
rm /tmp/verify-task6.db
```

Expected: `calibration:` prints `{ rawMin: 700, rawMax: 1900, readingCount: 3, daysCovered: ~20,
calibrated: true }`; the 3 `resolved:` lines print real numbers between 0 and 1000, with the
`raw=1900` reading (oldest, `daysAgo=20`) resolving near `0` and the `raw=700` reading resolving
near `1000` (matches the inversion — lower raw = more conductive = higher output).

- [ ] **Step 3: Verify the "not enough data" gate**

Run the same script but with only 2 readings both from `daysAgo: 1` (not enough days) — expected
`calibration.calibrated === false`, and `resolveConductivityValue` returns `null` for both.

- [ ] **Step 4: Commit**

```bash
git add backend/src/health/soilConductivityCalibration.ts
git commit -m "Add per-device soil conductivity calibration module"
```

---

### Task 7: `health/scoring.ts` — `'calibrating'` status

**Files:**
- Modify: `backend/src/health/scoring.ts`

**Interfaces:**
- Consumes: `ConductivityCalibration`, `resolveConductivityValue` (Task 6).
- Produces: `computeDeviceHealth(device, readings, profile, warmupMinDays, conductivityCalibration)`
  — new required 5th parameter; `readings` parameter type changes to
  `ReadingWithRawLog[]` (Task 6); `ParameterStatus` gains `'calibrating'`; `ParameterHealth.value`
  becomes `number | null`. Consumed by Task 8 (all 3 call sites).

- [ ] **Step 1: Update types and imports**

In `backend/src/health/scoring.ts`, replace the import line and the type declarations at the top:

```ts
import type { Device, PlantProfile } from '@prisma/client';
import type { ConductivityCalibration, ReadingWithRawLog } from './soilConductivityCalibration.js';
import { resolveConductivityValue } from './soilConductivityCalibration.js';

export type ParameterKey = 'soilMoisturePercent' | 'temperatureC' | 'humidityPercent' | 'luminosity' | 'soilConductivityUsCm';

export type ParameterStatus = 'ok' | 'too_low' | 'too_high' | 'n/a' | 'calibrating';

export interface ParameterHealth {
  value: number | null;
  status: ParameterStatus;
  speciesRange: [number, number] | null;
}
```

- [ ] **Step 2: Update `valuesFor` to special-case conductivity**

Replace the `valuesFor` function:

```ts
function valuesFor(key: ParameterKey, readings: ReadingWithRawLog[], conductivityCalibration: ConductivityCalibration | null): number[] {
  if (key === 'soilConductivityUsCm') {
    return readings
      .map((reading) => resolveConductivityValue(reading, conductivityCalibration))
      .filter((value): value is number => value != null);
  }
  return readings.map((reading) => reading[key]).filter((value): value is number => value != null);
}
```

- [ ] **Step 3: Update `computeDeviceHealth`'s signature and loop**

Replace the function signature and body (keep `computeTrend`'s call and the rest of the function
structure, only the parts shown change):

```ts
export function computeDeviceHealth(
  device: Pick<Device, 'kind'>,
  readings: ReadingWithRawLog[],
  profile: PlantProfile | null,
  warmupMinDays: number,
  conductivityCalibration: ConductivityCalibration | null,
): DeviceHealth {
  if (!profile) {
    return { status: 'no_profile', parameters: {}, trend: 'unknown' };
  }

  const sorted = readings.filter((reading) => reading.isInAir !== true).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const oldest = sorted[0];
  const daysCovered = oldest ? (Date.now() - oldest.timestamp.getTime()) / (24 * 3600_000) : 0;
  const warmingUp = daysCovered < warmupMinDays;

  const now = Date.now();
  const recentReadings = sorted.filter((reading) => now - reading.timestamp.getTime() <= RECENT_WINDOW_MS);
  const recentSource = recentReadings.length > 0 ? recentReadings : sorted.slice(-5);

  const parameters: Partial<Record<ParameterKey, ParameterHealth>> = {};
  let hasOutOfRange = false;

  for (const key of PARAMETERS_BY_KIND[device.kind]) {
    // Scoped to this one parameter (design spec, Part 4) — an under-calibrated conductivity sensor
    // never pushes the WHOLE device into 'warming_up', that status is a coarser, separate concept.
    if (key === 'soilConductivityUsCm' && conductivityCalibration?.calibrated !== true) {
      parameters[key] = { value: null, status: 'calibrating', speciesRange: null };
      continue;
    }

    const rawValue = average(valuesFor(key, recentSource, conductivityCalibration));
    if (rawValue == null) continue;
    const recentValue = rawValue * (UNIT_CONVERSION[key] ?? 1);

    const speciesRange = speciesRangeFor(key, profile);
    let status: ParameterStatus = 'n/a';
    if (speciesRange) {
      const [min, max] = speciesRange;
      status = recentValue < min ? 'too_low' : recentValue > max ? 'too_high' : 'ok';
      if (status !== 'ok') hasOutOfRange = true;
    }

    parameters[key] = { value: recentValue, status, speciesRange };
  }

  return {
    status: warmingUp ? 'warming_up' : hasOutOfRange ? 'warning' : 'ok',
    parameters,
    trend: computeTrend(sorted, device.kind),
  };
}
```

- [ ] **Step 4: Update `computeTrend` and `valuesFor` call inside it**

`computeTrend` only ever uses `TREND_PARAMETER_BY_KIND[kind]`, which is `soilMoisturePercent` or
`humidityPercent` — never `soilConductivityUsCm` — so its own `valuesFor` calls need the new 3rd
argument, but it's never actually exercised for conductivity there. Update both call sites inside
`computeTrend` to pass `null` as the 3rd argument:

```ts
  const recentValues = valuesFor(
    key,
    sorted.filter((reading) => reading.timestamp.getTime() >= recentCutoff),
    null,
  );
  const olderValues = valuesFor(
    key,
    sorted.filter((reading) => reading.timestamp.getTime() < recentCutoff),
    null,
  );
```

- [ ] **Step 5: Verify with a scratch script**

```bash
cd backend
npx tsx -e "
import { computeDeviceHealth } from './src/health/scoring.js';
const device = { kind: 'PARROT_POT' as const };
const profile = { soilMoistureMinPercent: 20, soilMoistureMaxPercent: 60, soilConductivityMinUsCm: 100, soilConductivityMaxUsCm: 900, temperatureMinC: 15, temperatureMaxC: 30, humidityMinPercent: null, humidityMaxPercent: null, lightMinMmol: 1, lightMaxMmol: 10 } as any;
const readings = [{ id: 1, deviceId: 'x', timestamp: new Date(), soilMoisturePercent: 40, temperatureC: 21, luminosity: 5, isInAir: false, rawSensorLog: null, soilConductivityUsCm: null } as any];
const health = computeDeviceHealth(device, readings, profile, 3, null);
console.log(JSON.stringify(health.parameters.soilConductivityUsCm));
"
```

Expected: prints `{"value":null,"status":"calibrating","speciesRange":null}` — confirms the
'calibrating' branch fires when `conductivityCalibration` is `null`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/health/scoring.ts
git commit -m "computeDeviceHealth: add 'calibrating' status for under-calibrated conductivity"
```

---

### Task 8: Update the 3 `computeDeviceHealth` call sites

**Files:**
- Modify: `backend/src/api/trpc/routers/health.ts:45-57` (`deviceHealth` procedure)
- Modify: `backend/src/health/scheduler.ts:44-60` (`evaluateDevice`)
- Modify: `backend/src/mqtt/publisher.ts:24-36` (`publishHealthState`)

**Interfaces:**
- Consumes: `getCalibration` (Task 6), updated `computeDeviceHealth` signature (Task 7).

- [ ] **Step 1: `health.ts`'s `deviceHealth` procedure**

Add the import `import { getCalibration } from '../../../health/soilConductivityCalibration.js';` at
the top, then replace the `deviceHealth` procedure body:

```ts
  deviceHealth: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId }, include: { plantProfile: true } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const healthSettings = await getHealthSettings();
    const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
      orderBy: { timestamp: 'asc' },
      include: { rawSensorLog: true },
    });
    const conductivityCalibration = await getCalibration(device.id);

    return computeDeviceHealth(device, readings, device.plantProfile, healthSettings.warmupMinDays, conductivityCalibration);
  }),
```

- [ ] **Step 2: `scheduler.ts`'s `evaluateDevice`**

Add the import `import { getCalibration } from './soilConductivityCalibration.js';` at the top (this
file is already in `backend/src/health/`, so it's a same-directory import), then replace lines 54-60:

```ts
  const healthSettings = await getHealthSettings();
  const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
  const readings = await prisma.reading.findMany({
    where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
    orderBy: { timestamp: 'asc' },
    include: { rawSensorLog: true },
  });
  const conductivityCalibration = await getCalibration(device.id);
  const health = computeDeviceHealth(device, readings, device.plantProfile, healthSettings.warmupMinDays, conductivityCalibration);
```

- [ ] **Step 3: `publisher.ts`'s `publishHealthState`**

Add the import `import { getCalibration } from '../health/soilConductivityCalibration.js';` at the
top, then replace lines 28-34:

```ts
  const healthSettings = await getHealthSettings();
  const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
  const readings = await prisma.reading.findMany({
    where: { deviceId, timestamp: { gte: since }, source: 'POLL' },
    orderBy: { timestamp: 'asc' },
    include: { rawSensorLog: true },
  });
  const conductivityCalibration = await getCalibration(deviceId);
  const health = computeDeviceHealth(device, readings, device.plantProfile, healthSettings.warmupMinDays, conductivityCalibration);
```

- [ ] **Step 4: Verify the backend builds**

Run: `cd backend && pnpm build 2>&1 | head -60`

Expected: no errors referencing `health.ts`, `scheduler.ts`, or `publisher.ts` — remaining errors (if
any) should only be in the provider files not yet updated (Tasks 10/11/13) and `devices.ts` (Task 9).

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/trpc/routers/health.ts backend/src/health/scheduler.ts backend/src/mqtt/publisher.ts
git commit -m "Wire per-device conductivity calibration into all 3 computeDeviceHealth call sites"
```

---

### Task 9: `devices.ts` router — recompute conductivity live

**Files:**
- Modify: `backend/src/api/trpc/routers/devices.ts`

**Interfaces:**
- Consumes: `getCalibration`, `resolveConductivityValue` (Task 6).

- [ ] **Step 1: Add the import**

At the top of `backend/src/api/trpc/routers/devices.ts`:

```ts
import { getCalibration, resolveConductivityValue } from '../../../health/soilConductivityCalibration.js';
```

- [ ] **Step 2: Update `withLastReading`**

Replace the `withLastReading` function (lines 17-23):

```ts
async function withLastReading(device: DeviceWithPlantProfile) {
  const lastReading = await prisma.reading.findFirst({
    where: { deviceId: device.id },
    orderBy: { timestamp: 'desc' },
    include: { rawSensorLog: true },
  });
  if (lastReading) {
    const calibration = await getCalibration(device.id);
    lastReading.soilConductivityUsCm = resolveConductivityValue(lastReading, calibration);
  }
  return { ...device, lastSeenAt: serializeDate(device.lastSeenAt), lastReading: serializeReading(lastReading) };
}
```

- [ ] **Step 3: Update the `history` procedure**

Replace the `history` procedure body (lines 123-134):

```ts
  history: protectedProcedure.input(z.object({ deviceId: z.string(), hours: z.number().optional() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const hours = input.hours ?? 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
      orderBy: { timestamp: 'asc' },
      include: { rawSensorLog: true },
    });
    const calibration = await getCalibration(device.id);
    for (const reading of readings) {
      reading.soilConductivityUsCm = resolveConductivityValue(reading, calibration);
    }
    return readings.map((reading) => serializeReading(reading));
  }),
```

- [ ] **Step 4: Verify the backend builds cleanly for this file**

Run: `cd backend && pnpm build 2>&1 | grep devices.ts`

Expected: no output (no errors in this file).

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/trpc/routers/devices.ts
git commit -m "devices.ts: recompute soilConductivityUsCm live using current per-device calibration"
```

---

### Task 10: Mock provider — simulate raw fields

**Files:**
- Modify: `backend/src/providers/mock/index.ts`

**Interfaces:**
- Consumes: extended `ParrotPotReading`/`XiaomiReading` (Task 2).

- [ ] **Step 1: Replace `soilConductivityUsCm` with a raw simulated value**

In `MockPotState` (lines 13-24), replace `soilConductivityUsCm: number;` with
`soilConductivityRaw: number;`. In `createInitialPots()` (lines 42-76), replace both
`soilConductivityUsCm: 900,`/`soilConductivityUsCm: 850,` with `soilConductivityRaw: 1700,`/
`soilConductivityRaw: 1600,` respectively (mid-range ADC-ish starting points, comment updated to
match):

```ts
      // Raw fa02-equivalent ADC value (not a "fertility" number — that's derived at read time from
      // accumulated calibration, docs/superpowers/specs/2026-07-31-soil-conductivity-self-
      // calibration-and-raw-sensor-log-design.md). Chosen mid-range so applyPotDecay's noise below
      // naturally produces enough spread over time for a scratch-DB test to observe the calibration
      // gate flip to `calibrated`.
      soilConductivityRaw: 1700,
```

and

```ts
      soilConductivityRaw: 1600,
```

- [ ] **Step 2: Update `applyPotDecay`**

Replace this line in `applyPotDecay` (line 90):

```ts
  state.soilConductivityUsCm = Math.max(0, state.soilConductivityUsCm + (Math.random() - 0.5) * 15);
```

with:

```ts
  // Wider per-tick variance than the old µS/cm-scale noise (±15) — raw ADC counts are a bigger
  // number range (~0-2047), and enough spread here lets a scratch-DB test with backdated readings
  // observe MIN_CALIBRATION_RAW_RANGE being satisfied within a realistic simulated timespan.
  state.soilConductivityRaw = Math.max(0, Math.min(2047, state.soilConductivityRaw + (Math.random() - 0.5) * 60));
```

- [ ] **Step 3: Update `readSensors`'s returned data**

Replace this line in `readSensors` (line 181):

```ts
          soilConductivityUsCm: pot.soilConductivityUsCm,
```

with:

```ts
          soilConductivityRaw: Math.round(pot.soilConductivityRaw),
          // Simulated values for the other raw fields — plausible but not meant to be realistic,
          // this provider exists for dev/testing, not hardware validation (docs/STROYPLANT_SPEC.md
          // section 6).
          lightRaw: 0,
          soilTempRaw: 780,
          airTempRaw: 787,
          soilMoistureRaw: Math.round(pot.soilMoisturePercent * 5),
          watVwcIrr: 175,
          watVwcCmd: 225,
          watNIrr: 0,
          watPumpDutyCycle: 70,
          watVwcIrrEco: 150,
          watVwcCmdEco: 200,
          watNIrrEco: 0,
          watMode: 1,
          watTimeSlotStart: 1200,
          watTimeSlotDurr: 360,
          algorithmStatus: 1,
          plantDrStatusFlagsRaw: (statusFlags.isDrySoil ? 1 : 0) | (statusFlags.isWetSoil ? 2 : 0) | (statusFlags.isEmptyTank ? 4 : 0),
          plantDrDryN: pot.plantDr.dryN,
          plantDrDryVwcRaw: Math.round(pot.plantDr.dryVwcPercent * 10),
          plantDrWetN: pot.plantDr.wetN,
          plantDrWetVwcRaw: Math.round(pot.plantDr.wetVwcPercent * 10),
          plantDrConfigId: pot.plantDr.configId,
```

- [ ] **Step 4: Update `createInitialXiaomi`'s consumer in `readSensors`**

In the Xiaomi branch of `readSensors` (lines 157-160), add raw fields to the returned `data`:

```ts
        return {
          kind: 'XIAOMI_LYWSD03MMC',
          data: {
            temperatureC: sensor.temperatureC,
            humidityPercent: sensor.humidityPercent,
            batteryPercent: sensor.batteryPercent,
            tempRaw: Math.round(sensor.temperatureC * 100),
            humidityRaw: Math.round(sensor.humidityPercent),
            voltageRawMv: 3000,
          },
        };
```

- [ ] **Step 5: Verify the backend builds and the mock provider runs end-to-end**

Run: `cd backend && pnpm build 2>&1 | grep -i mock`

Expected: no output.

Then start the dev server against a scratch DB and confirm a mock poll persists raw data:
```bash
cd backend
cp prisma/dev.db /tmp/verify-task10.db
DATABASE_URL="file:/tmp/verify-task10.db" BLE_PROVIDER=mock timeout 20 pnpm dev 2>&1 | tail -30
sqlite3 /tmp/verify-task10.db "SELECT deviceId, soilConductivityRaw FROM RawSensorLog JOIN Reading ON Reading.id = RawSensorLog.readingId ORDER BY Reading.id DESC LIMIT 3;"
rm /tmp/verify-task10.db
```

Expected: the `sqlite3` query returns rows for `MOCK-POT-NORMAL`/`MOCK-POT-DECLINE` with
`soilConductivityRaw` around 1700/1600 (± noise). (If `BLE_PROVIDER` isn't the actual env var name
used to select the mock provider, check `backend/src/providers/factory.ts` for the real variable
name before running this — do not guess it silently.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/providers/mock/index.ts
git commit -m "Mock provider: simulate raw sensor fields instead of a precomputed conductivity value"
```

---

### Task 11: `node-ble` provider — read every characteristic

**Files:**
- Modify: `backend/src/providers/node-ble/index.ts`

**Interfaces:**
- Consumes: `UUIDS` (Task 4), `readSoilConductivityRawValue` (Task 3), `trackedCharacteristic`,
  `CALIBRATION_SERVICE_UUID` (Task 4).

This is the highest-value task (real production hardware). Every new read follows the exact
existing best-effort pattern (`trackedCharacteristic` + try/catch + `log(...)`) already used for
`soilConductivityRaw`/`STATUS_FLAGS` in this file — one missing/errored characteristic must never
fail the rest of the poll.

- [ ] **Step 1: Update the import line**

Replace the `uuids.js` import (currently lines 9-16) to also import `CALIBRATION_SERVICE_UUID`:

```ts
import {
  CALIBRATION_SERVICE_UUID,
  PARROT_POT_NAME_PREFIX,
  PLANT_DR_SERVICE_UUID,
  SENSOR_SERVICE_UUID,
  UUIDS,
  WATER_TRIGGER_PAYLOAD,
  WATERING_SERVICE_UUID,
} from '../../ble/parrot/uuids.js';
```

Also update the `soilConductivity.js` import to bring in the raw-value reader:

```ts
import { readSoilConductivityRawValue } from '../../ble/parrot/soilConductivity.js';
```

(Remove the old `decodeSoilConductivityRaw` import — it's no longer called from this file, the
mapping now happens at read time in the Health Engine, not at poll time.)

- [ ] **Step 2: Replace the soil conductivity block in `readSensors`**

Replace the existing conductivity block (lines 418-441 in the current file):

```ts
            let soilConductivityRaw: number | undefined;
            try {
              const conductivityChar = await trackedCharacteristic(sensorService, UUIDS.live.soilConductivityRaw, characteristics);
              soilConductivityRaw = readSoilConductivityRawValue(await conductivityChar.readValue());
              log({ direction: 'READ', label: 'Soil conductivity raw read', deviceId, result: 'OK', detail: `raw=${soilConductivityRaw}` });
            } catch (error) {
              log({
                direction: 'INFO',
                label: 'Soil conductivity indisponible',
                deviceId,
                result: 'ERROR',
                detail: error instanceof Error ? error.message : String(error),
              });
            }
```

- [ ] **Step 3: Add a generic best-effort read helper (reduces repetition for the ~20 new reads)**

Add this helper function right after `trackedCharacteristic` (before `readParrotAdvertisementPayload`):

```ts
// Generic best-effort characteristic read for the raw sensor debug log — every one of these must
// never fail the rest of the poll (spec 7.1), so failures are caught and logged individually here
// rather than repeating the same try/catch at every call site.
async function readRawBestEffort<T>(
  service: GattService,
  uuid: string,
  characteristics: GattCharacteristic[],
  deviceId: string,
  label: string,
  decode: (buf: Buffer) => T,
): Promise<T | undefined> {
  try {
    const characteristic = await trackedCharacteristic(service, uuid, characteristics);
    const value = decode(await characteristic.readValue());
    log({ direction: 'READ', label, deviceId, result: 'OK', detail: String(value) });
    return value;
  } catch (error) {
    log({ direction: 'INFO', label: `${label} indisponible`, deviceId, result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
    return undefined;
  }
}

const readU16 = (buf: Buffer) => buf.readUInt16LE(0);
const readU8 = (buf: Buffer) => buf.readUInt8(0);
const readU32 = (buf: Buffer) => buf.readUInt32LE(0);
```

- [ ] **Step 4: Add the new reads to `readSensors`, right after the STATUS_FLAGS block, before
  `const reading: SensorReading = {`**

```ts
            // Raw sensor debug log — every field here is best-effort, logged individually, never
            // failing the rest of the poll (docs/superpowers/specs/2026-07-31-soil-conductivity-
            // self-calibration-and-raw-sensor-log-design.md).
            const lightRaw = await readRawBestEffort(sensorService, UUIDS.live.lightRaw, characteristics, deviceId, 'Light raw', readU16);
            const soilTempRaw = await readRawBestEffort(sensorService, UUIDS.live.soilTempRaw, characteristics, deviceId, 'Soil temp raw', readU16);
            const airTempRaw = await readRawBestEffort(sensorService, UUIDS.live.airTempRaw, characteristics, deviceId, 'Air temp raw', readU16);
            const soilMoistureRaw = await readRawBestEffort(sensorService, UUIDS.live.soilMoistureRaw, characteristics, deviceId, 'Soil moisture raw', readU16);
            const eaRaw = await readRawBestEffort(sensorService, UUIDS.live.eaCal, characteristics, deviceId, 'Ea raw', (b) => b.readFloatLE(0));
            const ecbRaw = await readRawBestEffort(sensorService, UUIDS.live.ecbCal, characteristics, deviceId, 'Ecb raw', (b) => b.readFloatLE(0));
            const ecPorousRaw = await readRawBestEffort(sensorService, UUIDS.live.ecPorousCal, characteristics, deviceId, 'EcPorous raw', (b) => b.readFloatLE(0));

            let watVwcIrr: number | undefined;
            let watVwcCmd: number | undefined;
            let watNIrr: number | undefined;
            let watPumpDutyCycle: number | undefined;
            let watVwcIrrEco: number | undefined;
            let watVwcCmdEco: number | undefined;
            let watNIrrEco: number | undefined;
            let watMode: number | undefined;
            let watTimeSlotStart: number | undefined;
            let watTimeSlotDurr: number | undefined;
            let watVacationStart: number | undefined;
            let watVacationEnd: number | undefined;
            let algorithmStatus: number | undefined;
            try {
              const wateringServiceForRaw = await gatt.getPrimaryService(WATERING_SERVICE_UUID);
              watVwcIrr = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.vwcIrr, characteristics, deviceId, 'wat_vwc_irr', readU16);
              watVwcCmd = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.vwcCmd, characteristics, deviceId, 'wat_vwc_cmd', readU16);
              watNIrr = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.nIrr, characteristics, deviceId, 'wat_n_irr', readU16);
              watPumpDutyCycle = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.pumpDutyCycle, characteristics, deviceId, 'wat_pump_duty_cycle', readU8);
              watVwcIrrEco = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.vwcIrrEco, characteristics, deviceId, 'wat_vwc_irr_eco', readU16);
              watVwcCmdEco = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.vwcCmdEco, characteristics, deviceId, 'wat_vwc_cmd_eco', readU16);
              watNIrrEco = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.nIrrEco, characteristics, deviceId, 'wat_n_irr_eco', readU16);
              watMode = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.mode, characteristics, deviceId, 'wat_mode', readU8);
              watTimeSlotStart = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.timeSlotStart, characteristics, deviceId, 'wat_time_slot_start', readU16);
              watTimeSlotDurr = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.timeSlotDurr, characteristics, deviceId, 'wat_time_slot_durr', readU16);
              watVacationStart = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.vacationStart, characteristics, deviceId, 'wat_vacation_start', readU32);
              watVacationEnd = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.vacationEnd, characteristics, deviceId, 'wat_vacation_end', readU32);
              algorithmStatus = await readRawBestEffort(wateringServiceForRaw, UUIDS.watering.algorithmStatus, characteristics, deviceId, 'algorithm_status', readU8);
            } catch (error) {
              log({ direction: 'INFO', label: 'Watering config service indisponible', deviceId, result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
            }

            let plantDrStatusFlagsRaw: number | undefined;
            let plantDrDryN: number | undefined;
            let plantDrDryVwcRaw: number | undefined;
            let plantDrWetN: number | undefined;
            let plantDrWetVwcRaw: number | undefined;
            let plantDrConfigId: number | undefined;
            let plantDrNextWateringDate: number | undefined;
            let plantDrNextEmptyTankDate: number | undefined;
            let plantDrFullTankAutonomy: number | undefined;
            try {
              const plantDrServiceForRaw = await gatt.getPrimaryService(PLANT_DR_SERVICE_UUID);
              plantDrStatusFlagsRaw = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.statusFlags, characteristics, deviceId, 'plantDr status raw', readU8);
              plantDrDryN = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.dryN, characteristics, deviceId, 'plantDr dryN', readU16);
              plantDrDryVwcRaw = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.dryVwc, characteristics, deviceId, 'plantDr dryVwc', readU16);
              plantDrWetN = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.wetN, characteristics, deviceId, 'plantDr wetN', readU16);
              plantDrWetVwcRaw = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.wetVwc, characteristics, deviceId, 'plantDr wetVwc', readU16);
              plantDrConfigId = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.configId, characteristics, deviceId, 'plantDr configId', readU16);
              plantDrNextWateringDate = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.nextWateringDate, characteristics, deviceId, 'plantDr nextWateringDate', readU32);
              plantDrNextEmptyTankDate = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.nextEmptyTankDate, characteristics, deviceId, 'plantDr nextEmptyTankDate', readU32);
              plantDrFullTankAutonomy = await readRawBestEffort(plantDrServiceForRaw, UUIDS.plantDr.fullTankAutonomy, characteristics, deviceId, 'plantDr fullTankAutonomy', readU32);
            } catch (error) {
              log({ direction: 'INFO', label: 'Plant Dr extra fields indisponibles', deviceId, result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
            }

            let calibrationDataBlobHex: string | undefined;
            let colorRaw: number | undefined;
            try {
              const calibrationService = await gatt.getPrimaryService(CALIBRATION_SERVICE_UUID);
              calibrationDataBlobHex = await readRawBestEffort(calibrationService, UUIDS.calibration.dataBlob, characteristics, deviceId, 'calibration blob', (b) => b.toString('hex'));
              colorRaw = await readRawBestEffort(calibrationService, UUIDS.calibration.color, characteristics, deviceId, 'color raw', readU16);
            } catch (error) {
              log({ direction: 'INFO', label: 'Calibration service indisponible', deviceId, result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
            }
```

- [ ] **Step 5: Add the new fields to the returned `SensorReading`**

Extend the `data: { ... }` object inside the returned `reading` (currently lines 469-482) with:

```ts
                lightRaw,
                soilConductivityRaw,
                soilTempRaw,
                airTempRaw,
                soilMoistureRaw,
                eaRaw,
                ecbRaw,
                ecPorousRaw,
                watVwcIrr,
                watVwcCmd,
                watNIrr,
                watPumpDutyCycle,
                watVwcIrrEco,
                watVwcCmdEco,
                watNIrrEco,
                watMode,
                watTimeSlotStart,
                watTimeSlotDurr,
                watVacationStart,
                watVacationEnd,
                algorithmStatus,
                plantDrStatusFlagsRaw,
                plantDrDryN,
                plantDrDryVwcRaw,
                plantDrWetN,
                plantDrWetVwcRaw,
                plantDrConfigId,
                plantDrNextWateringDate,
                plantDrNextEmptyTankDate,
                plantDrFullTankAutonomy,
                calibrationDataBlobHex,
                colorRaw,
```

(`soilConductivityRaw` replaces the old `soilConductivityUsCm` line that used to compute the mapped
value — it now just holds the raw number captured in Step 2.)

- [ ] **Step 6: Verify the backend builds**

Run: `cd backend && pnpm build 2>&1 | grep node-ble`

Expected: no output. If there are type errors, check that every variable declared with `let x:
number | undefined;` in Step 4 is actually assigned via a matching `readRawBestEffort` call before
being referenced in Step 5 (a common copy-paste mismatch when this many parallel fields are added).

- [ ] **Step 7: Manual real-hardware verification (production server only, DestCom's involvement
  required — mirrors the SSH diagnostic session already run earlier this project)**

Not runnable from this environment. Once deployed, ask DestCom to confirm via `docker logs
stroyplant` that a real poll cycle logs `OK` for the Live/Watering/Plant Dr/Calibration reads (and
expected `ERROR ... indisponible` only for `fa0c`/`fa0d`/`fa0e`, the confirmed-absent ones) and that
`RawSensorLog` rows are being created (`sqlite3 -readonly` against the production volume, same
technique used in this project's own watering investigation).

- [ ] **Step 8: Commit**

```bash
git add backend/src/providers/node-ble/index.ts
git commit -m "node-ble: read every known Parrot Pot characteristic per poll, log raw values"
```

---

### Task 12: Frontend — `'calibrating'` status + UI

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`

**Interfaces:**
- Consumes: backend's `DeviceHealth`/`ParameterHealth` shape (Task 7), unchanged over the wire
  except the new `'calibrating'` status string and nullable `value`.

- [ ] **Step 1: Update `frontend/src/lib/types.ts`**

Replace:

```ts
export type ParameterStatus = 'ok' | 'too_low' | 'too_high' | 'n/a';

export interface ParameterHealth {
  value: number;
  status: ParameterStatus;
  speciesRange: [number, number] | null;
}
```

with:

```ts
export type ParameterStatus = 'ok' | 'too_low' | 'too_high' | 'n/a' | 'calibrating';

export interface ParameterHealth {
  value: number | null;
  status: ParameterStatus;
  speciesRange: [number, number] | null;
}
```

- [ ] **Step 2: Update the conductivity gauge render in `devices.$deviceId.tsx`**

Replace the existing block (lines 376-386):

```tsx
{reading.soilConductivityUsCm != null && (
  <SensorGauge
    label="Fertilité du sol"
    value={reading.soilConductivityUsCm}
    max={1000}
    unit=" µS/cm"
    tone={toneFor(health?.parameters.soilConductivityUsCm, 'primary')}
    icon={<Sprout size={16} />}
    hint={rangeHint(health?.parameters.soilConductivityUsCm, ' µS/cm')}
  />
)}
```

with:

```tsx
{health?.parameters.soilConductivityUsCm?.status === 'calibrating' ? (
  <div className="flex w-28 flex-col items-center gap-2">
    <div className="flex h-21 w-21 items-center justify-center rounded-full border border-dashed border-muted-foreground/40">
      <Sprout size={16} className="text-muted-foreground" />
    </div>
    <span className="text-center text-xs text-muted-foreground">Fertilité du sol</span>
    <span className="text-center text-[11px] text-muted-foreground/70">Calibration en cours</span>
  </div>
) : (
  reading.soilConductivityUsCm != null && (
    <SensorGauge
      label="Fertilité du sol"
      value={reading.soilConductivityUsCm}
      max={1000}
      unit=" µS/cm"
      tone={toneFor(health?.parameters.soilConductivityUsCm, 'primary')}
      icon={<Sprout size={16} />}
      hint={rangeHint(health?.parameters.soilConductivityUsCm, ' µS/cm')}
    />
  )
)}
```

- [ ] **Step 3: Typecheck the frontend**

Run: `cd frontend && pnpm build 2>&1 | tail -40`

Expected: no type errors. `SensorGauge`'s `value` prop still receives a plain `number` in both
branches (the `'calibrating'` branch never calls `SensorGauge` at all, matching the design spec's
Part 5 exactly).

- [ ] **Step 4: Manual visual verification**

Run `cd frontend && pnpm dev` and `cd backend && pnpm dev` (mock provider), open a device detail
page for a Parrot Pot device with a species assigned. Since the mock DB is fresh (no
`RawSensorLog` history yet post-migration), the conductivity slot should show the dashed-border
"Calibration en cours" placeholder instead of a gauge. Take a screenshot if convenient; otherwise
describe what's visually confirmed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/routes/_authenticated/devices.\$deviceId.tsx
git commit -m "Frontend: show 'Calibration en cours' for an under-calibrated conductivity sensor"
```

---

### Task 13: `noble-bridge` — best-effort Live-service raw fields only

**Files:**
- Modify: `noble-bridge/src/uuids.ts`
- Modify: `noble-bridge/src/parrot.ts`
- Modify: `backend/src/providers/noble-bridge/index.ts`
- `noble-bridge/src/server.ts` needs **no changes** — its `/devices/:id/sensors` route
  (`app.post<{ Params: { id: string } }>('/devices/:id/sensors', ...)`) already does
  `const reading = ... await readParrotSensors(id); return reading;` — a plain passthrough of
  whatever `parrot.ts` returns, confirmed by reading the file.

**Scope note (deliberate, matches the design spec's explicit lower-priority stance for this
provider):** only the 4 raw Live-service characteristics (`fa01`/`fa03`/`fa04`/`fa05`, on the same
already-open Live service as the existing `fa02` read) are added here. The Watering config/Plant Dr
extra fields/Calibration service are **not** added to noble-bridge — that would be substantial new
native-`@abandonware/noble` GATT work on a Mac-only dev tool this project doesn't rely on for
production validation. If DestCom wants full parity here later, treat it as a separate,
explicitly-scoped follow-up, not silently expanded within this task.

- [ ] **Step 1: Add the 4 new UUID constants to `noble-bridge/src/uuids.ts`**

Inside the `live: { ... }` block, right after `measurePeriod: '...fa06...',`, add:

```ts
    lightRaw: '39e1fa01-84a8-11e2-afba-0002a5d5c51b',
    soilTempRaw: '39e1fa03-84a8-11e2-afba-0002a5d5c51b',
    airTempRaw: '39e1fa04-84a8-11e2-afba-0002a5d5c51b',
    soilMoistureRaw: '39e1fa05-84a8-11e2-afba-0002a5d5c51b',
```

- [ ] **Step 2: Update `noble-bridge/src/parrot.ts`'s `ParrotSensorReading` interface**

Replace `soilConductivityUsCm?: number;` (currently line 9) with:

```ts
  soilConductivityRaw?: number;
  lightRaw?: number;
  soilTempRaw?: number;
  airTempRaw?: number;
  soilMoistureRaw?: number;
```

- [ ] **Step 3: Remove the now-unused `decodeSoilConductivityRaw` helper**

Delete the `decodeSoilConductivityRaw` function (currently lines 27-31) — this process now only
forwards the raw uint16, the mapping happens backend-side (Task 3/6). Its header comment
(`// Duplicated from backend/src/ble/parrot/soilConductivity.ts...`) goes with it.

- [ ] **Step 4: Replace the conductivity block and add the 4 new reads in `readParrotSensors`**

Replace the existing conductivity block (currently lines 58-68):

```ts
    let soilConductivityRaw: number | undefined;
    try {
      const raw = await readCharacteristic(pot, UUIDS.live.soilConductivityRaw, 'Soil conductivity', logicalId);
      soilConductivityRaw = raw.readUInt16LE(0);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Soil conductivity indisponible',
        deviceId: logicalId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    let lightRaw: number | undefined;
    let soilTempRaw: number | undefined;
    let airTempRaw: number | undefined;
    let soilMoistureRaw: number | undefined;
    try {
      lightRaw = (await readCharacteristic(pot, UUIDS.live.lightRaw, 'Light raw', logicalId)).readUInt16LE(0);
      soilTempRaw = (await readCharacteristic(pot, UUIDS.live.soilTempRaw, 'Soil temp raw', logicalId)).readUInt16LE(0);
      airTempRaw = (await readCharacteristic(pot, UUIDS.live.airTempRaw, 'Air temp raw', logicalId)).readUInt16LE(0);
      soilMoistureRaw = (await readCharacteristic(pot, UUIDS.live.soilMoistureRaw, 'Soil moisture raw', logicalId)).readUInt16LE(0);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Raw Live-service fields indisponibles',
        deviceId: logicalId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
```

- [ ] **Step 5: Update the returned object**

Replace `soilConductivityUsCm,` (currently line 96) with:

```ts
      soilConductivityRaw,
      lightRaw,
      soilTempRaw,
      airTempRaw,
      soilMoistureRaw,
```

- [ ] **Step 6: Update `backend/src/providers/noble-bridge/index.ts`'s `readSensors`**

Replace the `PARROT_POT` return branch (currently lines 72-85):

```ts
      return {
        kind: 'PARROT_POT',
        data: {
          soilMoisturePercent: body.soilMoisturePercent,
          temperatureC: body.temperatureC,
          luminosity: body.luminosity,
          waterTankLevelPercent: body.waterTankLevelPercent,
          soilConductivityRaw: body.soilConductivityRaw,
          lightRaw: body.lightRaw,
          soilTempRaw: body.soilTempRaw,
          airTempRaw: body.airTempRaw,
          soilMoistureRaw: body.soilMoistureRaw,
          isDrySoil: body.isDrySoil,
          isWetSoil: body.isWetSoil,
          isEmptyTank: body.isEmptyTank,
          isInAir: body.isInAir,
        },
      };
```

- [ ] **Step 7: Verify both packages build**

Run: `cd noble-bridge && pnpm build 2>&1 | tail -20 && cd ../backend && pnpm build 2>&1 | grep noble-bridge`

Expected: both exit clean, no output from the `grep`.

- [ ] **Step 8: Note real-hardware verification is out of scope for this task**

This provider is only validated on a real Mac with Bluetooth hardware, outside this environment —
matches its existing "not production, not CI-tested" status (`CLAUDE.md`). No further verification
step is possible here; leave it to DestCom to confirm on the Mac if/when convenient.

- [ ] **Step 9: Commit**

```bash
git add noble-bridge/src backend/src/providers/noble-bridge/index.ts
git commit -m "noble-bridge: forward raw Live-service fields (best-effort, no Watering/PlantDr/Calibration parity)"
```

---

### Task 14: Docs update + final full-build check

**Files:**
- Modify: `docs/HEALTH_ENGINE.md`
- Modify: `CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a new entry to `docs/HEALTH_ENGINE.md`'s "Soil conductivity / fertility index —
  history" section**, after the existing "New open question" paragraph, summarizing: the
  self-calibration mechanism now in place (per-device all-time min/max, 14-day/50-raw-unit
  confidence gate), the move from write-time to read-time interpretation, and the new
  `RawSensorLog` table's existence/purpose. Link to
  `docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-and-raw-sensor-log-design.md`
  rather than duplicating its content.

- [ ] **Step 2: Add a "Project status" entry to `CLAUDE.md`**, following the exact style of the
  existing dated entries in that section (see e.g. the "Poll interval moved to the Settings page
  too" entry for the expected level of detail: what changed, why, key decisions, what was verified,
  what wasn't). Cover: the calibration confidence-gate constants and their rationale, the
  `RawSensorLog` table's scope and explicit non-goals (no UI, no retention policy yet), and the
  `noble-bridge` scope cut from Task 13.

- [ ] **Step 3: Full workspace build check**

Run: `pnpm -r build 2>&1 | tail -60` (from the repo root — builds `backend`, `frontend`, and
`noble-bridge` in sequence per the pnpm workspace).

Expected: all 3 packages build with exit code 0. If not, fix whatever the error points to before
proceeding — this is the final gate before considering the plan complete.

- [ ] **Step 4: Commit**

```bash
git add docs/HEALTH_ENGINE.md CLAUDE.md
git commit -m "Document soil conductivity self-calibration + raw sensor log in HEALTH_ENGINE.md/CLAUDE.md"
```
