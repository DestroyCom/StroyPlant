# Health Engine Consistency Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 5 audit findings + 1 externally-sourced finding in the StroyPlant Health Engine
(indoor luminosity comparison, missing personal baseline, non-robust conductivity calibration,
gauge/badge visual inconsistency, fragile parameter-ordering dependency, unbounded poller Maps) per
`docs/superpowers/specs/2026-07-31-health-engine-consistency-fixes-design.md`.

**Architecture:** All changes are pure computation/UI logic over existing tables — no new Prisma
migration, no config changes. Backend changes land first (`health/scoring.ts`,
`health/soilConductivityCalibration.ts`, `ble/namedDevicePoller.ts`), then frontend consumption
(`frontend/src/lib/types.ts`, `format.ts`, `devices.$deviceId.tsx`, `sensor-gauge.tsx`), then docs.

**Tech Stack:** TypeScript, Fastify/tRPC backend, Prisma/SQLite, React/TanStack frontend. This
project has **no automated test suite** (confirmed: no `*.test.ts` files, no vitest/jest config) —
every prior batch verifies manually against a scratch copy of `dev.db` and/or the `mock` provider
(see CLAUDE.md's many "Verified against the mock provider..." entries). This plan follows that same
established convention instead of introducing a new test framework.

## Global Constraints

- The new personal-baseline signal (`personalDeviation`) must NEVER influence `status`,
  `hasOutOfRange`, `warningParameters`, or `health/scheduler.ts`'s auto-watering trigger — display
  only. Confirmed explicitly with DestCom given the real-world consequence of loosening the
  watering-trigger condition.
- Indoor luminosity adaptation only activates when `Device.environment === 'INDOOR'` — `OUTDOOR` and
  `null` (the current state of every real device today) get zero behavior change.
- Indoor luminosity is a **floor-only** comparison (`too_low` or `ok`, never `too_high`).
- 2 standard deviations for "unusual" (personal baseline) — a standard statistical convention, not
  an invented domain constant.
- 5th/95th percentile for conductivity calibration bounds (replacing all-time min/max) — same
  `MIN_CALIBRATION_DAYS`/`MIN_CALIBRATION_RAW_RANGE` gate values, same "never expiring" design.
- No new Prisma migration. No new env vars / `HealthSettings` fields (all new thresholds are plain
  exported constants, matching this codebase's existing YAGNI stance for
  `MIN_CALIBRATION_DAYS`/`MIN_CALIBRATION_RAW_RANGE`).
- `speciesRange`'s open-ended upper bound (indoor luminosity) must be represented as `[number, number
  | null]` with `null` meaning "no upper bound" — **not** `Number.POSITIVE_INFINITY`. tRPC's default
  wire format here is plain JSON (no superjson transformer, confirmed in CLAUDE.md's tRPC section)
  and `JSON.stringify(Infinity)` silently produces `null` anyway, so using `Infinity` in code would
  serialize correctly by accident on this one hop but is misleading and fragile — model the "no
  upper bound" state explicitly instead.
- French UI copy throughout (matches the rest of the frontend).

---

### Task 1: Percentile-based conductivity calibration bounds

**Files:**
- Modify: `backend/src/health/soilConductivityCalibration.ts`

**Interfaces:**
- Consumes: `prisma.rawSensorLog` (existing Prisma model, `soilConductivityRaw: Int?`, unique
  `readingId` FK to `Reading`), `decodeSoilConductivityRaw({rawMin, rawMax}, raw)` from
  `backend/src/ble/parrot/soilConductivity.ts` (unchanged signature).
- Produces: `getCalibration(deviceId: string): Promise<ConductivityCalibration | null>` — same
  exported name/shape as today (`{ rawMin, rawMax, readingCount, daysCovered, calibrated }`), same
  call sites (`health/scheduler.ts:62`, `api/trpc/routers/health.ts:58`, `mqtt/publisher.ts:~36`) —
  **no signature change**, so no other file needs editing for this task.

- [ ] **Step 1: Replace the aggregate-based min/max with a percentile calculation**

Open `backend/src/health/soilConductivityCalibration.ts`. Replace the whole file with:

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

// Linear-interpolation percentile (matches numpy's default) over an already-sorted array.
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const index = p * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

// Bounds derived from the 5th/95th percentile (not the absolute min/max, 2026-07-31 follow-up) of
// the raw 39e1fa02 value this specific device has ever reported during a normal poll — all-time,
// never expiring (DestCom's explicit choice: a calibration should reflect the widest real range
// this device has shown, not "recent" behavior), scoped to source='POLL' like every other Health
// Engine baseline calculation so a live session can never skew it. Percentiles (not the true
// min/max) so a single spurious raw reading (electrical glitch, bad contact) can't permanently
// redefine the whole 0-1000 output scale and silently reshape every historical chart value — it
// just clamps at the extreme end via decodeSoilConductivityRaw's existing clamp() instead.
export async function getCalibration(deviceId: string): Promise<ConductivityCalibration | null> {
  const rows = await prisma.rawSensorLog.findMany({
    where: { reading: { deviceId, source: 'POLL' }, soilConductivityRaw: { not: null } },
    select: { soilConductivityRaw: true },
  });
  if (rows.length === 0) return null;

  const values = rows.map((row) => row.soilConductivityRaw as number).sort((a, b) => a - b);
  const rawMin = percentile(values, 0.05);
  const rawMax = percentile(values, 0.95);

  const oldest = await prisma.rawSensorLog.findFirst({
    where: { reading: { deviceId, source: 'POLL' }, soilConductivityRaw: { not: null } },
    orderBy: { reading: { timestamp: 'asc' } },
    include: { reading: { select: { timestamp: true } } },
  });
  const daysCovered = oldest ? (Date.now() - oldest.reading.timestamp.getTime()) / (24 * 3600_000) : 0;

  const readingCount = values.length;
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

- [ ] **Step 2: Manual verification — percentile bounds resist a single outlier**

Copy `backend/prisma/dev.db` to a scratch path (use the session scratchpad directory, or `/tmp`),
e.g.:

```bash
cp backend/prisma/dev.db /tmp/health-engine-verify.db
```

Create a throwaway script `backend/scratch-verify-calibration.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { getCalibration } from './src/health/soilConductivityCalibration.js';

const prisma = new PrismaClient();

async function main() {
  const device = await prisma.device.create({
    data: { id: 'SCRATCH-VERIFY-CALIBRATION', kind: 'PARROT_POT', name: 'Scratch verify' },
  });

  // 20 normal readings spread 700-795 (step 5, spread=95 so the MIN_CALIBRATION_RAW_RANGE=50 gate
  // is satisfied by the cluster alone), plus 1 wild outlier (raw=50) and 1 (raw=2000) that must NOT
  // end up defining rawMin/rawMax once percentile bounds replace the old absolute min/max.
  const rawValues = [...Array.from({ length: 20 }, (_, i) => 700 + i * 5), 50, 2000];
  const now = Date.now();
  for (let i = 0; i < rawValues.length; i++) {
    const reading = await prisma.reading.create({
      data: {
        deviceId: device.id,
        source: 'POLL',
        // Spread over 20 days so the MIN_CALIBRATION_DAYS=14 gate is satisfied.
        timestamp: new Date(now - (rawValues.length - i) * 24 * 3600_000),
      },
    });
    await prisma.rawSensorLog.create({ data: { readingId: reading.id, soilConductivityRaw: rawValues[i] } });
  }

  const calibration = await getCalibration(device.id);
  if (!calibration) throw new Error('Expected a calibration, got null');
  console.log('calibration:', calibration);

  // The outliers (50, 2000) must NOT define rawMin/rawMax — percentile bounds should stay close to
  // the 780-799 cluster.
  if (calibration.rawMin < 700 || calibration.rawMin > 800) throw new Error(`rawMin ${calibration.rawMin} was pulled toward the outlier`);
  if (calibration.rawMax < 780 || calibration.rawMax > 900) throw new Error(`rawMax ${calibration.rawMax} was pulled toward the outlier`);
  if (!calibration.calibrated) throw new Error('Expected calibrated=true (20+ days, range >= 50)');

  console.log('OK — percentile bounds ignored the outliers');
  // No onDelete: Cascade on Reading.device / RawSensorLog.reading in the schema — child rows must
  // be deleted explicitly before the Device row, or this throws a foreign key constraint error.
  await prisma.rawSensorLog.deleteMany({ where: { reading: { deviceId: device.id } } });
  await prisma.reading.deleteMany({ where: { deviceId: device.id } });
  await prisma.device.delete({ where: { id: device.id } });
}

main().finally(() => prisma.$disconnect());
```

Run it against the scratch DB:

```bash
cd backend
DATABASE_URL="file:/tmp/health-engine-verify.db" pnpm exec tsx scratch-verify-calibration.ts
```

Expected output ends with `OK — percentile bounds ignored the outliers`. If `DATABASE_URL` doesn't
take effect (dotenv precedence), confirm by checking `calibration` in the printed object references
raw values near 780-799, not 50/2000.

- [ ] **Step 3: Clean up scratch files**

```bash
rm backend/scratch-verify-calibration.ts /tmp/health-engine-verify.db
```

- [ ] **Step 4: Typecheck and commit**

```bash
pnpm --filter backend exec tsc --noEmit
git add backend/src/health/soilConductivityCalibration.ts
git commit -m "Use 5th/95th percentile instead of absolute min/max for conductivity calibration bounds"
```

---

### Task 2: `computeDeviceHealth` — indoor luminosity, personal baseline, `warningParameters`

**Files:**
- Modify: `backend/src/health/scoring.ts`

**Interfaces:**
- Consumes: `ConductivityCalibration`/`ReadingWithRawLog` from Task 1's
  `soilConductivityCalibration.ts` (unchanged shape). `Device.environment: 'INDOOR' | 'OUTDOOR' |
  null` (existing Prisma field, `backend/prisma/schema.prisma:31`).
- Produces: `ParameterHealth` gains `personalDeviation: 'unusual_low' | 'unusual_high' | 'normal'`
  and `speciesRange: [number, number | null] | null` (was `[number, number] | null`).
  `DeviceHealth` gains `warningParameters: ParameterKey[]`. `computeDeviceHealth`'s first parameter
  type widens from `Pick<Device, 'kind'>` to `Pick<Device, 'kind' | 'environment'>` — all 3 existing
  call sites (`health/scheduler.ts:63`, `api/trpc/routers/health.ts:59`, `mqtt/publisher.ts:37`)
  already pass a full `Device` row from `prisma.device.findUnique`/`findMany`, so **none of them
  need edits** (verify this in Step 5).

- [ ] **Step 1: Add the indoor-luminosity category logic**

In `backend/src/health/scoring.ts`, after the existing `UNIT_CONVERSION` constant (around line 48),
add:

```ts
type LightCategory = 'low' | 'medium' | 'high';

// Published general houseplant DLI (Daily Light Integral) categories — NOT a per-species indoor
// dataset (none exists anywhere: not in the WatchFlower CSV, not in the official Parrot app, not in
// any of the other Flower Power repos surveyed). Used only when Device.environment is INDOOR, where
// ambient window light with no supplemental grow lighting makes the outdoor/garden-oriented
// WatchFlower CSV thresholds structurally unreachable for most real placements (a real production
// Parrot Pot reading: 0.1 mol/m²/day, two full orders of magnitude below the CSV's typical 2-7.5
// mol/day minimums). Values in mmol/m²/day to match PlantProfile.lightMinMmol/lightMaxMmol's own
// unit — no separate conversion needed here.
const INDOOR_LIGHT_FLOOR_MMOL: Record<LightCategory, number> = { low: 2000, medium: 5000, high: 10000 };

// Classifies a SPECIES (not a device) by its own outdoor light need, using the CSV's own
// lightMinMmol — a species that tolerates little light outdoors is assumed shade-tolerant indoors
// too, and vice versa. Breakpoints match the same published low/medium/high-light category
// boundaries as INDOOR_LIGHT_FLOOR_MMOL above.
function classifyLightCategory(speciesOutdoorMinMmol: number): LightCategory {
  if (speciesOutdoorMinMmol <= 5000) return 'low';
  if (speciesOutdoorMinMmol <= 15000) return 'medium';
  return 'high';
}
```

- [ ] **Step 2: Replace the inline species-range/status logic with `resolveRangeAndStatus`**

Still in `scoring.ts`, find the `speciesRangeFor` function (around line 62) and add a new function
right after it:

```ts
// Resolves both the comparison range and the resulting status for one parameter. Indoor luminosity
// is the one special case (floor-only comparison against a published category, see above) — every
// other parameter/environment combination uses the species CSV range unchanged.
function resolveRangeAndStatus(
  key: ParameterKey,
  recentValue: number,
  profile: PlantProfile,
  environment: Device['environment'],
): { speciesRange: [number, number | null] | null; status: ParameterStatus } {
  if (key === 'luminosity' && environment === 'INDOOR') {
    const outdoorRange = speciesRangeFor(key, profile);
    if (!outdoorRange) return { speciesRange: null, status: 'n/a' };
    const floor = INDOOR_LIGHT_FLOOR_MMOL[classifyLightCategory(outdoorRange[0])];
    return { speciesRange: [floor, null], status: recentValue < floor ? 'too_low' : 'ok' };
  }

  const speciesRange = speciesRangeFor(key, profile);
  if (!speciesRange) return { speciesRange: null, status: 'n/a' };
  const [min, max] = speciesRange;
  return { speciesRange, status: recentValue < min ? 'too_low' : recentValue > max ? 'too_high' : 'ok' };
}
```

- [ ] **Step 3: Add the personal-baseline computation**

Still in `scoring.ts`, after `stdDev` (around line 86), add:

```ts
// Minimum baseline sample size before trusting a personal mean/stddev — reuses the same "5" the
// existing recentSource fallback already uses a few lines below (not a new invented threshold).
const PERSONAL_BASELINE_MIN_POINTS = 5;
// Standard statistical convention for "unusual" (2 standard deviations), not a domain-specific
// constant — see design spec Part C.
const PERSONAL_BASELINE_SIGMA = 2;

// Compares a device's own current value against ITS OWN recent history (excluding the same
// RECENT_WINDOW_MS slice being evaluated) — separate from, and never influencing, the
// species-range-based status above. Uses the pre-unit-conversion raw value (same unit valuesFor()
// already returns for this key) so no extra conversion bookkeeping is needed here; unit consistency
// only matters within this self-comparison, not against species thresholds.
function computePersonalDeviation(
  key: ParameterKey,
  rawValue: number,
  sorted: ReadingWithRawLog[],
  recentSource: ReadingWithRawLog[],
  warmingUp: boolean,
  conductivityCalibration: ConductivityCalibration | null,
): 'unusual_low' | 'unusual_high' | 'normal' {
  if (warmingUp) return 'normal';

  const recentSet = new Set(recentSource);
  const baselineReadings = sorted.filter((reading) => !recentSet.has(reading));
  const baselineValues = valuesFor(key, baselineReadings, conductivityCalibration);
  if (baselineValues.length < PERSONAL_BASELINE_MIN_POINTS) return 'normal';

  const baselineMean = average(baselineValues);
  if (baselineMean == null) return 'normal';
  const baselineStdDev = stdDev(baselineValues, baselineMean);
  if (baselineStdDev === 0) return 'normal';

  if (rawValue < baselineMean - PERSONAL_BASELINE_SIGMA * baselineStdDev) return 'unusual_low';
  if (rawValue > baselineMean + PERSONAL_BASELINE_SIGMA * baselineStdDev) return 'unusual_high';
  return 'normal';
}
```

- [ ] **Step 4: Update the types and the main loop**

Update the `ParameterHealth` interface:

```ts
export interface ParameterHealth {
  value: number | null;
  status: ParameterStatus;
  speciesRange: [number, number | null] | null;
  personalDeviation: 'unusual_low' | 'unusual_high' | 'normal';
}
```

Update `DeviceHealth`:

```ts
export interface DeviceHealth {
  status: DeviceHealthStatus;
  parameters: Partial<Record<ParameterKey, ParameterHealth>>;
  trend: HealthTrend;
  warningParameters: ParameterKey[];
}
```

In `computeDeviceHealth`, widen the first parameter's type:

```ts
export function computeDeviceHealth(
  device: Pick<Device, 'kind' | 'environment'>,
  readings: ReadingWithRawLog[],
  profile: PlantProfile | null,
  warmupMinDays: number,
  conductivityCalibration: ConductivityCalibration | null,
): DeviceHealth {
  if (!profile) {
    return { status: 'no_profile', parameters: {}, trend: 'unknown', warningParameters: [] };
  }
```

Replace the per-parameter loop body (currently computing `rawValue`, `recentValue`, `speciesRange`,
`status`, and setting `hasOutOfRange`) with:

```ts
  const parameters: Partial<Record<ParameterKey, ParameterHealth>> = {};
  let hasOutOfRange = false;
  const warningParameters: ParameterKey[] = [];

  for (const key of PARAMETERS_BY_KIND[device.kind]) {
    // Scoped to this one parameter (design spec, Part 4) — an under-calibrated conductivity sensor
    // never pushes the WHOLE device into 'warming_up', that status is a coarser, separate concept.
    if (key === 'soilConductivityUsCm' && conductivityCalibration?.calibrated !== true) {
      parameters[key] = { value: null, status: 'calibrating', speciesRange: null, personalDeviation: 'normal' };
      continue;
    }

    const rawValue = average(valuesFor(key, recentSource, conductivityCalibration));
    if (rawValue == null) continue;
    const recentValue = rawValue * (UNIT_CONVERSION[key] ?? 1);

    const { speciesRange, status } = resolveRangeAndStatus(key, recentValue, profile, device.environment);
    // Deliberately excluded from hasOutOfRange (2026-07-31, final-review follow-up): the
    // per-device conductivity calibration is a RELATIVE percentile within this device's own
    // observed raw range (always stretched to fill 0-1000, by construction), compared here
    // against ABSOLUTE µS/cm species thresholds — a scale mismatch already flagged as unresolved
    // even in WatchFlower's own reference app. Until the scale question is actually resolved
    // empirically, this parameter's status/value/speciesRange are still computed and shown on the
    // gauge (tone, hint) for information, but never flip the device's overall status.
    if (status !== 'ok' && status !== 'n/a' && key !== 'soilConductivityUsCm') {
      hasOutOfRange = true;
      warningParameters.push(key);
    }

    const personalDeviation = computePersonalDeviation(key, rawValue, sorted, recentSource, warmingUp, conductivityCalibration);

    parameters[key] = { value: recentValue, status, speciesRange, personalDeviation };
  }

  return {
    status: warmingUp ? 'warming_up' : hasOutOfRange ? 'warning' : 'ok',
    parameters,
    trend: computeTrend(sorted, device.kind),
    warningParameters,
  };
```

- [ ] **Step 5: Confirm the 3 call sites need no changes**

```bash
grep -n "computeDeviceHealth(" backend/src/health/scheduler.ts backend/src/api/trpc/routers/health.ts backend/src/mqtt/publisher.ts
```

Confirm each call passes a `device` variable that came from `prisma.device.findUnique`/`findMany`
with no field-selection restriction that would exclude `environment` (i.e. no `select: {...}`
narrowing it out). If any call site does restrict fields, add `environment: true` there — but as of
this plan's writing, none do.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter backend exec tsc --noEmit
```

Expect errors only in files not yet updated by this plan (frontend `types.ts`/`format.ts`/
`devices.$deviceId.tsx` — fixed in Tasks 3-4). If `backend` alone doesn't typecheck clean, fix
before proceeding.

- [ ] **Step 7: Manual verification — indoor luminosity floor and personal baseline**

Create `backend/scratch-verify-scoring.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { computeDeviceHealth } from './src/health/scoring.js';

const prisma = new PrismaClient();

async function main() {
  const profile = await prisma.plantProfile.upsert({
    where: { name: 'Scratch Verify Species' },
    create: { name: 'Scratch Verify Species', soilMoistureMinPercent: 15, soilMoistureMaxPercent: 60, lightMinMmol: 3000, lightMaxMmol: 6000 },
    update: {},
  });

  const device = await prisma.device.create({
    data: { id: 'SCRATCH-VERIFY-SCORING', kind: 'PARROT_POT', name: 'Scratch verify', environment: 'INDOOR', plantProfileId: profile.id },
  });

  const now = Date.now();
  // 20 days of readings: soilMoisture stable around 30%, luminosity a real indoor-like 0.1 mol/day
  // (100 mmol/day) — below every category floor (2000/5000/10000mmol), so must read too_low.
  const readingIds: number[] = [];
  for (let i = 20; i >= 1; i--) {
    const reading = await prisma.reading.create({
      data: {
        deviceId: device.id,
        source: 'POLL',
        timestamp: new Date(now - i * 24 * 3600_000),
        soilMoisturePercent: 30 + (i % 3), // small noise, stays well within a normal range
        luminosity: 0.1,
      },
    });
    readingIds.push(reading.id);
  }
  // One very recent, deliberately anomalous soil moisture reading (5%, way below this device's own
  // 30%-ish personal history but still >= the species min of 15%, so status stays 'ok').
  await prisma.reading.create({
    data: { deviceId: device.id, source: 'POLL', timestamp: new Date(now - 60_000), soilMoisturePercent: 16, luminosity: 0.1 },
  });

  const readings = await prisma.reading.findMany({ where: { deviceId: device.id }, orderBy: { timestamp: 'asc' }, include: { rawSensorLog: true } });
  const health = computeDeviceHealth(device, readings, profile, 3, null);
  console.log(JSON.stringify(health, null, 2));

  if (health.parameters.luminosity?.status !== 'too_low') throw new Error('Expected indoor luminosity too_low');
  if (health.parameters.luminosity?.speciesRange?.[1] !== null) throw new Error('Expected an open-ended (null) upper bound for indoor luminosity');
  if (health.parameters.soilMoisturePercent?.status !== 'ok') throw new Error('Expected soil moisture ok (16% >= species min 15%)');
  if (health.parameters.soilMoisturePercent?.personalDeviation !== 'unusual_low') {
    throw new Error(`Expected personalDeviation unusual_low for the 16% reading, got ${health.parameters.soilMoisturePercent?.personalDeviation}`);
  }
  if (!health.warningParameters.includes('luminosity')) throw new Error('Expected luminosity in warningParameters');
  if (health.warningParameters.includes('soilMoisturePercent')) throw new Error('soilMoisturePercent should not be in warningParameters (status is ok)');

  console.log('OK — indoor luminosity floor + personal baseline behave as expected');
  // No onDelete: Cascade on Reading.device in the schema — delete Readings before the Device row,
  // or this throws a foreign key constraint error. Device must be deleted before PlantProfile
  // (Device.plantProfileId references it).
  await prisma.reading.deleteMany({ where: { deviceId: device.id } });
  await prisma.device.delete({ where: { id: device.id } });
  await prisma.plantProfile.delete({ where: { id: profile.id } });
}

main().finally(() => prisma.$disconnect());
```

Run against a fresh scratch copy:

```bash
cp backend/prisma/dev.db /tmp/health-engine-verify.db
cd backend
DATABASE_URL="file:/tmp/health-engine-verify.db" pnpm exec tsx scratch-verify-scoring.ts
```

Expected: ends with `OK — indoor luminosity floor + personal baseline behave as expected`.

- [ ] **Step 8: Clean up scratch files**

```bash
rm backend/scratch-verify-scoring.ts /tmp/health-engine-verify.db
```

- [ ] **Step 9: Commit**

```bash
git add backend/src/health/scoring.ts
git commit -m "computeDeviceHealth: indoor luminosity floor comparison, personal baseline signal, warningParameters"
```

---

### Task 3: Frontend type mirroring + `healthHeadline` structural fix

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/lib/format.ts`

**Interfaces:**
- Consumes: the exact shapes produced by Task 2 (`ParameterHealth.personalDeviation`,
  `ParameterHealth.speciesRange: [number, number | null] | null`, `DeviceHealth.warningParameters:
  ParameterKey[]`).
- Produces: `healthHeadline` (internal to `format.ts`, not exported) no longer depends on
  `PARAMETERS_BY_KIND`'s array order.

- [ ] **Step 1: Mirror the new backend types**

In `frontend/src/lib/types.ts`, update `ParameterHealth` and `DeviceHealth`:

```ts
export interface ParameterHealth {
  value: number | null;
  status: ParameterStatus;
  speciesRange: [number, number | null] | null;
  personalDeviation: 'unusual_low' | 'unusual_high' | 'normal';
}

export type HealthTrend = 'stable' | 'degrading' | 'improving' | 'unknown';
export type DeviceHealthStatus = 'ok' | 'warning' | 'warming_up' | 'no_profile';

export interface DeviceHealth {
  status: DeviceHealthStatus;
  parameters: Partial<Record<ParameterKey, ParameterHealth>>;
  trend: HealthTrend;
  warningParameters: ParameterKey[];
}
```

- [ ] **Step 2: Fix `healthHeadline`'s ordering dependency**

In `frontend/src/lib/format.ts`, replace the `healthHeadline` function:

```ts
function healthHeadline(health: DeviceHealth | undefined): string | null {
  if (!health) return null;
  if (health.status === 'warming_up') return "Période d'observation en cours";
  if (health.status === 'warning') {
    const key = health.warningParameters[0];
    const param = key ? health.parameters[key] : undefined;
    if (!key || !param) return null;
    const label = PARAMETER_LABEL[key];
    return param.status === 'too_low' ? `${label} trop basse pour cette espèce` : `${label} trop élevée pour cette espèce`;
  }
  return null;
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter frontend exec tsc --noEmit
```

Expect remaining errors only in `devices.$deviceId.tsx` (its `rangeHint`/`referenceLinesFor` still
assume `[number, number]`, fixed in Task 4). If `format.ts`/`types.ts` themselves don't typecheck
clean, fix before proceeding.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/types.ts frontend/src/lib/format.ts
git commit -m "Mirror new Health Engine fields, fix healthHeadline's parameter-ordering dependency"
```

---

### Task 4: Gauge/badge visual consistency + open-ended range display

**Files:**
- Modify: `frontend/src/components/sensor-gauge.tsx`
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`

**Interfaces:**
- Consumes: `ParameterHealth.personalDeviation`/`speciesRange` from Task 2/3.
- Produces: `SensorGauge`'s `tone` prop gains `'notice'`. `toneFor()` gains an options parameter.
  `rangeHint()`/`referenceLinesFor()` handle a `null` upper bound.

- [ ] **Step 1: Add the `notice` tone to `SensorGauge`**

In `frontend/src/components/sensor-gauge.tsx`, update `TONE_VARS`:

```ts
const TONE_VARS = {
  primary: 'var(--color-teal-500)',
  accent: 'var(--color-spring-500)',
  info: 'var(--color-blue-500)',
  danger: 'var(--destructive)',
  warning: 'var(--warning-foreground)',
  notice: 'var(--color-muted-foreground)',
} as const;
```

- [ ] **Step 2: Update `toneFor`, `rangeHint`, `referenceLinesFor`**

In `frontend/src/routes/_authenticated/devices.$deviceId.tsx`, update the `GaugeTone` type and the
3 helper functions near the top of the file:

```ts
type GaugeTone = 'primary' | 'accent' | 'info' | 'danger' | 'warning' | 'notice';

function toneFor(param: ParameterHealth | undefined, fallback: GaugeTone, options: { informational?: boolean } = {}): GaugeTone {
  if (param?.status !== 'too_low' && param?.status !== 'too_high') return fallback;
  return options.informational ? 'notice' : 'warning';
}

// Species range displayed in the gauge legend — undefined if no species assigned or parameter
// not applicable (n/a) for this species. A null upper bound (indoor luminosity's floor-only
// comparison, see design spec Part B) renders as "≥ X" instead of "X–Y".
function rangeHint(param: ParameterHealth | undefined, unit: string, scale = 1): string | undefined {
  if (!param?.speciesRange) return undefined;
  const [min, max] = param.speciesRange;
  if (max == null) return `≥ ${Math.round(min / scale)}${unit} attendu`;
  return `${Math.round(min / scale)}–${Math.round(max / scale)}${unit} attendu`;
}

// Reference lines (min/max expected for the assigned species) displayed on the history
// chart — same source as rangeHint, undefined if no species assigned or parameter n/a. Omits the
// max line entirely when there's no upper bound (nothing meaningful to draw).
function referenceLinesFor(param: ParameterHealth | undefined, scale = 1): HistoryReferenceLine[] | undefined {
  if (!param?.speciesRange) return undefined;
  const [min, max] = param.speciesRange;
  const lines: HistoryReferenceLine[] = [{ value: min / scale, label: 'Min attendu' }];
  if (max != null) lines.push({ value: max / scale, label: 'Max attendu' });
  return lines;
}
```

- [ ] **Step 3: Add a `personalDeviation` hint helper**

In the same file, right after `referenceLinesFor`, add:

```ts
// "Inhabituel pour cette plante" signal (design spec Part C) — additive to the existing
// species-range hint, never replaces it, and never changes the gauge's tone (personalDeviation is
// purely informational, same visual register as the conductivity notice below).
function personalDeviationHint(param: ParameterHealth | undefined): string | undefined {
  if (param?.personalDeviation === 'unusual_low') return 'Inhabituel (bas) pour cette plante';
  if (param?.personalDeviation === 'unusual_high') return 'Inhabituel (élevé) pour cette plante';
  return undefined;
}
```

- [ ] **Step 4: Wire the conductivity gauge to the `notice` tone + explanatory hint**

Find the conductivity `SensorGauge` (inside the `techOpen &&` block, `reading.soilConductivityUsCm
!= null && (...)`) and replace it with:

```tsx
reading.soilConductivityUsCm != null && (
  <SensorGauge
    label="Fertilité du sol"
    value={reading.soilConductivityUsCm}
    max={1000}
    unit=" µS/cm"
    tone={toneFor(health?.parameters.soilConductivityUsCm, 'primary', { informational: true })}
    icon={<Sprout size={16} />}
    hint={[
      rangeHint(health?.parameters.soilConductivityUsCm, ' µS/cm'),
      (health?.parameters.soilConductivityUsCm?.status === 'too_low' ||
        health?.parameters.soilConductivityUsCm?.status === 'too_high') &&
        "n'affecte pas le statut global",
      personalDeviationHint(health?.parameters.soilConductivityUsCm),
    ]
      .filter(Boolean)
      .join(' · ')}
  />
)
```

- [ ] **Step 5: Add the `personalDeviation` hint to every other gauge**

For each of the remaining 5 `SensorGauge` calls in this file (soil moisture, temperature ×2 — Parrot
and Xiaomi, luminosity, humidity), extend the existing `hint` prop to include
`personalDeviationHint(...)`. Example for soil moisture (already has a 2-part hint):

```tsx
hint={[
  rangeHint(health?.parameters.soilMoisturePercent, '%'),
  trendParameterKey === 'soilMoisturePercent' && trendHint,
  personalDeviationHint(health?.parameters.soilMoisturePercent),
]
  .filter(Boolean)
  .join(' · ')}
```

Example for temperature (currently a 1-line `hint`):

```tsx
hint={[rangeHint(health?.parameters.temperatureC, '°'), personalDeviationHint(health?.parameters.temperatureC)]
  .filter(Boolean)
  .join(' · ')}
```

Apply the same `[existing hint expression, personalDeviationHint(...)].filter(Boolean).join(' · ')`
pattern to the luminosity gauge (`health?.parameters.luminosity`) and the Xiaomi humidity gauge
(`health?.parameters.humidityPercent`), reusing whatever hint expression each already has as the
first array element.

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter frontend exec tsc --noEmit
```

Expect a clean pass across the whole `frontend` package now.

- [ ] **Step 7: Manual verification — run the dev server against the mock provider**

```bash
pnpm --filter backend dev
```

(Ensure `.env`'s `BLE_PROVIDER` — or equivalent — is set to `mock`, matching every other batch's
verification approach in this project.) In a second terminal:

```bash
pnpm --filter frontend dev
```

Log in with the existing dev admin account (`admin@admin.com` / `admin`, per CLAUDE.md's "Permanent
local dev admin account" note), open a Parrot Pot device detail page with a species assigned, expand
"Détails techniques", and confirm:
- The conductivity gauge (if not `calibrating`) never shows the orange `warning` color, even if its
  status is `too_low`/`too_high` — confirm visually it's a distinct muted tone.
- Its hint text includes "n'affecte pas le statut global" whenever its status is out of range.
- Set the device's environment to "Intérieur" (via the edit-device dialog) if a species with a
  defined light range is assigned — confirm the luminosity gauge's hint reads "≥ X mol/m²/j attendu"
  (open-ended, no "–Y").

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/sensor-gauge.tsx frontend/src/routes/_authenticated/devices.\$deviceId.tsx
git commit -m "Frontend: notice tone for informational-only gauges, personal-deviation hints, open-ended range display"
```

---

### Task 5: Prune stale `namedDevicePoller` Map entries on device deletion

**Files:**
- Modify: `backend/src/ble/namedDevicePoller.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no interface change — `startNamedDevicePoller`'s exported signature is unchanged.

- [ ] **Step 1: Prune `lastPolled`/`consecutiveFailures` at the start of each tick**

In `backend/src/ble/namedDevicePoller.ts`, inside `startNamedDevicePoller`'s `setInterval` callback,
right after `const devices = await prisma.device.findMany({ where: { name: { not: null } } });`,
add:

```ts
      // Devices deleted since the last tick would otherwise leak their entries in these Maps
      // forever (negligible at this project's real scale, but a one-line-cost fix — external
      // review finding, cross-checked and confirmed 2026-07-31).
      const currentDeviceIds = new Set(devices.map((device) => device.id));
      for (const id of lastPolled.keys()) {
        if (!currentDeviceIds.has(id)) lastPolled.delete(id);
      }
      for (const id of consecutiveFailures.keys()) {
        if (!currentDeviceIds.has(id)) consecutiveFailures.delete(id);
      }
```

(This goes between the `devices` query and the existing `for (const device of devices) { ... }`
loop.)

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter backend exec tsc --noEmit
```

- [ ] **Step 3: Manual verification**

Create `backend/scratch-verify-poller-pruning.ts`:

```ts
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // This test exercises the pruning logic directly (copy-pasted, since the Maps in
  // namedDevicePoller.ts are module-private and the poller itself runs on a 15s setInterval not
  // worth waiting on in a scratch script).
  const lastPolled = new Map<string, number>([['GHOST-DEVICE', Date.now()], ['REAL-DEVICE', Date.now()]]);
  const consecutiveFailures = new Map<string, number>([['GHOST-DEVICE', 2]]);

  await prisma.device.create({ data: { id: 'REAL-DEVICE', kind: 'PARROT_POT', name: 'Real' } });
  const devices = await prisma.device.findMany({ where: { name: { not: null } } });

  const currentDeviceIds = new Set(devices.map((device) => device.id));
  for (const id of lastPolled.keys()) if (!currentDeviceIds.has(id)) lastPolled.delete(id);
  for (const id of consecutiveFailures.keys()) if (!currentDeviceIds.has(id)) consecutiveFailures.delete(id);

  if (lastPolled.has('GHOST-DEVICE')) throw new Error('GHOST-DEVICE should have been pruned from lastPolled');
  if (consecutiveFailures.has('GHOST-DEVICE')) throw new Error('GHOST-DEVICE should have been pruned from consecutiveFailures');
  if (!lastPolled.has('REAL-DEVICE')) throw new Error('REAL-DEVICE should NOT have been pruned');

  console.log('OK — pruning logic removes deleted devices, keeps real ones');
  await prisma.device.delete({ where: { id: 'REAL-DEVICE' } });
}

main().finally(() => prisma.$disconnect());
```

```bash
cp backend/prisma/dev.db /tmp/health-engine-verify.db
cd backend
DATABASE_URL="file:/tmp/health-engine-verify.db" pnpm exec tsx scratch-verify-poller-pruning.ts
rm scratch-verify-poller-pruning.ts /tmp/health-engine-verify.db
```

Expected: `OK — pruning logic removes deleted devices, keeps real ones`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/ble/namedDevicePoller.ts
git commit -m "namedDevicePoller: prune lastPolled/consecutiveFailures Map entries for deleted devices"
```

---

### Task 6: Update `docs/HEALTH_ENGINE.md` and `CLAUDE.md`

**Files:**
- Modify: `docs/HEALTH_ENGINE.md`
- Modify: `CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add an indoor-luminosity subsection to `HEALTH_ENGINE.md`**

In `docs/HEALTH_ENGINE.md`, right after the existing "Special case — luminosity (unit conversion)"
paragraph (inside section "2. Comparison to the species range"), add:

```markdown
**Special case — indoor luminosity (2026-07-31)**: the WatchFlower CSV's light thresholds are
garden/outdoor-oriented (typically 2-7.5 mol/m²/day minimums). A real production Parrot Pot placed
indoors reads as low as 0.1 mol/m²/day — two orders of magnitude below those thresholds — which
would make luminosity structurally always `too_low` regardless of actual plant health. When
`Device.environment === 'INDOOR'`, the comparison switches to a **floor-only** check (never
`too_high`) against a published general houseplant DLI category (low/medium/high, 2/5/10
mol/m²/day) derived from the species' own outdoor minimum — not a per-species indoor value, since no
such dataset exists anywhere (WatchFlower, the official Parrot app, or any of the other Flower Power
repos surveyed). `OUTDOOR` and unset (`null`, the default) devices are unaffected.
```

- [ ] **Step 2: Add a personal-baseline subsection**

Right after the "'Warm-up' period" paragraph (end of section "Source #2 — the per-device rolling
baseline"), add:

```markdown
**Personal-deviation signal (2026-07-31)**: every parameter also gets a `personalDeviation`
(`'unusual_low' | 'unusual_high' | 'normal'`) computed against this specific device's own history
(mean ± 2 standard deviations over the baseline window, excluding the same recent-hour slice being
evaluated) — separate from, and never influencing, the `ok`/`too_low`/`too_high` status above or the
auto-watering scheduler. Requires at least 5 historical points outside the recent window; stays
`'normal'` during warm-up or with too little history. Purely informational (shown as a gauge hint),
answering "is this unusual for THIS plant" independently of "is this outside the species' general
range."
```

- [ ] **Step 3: Update the "What isn't done yet" section**

Replace the first bullet of "What isn't done yet (known limitations, not bugs)" (the one starting
"The rolling baseline isn't yet used to compute the `ok`/`too_low`/`too_high` status itself") with:

```markdown
- **The rolling baseline still doesn't drive the `ok`/`too_low`/`too_high` status itself** — as of
  2026-07-31 it exists as a separate, additive `personalDeviation` signal (see above), deliberately
  kept out of the coarse status and the auto-watering scheduler given the real-world consequence of
  changing when watering triggers. Fully merging the two (species range as a coarse guardrail,
  personal baseline as the actual day-to-day comparison) remains a possible future step once real
  production behavior has been observed long enough to validate it.
```

Also correct the (now false) `isInAir` bullet — it currently claims this filtering "isn't
implemented yet" and is "not added preemptively", but `computeDeviceHealth` has filtered
`isInAir === true` readings out of scoring since Batch 6 (`scoring.ts`'s `sorted = readings.filter
((reading) => reading.isInAir !== true)...`). Remove that bullet entirely (it's stale, unrelated to
this batch's work, found while editing the adjacent section).

- [ ] **Step 4: Add a dated entry to the conductivity history section**

At the end of the "Soil conductivity / fertility index — history (resolved 2026-07-30)" section in
`HEALTH_ENGINE.md`, add:

```markdown

**2026-07-31 update — self-calibration, then percentile bounds**: the fixed WatchFlower constants
above were replaced by a per-device calibration derived from real accumulated `RawSensorLog` history
(`backend/src/health/soilConductivityCalibration.ts`, gated on 14+ days of history and a raw spread
of 50+ before trusting it — reports `'calibrating'` until then). Initially this used the device's
all-time raw min/max; refined the same day to the 5th/95th percentile instead, so a single spurious
raw reading can't permanently redefine the whole 0-1000 scale and silently reshape historical chart
values — it now just clamps at the extreme end instead.
```

- [ ] **Step 5: Add a Project status entry to `CLAUDE.md`**

In `CLAUDE.md`'s "Project status (by batch)" section, after the most recent entry ("Soil
conductivity self-calibration + full raw sensor log"), add a new entry:

```markdown
- **Health Engine consistency fixes** ✅ (2026-07-31) — an independent audit of the Health Engine, run
  deliberately without reading project documentation (code + real `dev.db` data + the decompiled
  official Parrot app only, DestCom's explicit request), found 5 issues; a 6th, unrelated but minor
  finding from an external (non-DestCom, non-this-assistant) review of the wider codebase was
  cross-checked against the real code and folded in alongside them (most of that external review's
  other claims either restated already-known/correct behavior or were themselves mistaken — e.g. a
  claimed "duplicate poll" bug in `namedDevicePoller.ts` that doesn't exist, the code's actual
  ordering exists specifically to prevent that). Full design in
  `docs/superpowers/specs/2026-07-31-health-engine-consistency-fixes-design.md`.
  - **Indoor luminosity floor comparison**: `Device.environment === 'INDOOR'` now switches the
    luminosity comparison to a floor-only check against a published low/medium/high-light houseplant
    DLI category (2/5/10 mol/m²/day, derived from the species' own outdoor CSV minimum) instead of
    the outdoor-oriented CSV range directly — a real production Parrot Pot reads as low as 0.1
    mol/m²/day, structurally `too_low` forever against the CSV's typical 2-7.5 mol/day minimums.
    `OUTDOOR`/unset devices unaffected.
  - **Personal-deviation signal**: `ParameterHealth` gained `personalDeviation`
    (`'unusual_low'/'unusual_high'/'normal'`, mean ± 2σ against the device's own history, excluding
    the recent-hour slice) — additive/display-only, deliberately never influencing `status`,
    `hasOutOfRange`, or `health/scheduler.ts`'s auto-watering trigger (confirmed explicitly with
    DestCom given the real-world consequence of loosening that condition).
  - **Conductivity calibration**: bounds switched from the device's all-time absolute raw min/max to
    the 5th/95th percentile — an isolated spurious raw reading can no longer permanently redefine the
    whole 0-1000 output scale and silently reshape historical chart values.
  - **`DeviceHealth.warningParameters`**: the frontend's `healthHeadline` (`format.ts`) used to pick
    the first `too_low`/`too_high` parameter via `Object.entries(...).find(...)`, silently relying on
    `PARAMETERS_BY_KIND`'s array order to avoid surfacing conductivity (excluded from the badge) as a
    warning's cause. `computeDeviceHealth` now exposes the authoritative list directly.
  - **Frontend**: new `SensorGauge` `notice` tone (muted, distinct from the orange `warning`) for
    informational-only out-of-range parameters (conductivity today) plus a `personalDeviationHint`
    shown on every gauge; `rangeHint`/`referenceLinesFor` handle an open-ended (`null`) upper bound
    for the indoor-luminosity case.
  - **`namedDevicePoller.ts`**: `lastPolled`/`consecutiveFailures` Maps now pruned of deleted devices
    on every tick (the one legitimate finding from the external review).
  - **Verified**: all changes are pure computation/UI logic, no new migration. Backend logic verified
    via scratch-copy-of-`dev.db` scripts (percentile calibration resists an outlier, indoor
    luminosity floor + personal baseline behave as expected, poller pruning removes only deleted
    devices); frontend verified against the mock provider in a real browser session (notice tone,
    explanatory hint text, open-ended range display).
```

- [ ] **Step 6: Commit**

```bash
git add docs/HEALTH_ENGINE.md CLAUDE.md
git commit -m "Document Health Engine consistency fixes in HEALTH_ENGINE.md and CLAUDE.md"
```

---

## Self-Review Notes (completed during planning)

- **Spec coverage**: Part A (no-op, verified by construction — outdoor/null environment path
  untouched) / Part B → Task 2 Steps 1-2, 7 / Part C → Task 2 Step 3, 7 / Part D → Task 1 / Part E →
  Task 4 / Part F → Task 2 Step 4, Task 3 Step 2 / Part G → Task 5. All 7 spec parts covered.
- **Type consistency checked**: `ParameterHealth`/`DeviceHealth` field names and shapes match
  identically between Task 2 (backend) and Task 3 (frontend mirror) — `personalDeviation`,
  `warningParameters`, `speciesRange: [number, number | null] | null` used consistently across all 4
  tasks that touch them (2, 3, 4).
- **`Infinity`-over-JSON risk caught during planning** (not in the original spec, which illustrated
  the open-ended bound as `Number.POSITIVE_INFINITY`): fixed to use `null` instead, documented in
  Global Constraints above.
