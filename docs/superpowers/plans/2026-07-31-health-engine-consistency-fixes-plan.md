# Health Engine Consistency Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 5 audit findings + 1 externally-sourced finding + 2 empirically-discovered findings
(Part H and Part I, added 2026-08-03) in the StroyPlant Health Engine (indoor luminosity comparison,
missing personal baseline, non-robust conductivity calibration, gauge/badge visual inconsistency,
fragile parameter-ordering dependency, unbounded poller Maps, the luminosity comparison's input
being an instantaneous reading compared against a daily threshold at any time of day — Part H — and,
Part I, an unrelated Plant Dr calibration finding folded into this same plan at DestCom's request:
`calibrateWet` accepting a physically implausible captured value with no upper sanity bound) per
`docs/superpowers/specs/2026-07-31-health-engine-consistency-fixes-design.md`.

**Architecture:** Parts A-G are pure computation/UI logic over existing tables — no new Prisma
migration, no config changes. Part H (Tasks 7-11) is the one exception: a new `HealthSettings.timezone`
column, a new standalone algorithm file (`health/dailyLightIntegral.ts`), and further changes to the
same files Parts A-G already touch. Part I (Task 12) is a single, independent guard added to
`api/trpc/routers/plantDr.ts` — unrelated to the Health Engine itself, no shared code with Parts
A-H. Backend changes land first (`health/scoring.ts`, `health/soilConductivityCalibration.ts`,
`health/dailyLightIntegral.ts`, `health/settings.ts`, `ble/namedDevicePoller.ts`,
`api/trpc/routers/plantDr.ts`), then frontend consumption (`frontend/src/lib/types.ts`, `format.ts`,
`devices.$deviceId.tsx`, `sensor-gauge.tsx`, `health-engine-settings-section.tsx`), then docs.

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
- No new Prisma migration for Parts A-G. No new env vars / `HealthSettings` fields for Tasks 1-6
  (all new thresholds are plain exported constants, matching this codebase's existing YAGNI stance
  for `MIN_CALIBRATION_DAYS`/`MIN_CALIBRATION_RAW_RANGE`). **Part H (Tasks 7-11) is the one
  exception**: `HealthSettings` gains a `timezone` column (migration required, default `"UTC"`) —
  confirmed with DestCom as worth the exception, since day boundaries are meaningless without it.
  Part H's own gap/advisory thresholds (`MAX_GAP_MS`, the 3-day advisory window) stay plain exported
  constants, same YAGNI stance as everywhere else.
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
pnpm --filter frontend exec tsc -b --noEmit
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
pnpm --filter frontend exec tsc -b --noEmit
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

### Task 7: `HealthSettings.timezone` — migration + settings.ts

**Files:**
- Modify: `backend/prisma/schema.prisma`
- Modify: `backend/src/health/settings.ts`

**Interfaces:**
- Produces: `HealthSettingsValues` gains `timezone: string`. `getHealthSettings()`/
  `upsertHealthSettings()` keep their exact existing exported names/call shape, just carry the new
  field — every existing call site (`health/scheduler.ts:55`, `api/trpc/routers/health.ts:50`,
  `mqtt/publisher.ts:29`, `api/trpc/routers/health.ts`'s `upsertSettings` procedure) keeps compiling
  unchanged; Task 9 is the one that actually reads `.timezone` off the result.
- `upsertHealthSettings` now throws a plain `Error` (not a `TRPCError` — this file has no tRPC
  dependency today and shouldn't gain one just for this) if `timezone` isn't a value the JS `Intl`
  API accepts. The tRPC router (Task 10) wraps this in a way the frontend can show as a form error.

- [ ] **Step 1: Add the `timezone` column to `HealthSettings`**

In `backend/prisma/schema.prisma`, update `model HealthSettings`:

```prisma
model HealthSettings {
  id                 Int      @id @default(1)
  baselineWindowDays Int      @default(14)
  warmupMinDays      Int      @default(3)
  // IANA timezone name (e.g. "Europe/Paris"), used only by health/dailyLightIntegral.ts to decide
  // calendar-day boundaries for the luminosity daily light integral (Part H, 2026-08-03 design spec
  // addition). Defaults to UTC — the server's own timezone, and this project's convention everywhere
  // else (no other file has ever needed timezone awareness before this).
  timezone           String   @default("UTC")
  updatedAt          DateTime @updatedAt
}
```

- [ ] **Step 2: Generate and apply the migration**

```bash
cd backend
pnpm exec prisma migrate dev --name add_health_settings_timezone
```

Expected: a new `backend/prisma/migrations/<timestamp>_add_health_settings_timezone/migration.sql`
is created and applied to `dev.db`, containing an `ALTER TABLE "HealthSettings" ADD COLUMN
"timezone" TEXT NOT NULL DEFAULT 'UTC';` (SQLite adds columns via `ALTER TABLE`, not a table
rebuild, since this is a single nullable-with-default column — Prisma will confirm this is a safe,
non-destructive change before applying).

- [ ] **Step 3: Update `health/settings.ts`**

Replace the whole file:

```ts
import { prisma } from '../db/client.js';

const SETTINGS_ID = 1;

export interface HealthSettingsValues {
  baselineWindowDays: number;
  warmupMinDays: number;
  // IANA timezone name, used by health/dailyLightIntegral.ts's calendar-day grouping (Part H).
  timezone: string;
}

const DEFAULTS: HealthSettingsValues = { baselineWindowDays: 14, warmupMinDays: 3, timezone: 'UTC' };

// Validates a string is a real IANA timezone the JS Intl API accepts — the one place this matters,
// since an invalid value would silently make health/dailyLightIntegral.ts's Intl.DateTimeFormat
// call throw for every device's luminosity scoring, not just fail to save. Validated here (the
// single choke point every caller, including the tRPC mutation, goes through) rather than at the
// call site, per the project's "validate at system boundaries" convention.
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function getHealthSettings(): Promise<HealthSettingsValues> {
  const settings = await prisma.healthSettings.findUnique({ where: { id: SETTINGS_ID } });
  return settings
    ? { baselineWindowDays: settings.baselineWindowDays, warmupMinDays: settings.warmupMinDays, timezone: settings.timezone }
    : DEFAULTS;
}

export async function upsertHealthSettings(values: HealthSettingsValues): Promise<HealthSettingsValues> {
  if (!isValidTimezone(values.timezone)) {
    throw new Error(`Invalid IANA timezone: "${values.timezone}"`);
  }
  const settings = await prisma.healthSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...values },
    update: values,
  });
  return { baselineWindowDays: settings.baselineWindowDays, warmupMinDays: settings.warmupMinDays, timezone: settings.timezone };
}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter backend exec tsc --noEmit
```

Expect errors only in call sites Task 9 hasn't updated yet (none — `HealthSettingsValues` widening
with a new required field doesn't break any existing caller, since they all just spread/read
existing fields, never construct a literal `HealthSettingsValues` themselves except `DEFAULTS`
above and the tRPC `upsertSettings` input, which Task 10 updates). If anything else fails to
compile, fix before proceeding.

- [ ] **Step 5: Manual verification — default value and rejection of an invalid timezone**

Create `backend/scratch-verify-timezone-settings.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { getHealthSettings, upsertHealthSettings } from './src/health/settings.js';

const prisma = new PrismaClient();

async function main() {
  const defaults = await getHealthSettings();
  if (defaults.timezone !== 'UTC') throw new Error(`Expected default timezone UTC, got ${defaults.timezone}`);

  const saved = await upsertHealthSettings({ baselineWindowDays: 14, warmupMinDays: 3, timezone: 'Europe/Paris' });
  if (saved.timezone !== 'Europe/Paris') throw new Error('Expected timezone to round-trip as Europe/Paris');

  let rejected = false;
  try {
    await upsertHealthSettings({ baselineWindowDays: 14, warmupMinDays: 3, timezone: 'Not/AZone' });
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error('Expected an invalid timezone to be rejected');

  console.log('OK — timezone defaults to UTC, round-trips, rejects an invalid IANA name');
  // Reset to the default so this scratch run leaves no residue on the real dev.db.
  await upsertHealthSettings({ baselineWindowDays: defaults.baselineWindowDays, warmupMinDays: defaults.warmupMinDays, timezone: 'UTC' });
}

main().finally(() => prisma.$disconnect());
```

```bash
cd backend
pnpm exec tsx scratch-verify-timezone-settings.ts
rm scratch-verify-timezone-settings.ts
```

Expected: ends with `OK — timezone defaults to UTC, round-trips, rejects an invalid IANA name`. This
one runs against the real `dev.db` (not a scratch copy) since it resets state at the end — safe
because `HealthSettings` is a singleton row every other task already reads/writes the same way.

- [ ] **Step 6: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/health/settings.ts
git commit -m "HealthSettings: add timezone field (Part H, daily light integral day boundaries)"
```

---

### Task 8: `health/dailyLightIntegral.ts` — trapezoidal daily light integral

**Files:**
- Create: `backend/src/health/dailyLightIntegral.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks — pure function over plain data, independently testable.
- Produces: `computeDailyTotals(readings: Pick<Reading, 'timestamp' | 'luminosity'>[], timezone:
  string): DailyLightTotal[]`, `interface DailyLightTotal { date: string; totalMol: number }`,
  `MAX_GAP_MS` (exported constant, 2 hours in ms) — all consumed by Task 9.

- [ ] **Step 1: Write `dailyLightIntegral.ts`**

```ts
import type { Reading } from '@prisma/client';

// Gap threshold (design spec Part H, step 3): a calendar day is only "complete and usable" if no
// gap between two consecutive readings within it exceeds this — otherwise the whole day is dropped
// (treated like missing data, never partially trusted). At the default 5-minute poll interval this
// tolerates a couple of missed cycles without over-rejecting; a real multi-hour BLE/device outage
// correctly excludes that day instead of silently producing a truncated, misleadingly-low total.
export const MAX_GAP_MS = 2 * 3600_000;

export interface DailyLightTotal {
  // Calendar date in the given timezone, "YYYY-MM-DD".
  date: string;
  // True accumulated light for that day, in mol/m² (same unit as the raw `luminosity` reading) —
  // NOT yet multiplied by scoring.ts's UNIT_CONVERSION (that happens at the call site, same as
  // every other raw value scoring.ts converts).
  totalMol: number;
}

type LightReading = Pick<Reading, 'timestamp' | 'luminosity'>;

// "YYYY-MM-DD" in the given IANA timezone — the en-CA locale is a standard trick for getting
// Intl.DateTimeFormat to produce ISO-ordered digits directly, no manual string reassembly needed.
function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Real per-device daily light integral (design spec Part H) — replaces treating the Parrot Pot's
// `39e1fa0b` characteristic as if it were already a true accumulated daily total. Real production
// data (2 real Parrot Pots, 5 days) showed it's actually an INSTANTANEOUS light-derived reading
// expressed in mol/m²/day-equivalent units: flat ~0.1 floor overnight, sharp solar-noon peak
// (~70 observed), back to floor by evening. Two consecutive instantaneous rate samples r1 at t1 and
// r2 at t2 (same units, mol/m²/day) integrate via the trapezoidal rule: the light received between
// them is the average rate times the elapsed FRACTION OF A DAY, `((r1+r2)/2) * ((t2-t1)/86_400_000)`
// — summing this across a whole calendar day's consecutive pairs gives that day's true total mol/m²
// received, which is what should actually be compared against a species' daily light threshold.
//
// Returns only fully "complete" days (see MAX_GAP_MS above), most-recent-first, and NEVER includes
// the current, still-in-progress calendar day (in `timezone`) — a day that hasn't ended yet cannot
// be a complete measurement by definition, no matter how dense its readings so far are. The partial
// interval before a day's first reading and after its last reading is not counted (edge trapezoids
// dropped) — both edges sit in the flat overnight floor in every real observation so far, so the
// error this introduces is negligible in practice.
export function computeDailyTotals(readings: LightReading[], timezone: string): DailyLightTotal[] {
  const points = readings
    .filter((reading): reading is LightReading & { luminosity: number } => reading.luminosity != null)
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const byDay = new Map<string, Array<{ timestamp: Date; luminosity: number }>>();
  for (const point of points) {
    const key = dayKey(point.timestamp, timezone);
    const dayPoints = byDay.get(key);
    if (dayPoints) dayPoints.push(point);
    else byDay.set(key, [point]);
  }

  const todayKey = dayKey(new Date(), timezone);
  const totals: DailyLightTotal[] = [];

  for (const [date, dayPoints] of byDay) {
    if (date === todayKey) continue; // never a "complete" day — it hasn't ended yet
    if (dayPoints.length < 2) continue; // nothing to integrate between

    let totalMol = 0;
    let hasExcessiveGap = false;
    for (let i = 1; i < dayPoints.length; i++) {
      const prev = dayPoints[i - 1];
      const cur = dayPoints[i];
      const gapMs = cur.timestamp.getTime() - prev.timestamp.getTime();
      if (gapMs > MAX_GAP_MS) {
        hasExcessiveGap = true;
        break;
      }
      const elapsedDayFraction = gapMs / 86_400_000;
      totalMol += ((prev.luminosity + cur.luminosity) / 2) * elapsedDayFraction;
    }
    if (hasExcessiveGap) continue;

    totals.push({ date, totalMol });
  }

  return totals.sort((a, b) => (a.date < b.date ? 1 : -1));
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter backend exec tsc --noEmit
```

- [ ] **Step 3: Manual verification — a synthetic day/night cycle, a gap-excluded day, and today's exclusion**

Create `backend/scratch-verify-daily-light-integral.ts`:

```ts
import { computeDailyTotals } from './src/health/dailyLightIntegral.js';

function reading(isoTimestamp: string, luminosity: number) {
  return { timestamp: new Date(isoTimestamp), luminosity };
}

// Day 1 (2026-01-01, UTC): a clean synthetic sun curve — flat 0.1 overnight, ramps to a 70 peak at
// noon, back to 0.1 by evening, sampled every 3 hours (well under MAX_GAP_MS). Trapezoidal
// integration of a symmetric ramp-up/ramp-down triangle-ish shape should land well above 1 mol/m²
// (the point of this test is "clearly not 0.1 mol and not 70 mol either" — a mid-range plausible
// day total, not an exact hand-computed figure).
const day1 = [
  reading('2026-01-01T00:00:00Z', 0.1),
  reading('2026-01-01T03:00:00Z', 0.1),
  reading('2026-01-01T06:00:00Z', 0.5),
  reading('2026-01-01T09:00:00Z', 5),
  reading('2026-01-01T12:00:00Z', 70),
  reading('2026-01-01T15:00:00Z', 5),
  reading('2026-01-01T18:00:00Z', 0.5),
  reading('2026-01-01T21:00:00Z', 0.1),
];

// Day 2 (2026-01-02, UTC): otherwise identical, but with a 5-hour gap in the afternoon (exceeds
// MAX_GAP_MS=2h) — this whole day must be excluded entirely, not partially counted.
const day2 = [
  reading('2026-01-02T00:00:00Z', 0.1),
  reading('2026-01-02T06:00:00Z', 0.5),
  reading('2026-01-02T09:00:00Z', 5),
  reading('2026-01-02T12:00:00Z', 70),
  reading('2026-01-02T17:00:00Z', 5), // 5h after the previous point — exceeds the 2h gate
  reading('2026-01-02T21:00:00Z', 0.1),
];

// "Today" — deliberately using the real current time, mirroring how computeDeviceHealth will call
// this with real, current readings — must never appear in the result no matter how dense.
const today = Array.from({ length: 20 }, (_, i) => reading(new Date(Date.now() - i * 3600_000).toISOString(), 3));

const totals = computeDailyTotals([...day1, ...day2, ...today], 'UTC');
console.log(JSON.stringify(totals, null, 2));

const dates = totals.map((t) => t.date);
if (dates.includes('2026-01-02')) throw new Error('2026-01-02 should have been excluded (5h gap)');
if (dates.some((d) => d === new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(new Date()))) {
  throw new Error("today's date should never appear in the result");
}
const jan1 = totals.find((t) => t.date === '2026-01-01');
if (!jan1) throw new Error('2026-01-01 should be present (no gap exceeds 2h)');
if (jan1.totalMol <= 0.1 * 1 || jan1.totalMol >= 70) {
  throw new Error(`2026-01-01 totalMol (${jan1.totalMol}) should be well between the overnight floor and the noon peak, not near either extreme`);
}

console.log('OK — day/night integration plausible, gapped day excluded, today never included');
```

```bash
cd backend
pnpm exec tsx scratch-verify-daily-light-integral.ts
rm scratch-verify-daily-light-integral.ts
```

Expected: ends with `OK — day/night integration plausible, gapped day excluded, today never
included`.

- [ ] **Step 4: Commit**

```bash
git add backend/src/health/dailyLightIntegral.ts
git commit -m "Add computeDailyTotals: trapezoidal daily light integral (Part H)"
```

---

### Task 9: `scoring.ts` — luminosity uses the daily integral, not the hourly instantaneous average

**Files:**
- Modify: `backend/src/health/scoring.ts`
- Modify: `backend/src/health/scheduler.ts`
- Modify: `backend/src/api/trpc/routers/health.ts`
- Modify: `backend/src/mqtt/publisher.ts`

**Interfaces:**
- Consumes: `computeDailyTotals`/`DailyLightTotal` from Task 8. `HealthSettingsValues.timezone`
  from Task 7.
- Produces: `ParameterHealth` gains `liveValue: number | null` (always `null` except for
  `luminosity`). `DeviceHealth` gains `luminosityRecentDaysTooLow: boolean`. `computeDeviceHealth`
  gains a 6th parameter, `timezone: string`.

- [ ] **Step 1: Import `computeDailyTotals` and widen the types**

In `backend/src/health/scoring.ts`, add near the top:

```ts
import { computeDailyTotals } from './dailyLightIntegral.js';
```

Update `ParameterHealth` and `DeviceHealth` (from Task 2's version):

```ts
export interface ParameterHealth {
  value: number | null;
  status: ParameterStatus;
  speciesRange: [number, number | null] | null;
  personalDeviation: 'unusual_low' | 'unusual_high' | 'normal';
  // Live instantaneous reading (mmol/m²/day, same conversion as `value`) — informational only,
  // never used for `status`. Always null except for `luminosity` (Part H, design spec step 5): the
  // gauge still shows "what the light level looks like right now" alongside the daily-total-based
  // value/status, since the daily total is only ever as fresh as yesterday.
  liveValue: number | null;
}

export interface DeviceHealth {
  status: DeviceHealthStatus;
  parameters: Partial<Record<ParameterKey, ParameterHealth>>;
  trend: HealthTrend;
  warningParameters: ParameterKey[];
  // True iff the 3 most recent COMPLETE calendar days were all too_low on luminosity (Part H, design
  // spec step 6) — drives the frontend's "move the plant" advisory. False (never true) for Xiaomi
  // devices, which have no luminosity parameter at all, and for any device with fewer than 3
  // complete days of luminosity history.
  luminosityRecentDaysTooLow: boolean;
}
```

- [ ] **Step 2: Widen `computeDeviceHealth`'s signature and handle the no-profile early return**

```ts
export function computeDeviceHealth(
  device: Pick<Device, 'kind' | 'environment'>,
  readings: ReadingWithRawLog[],
  profile: PlantProfile | null,
  warmupMinDays: number,
  conductivityCalibration: ConductivityCalibration | null,
  timezone: string,
): DeviceHealth {
  if (!profile) {
    return { status: 'no_profile', parameters: {}, trend: 'unknown', warningParameters: [], luminosityRecentDaysTooLow: false };
  }
```

- [ ] **Step 3: Special-case `luminosity` in the per-parameter loop**

Replace the per-parameter loop body (the version Task 2 produced) with:

```ts
  const parameters: Partial<Record<ParameterKey, ParameterHealth>> = {};
  let hasOutOfRange = false;
  const warningParameters: ParameterKey[] = [];
  let luminosityRecentDaysTooLow = false;

  for (const key of PARAMETERS_BY_KIND[device.kind]) {
    // Scoped to this one parameter (design spec, Part 4) — an under-calibrated conductivity sensor
    // never pushes the WHOLE device into 'warming_up', that status is a coarser, separate concept.
    if (key === 'soilConductivityUsCm' && conductivityCalibration?.calibrated !== true) {
      parameters[key] = { value: null, status: 'calibrating', speciesRange: null, personalDeviation: 'normal', liveValue: null };
      continue;
    }

    // Luminosity (Part H, 2026-08-03): the daily total (last COMPLETE calendar day, in `timezone`)
    // replaces the hourly-average instantaneous value as the comparison input, across every
    // environment — the instantaneous-vs-daily-threshold mismatch isn't an indoor-only problem, see
    // the design spec's Part H introduction for the real production numbers that proved this.
    if (key === 'luminosity') {
      const mostRecentRaw = [...sorted].reverse().find((reading) => reading.luminosity != null)?.luminosity ?? null;
      const liveValue = mostRecentRaw != null ? mostRecentRaw * (UNIT_CONVERSION[key] ?? 1) : null;

      const dailyTotals = computeDailyTotals(sorted, timezone);
      if (dailyTotals.length === 0) {
        // No complete calendar day yet (brand-new device, or every day so far failed the
        // MAX_GAP_MS gate) — reuses the existing 'calibrating' status (Part D) rather than a new
        // enum member: same meaning, "not enough data yet, never a stale/misleading number".
        parameters[key] = { value: null, status: 'calibrating', speciesRange: null, personalDeviation: 'normal', liveValue };
        continue;
      }

      const recentValue = dailyTotals[0].totalMol * (UNIT_CONVERSION[key] ?? 1);
      const { speciesRange, status } = resolveRangeAndStatus(key, recentValue, profile, device.environment);
      if (status !== 'ok' && status !== 'n/a') {
        hasOutOfRange = true;
        warningParameters.push(key);
      }

      // "Move the plant" advisory (design spec step 6): the 3 most recent COMPLETE days, not just
      // the 1 used for `status` above — a single overcast day must not trigger this, only a
      // sustained pattern. dailyTotals is already most-recent-first.
      const last3Days = dailyTotals.slice(0, 3);
      luminosityRecentDaysTooLow =
        last3Days.length === 3 &&
        last3Days.every((day) => resolveRangeAndStatus(key, day.totalMol * (UNIT_CONVERSION[key] ?? 1), profile, device.environment).status === 'too_low');

      // personalDeviation is deliberately NOT computed for luminosity: Part C's baseline is built
      // from per-reading INSTANTANEOUS values (valuesFor()), which would compare a daily TOTAL
      // against a mean of noon-peak-and-midnight-floor noise — not a meaningful comparison, and Part
      // H's brainstorm didn't ask for a day-total-based personal baseline. Always 'normal' for this
      // one parameter; revisit only if DestCom asks for it explicitly.
      parameters[key] = { value: recentValue, status, speciesRange, personalDeviation: 'normal', liveValue };
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

    parameters[key] = { value: recentValue, status, speciesRange, personalDeviation, liveValue: null };
  }

  return {
    status: warmingUp ? 'warming_up' : hasOutOfRange ? 'warning' : 'ok',
    parameters,
    trend: computeTrend(sorted, device.kind),
    warningParameters,
    luminosityRecentDaysTooLow,
  };
```

- [ ] **Step 4: Update the 3 call sites to pass `timezone`**

All 3 call sites already fetch `healthSettings` and already destructure `.warmupMinDays` from it —
add `.timezone` as the 6th argument, same pattern in each file.

`backend/src/health/scheduler.ts:63`:

```ts
const health = computeDeviceHealth(device, readings, device.plantProfile, healthSettings.warmupMinDays, conductivityCalibration, healthSettings.timezone);
```

`backend/src/api/trpc/routers/health.ts:59`:

```ts
return computeDeviceHealth(device, readings, device.plantProfile, healthSettings.warmupMinDays, conductivityCalibration, healthSettings.timezone);
```

`backend/src/mqtt/publisher.ts:37`:

```ts
const health = computeDeviceHealth(device, readings, device.plantProfile, healthSettings.warmupMinDays, conductivityCalibration, healthSettings.timezone);
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter backend exec tsc --noEmit
```

Expect errors only in frontend files not yet updated (Task 10). If `backend` alone doesn't
typecheck clean, fix before proceeding.

- [ ] **Step 6: No change needed to the `mock` provider**

Confirm, don't implement: `backend/src/providers/mock/index.ts`'s simulated `luminosity` (flat
3-5 baseline ± small random-walk noise, no day/night cycle) needs no change for this plan's
verification methodology. Every verify step in this plan (Task 1 onward) injects backdated
`Reading`/`RawSensorLog` rows directly into a scratch DB copy via a throwaway script rather than
waiting on live simulated time to produce multi-day patterns — Step 7 below does the same. A flat
mock value remains fine for general manual dashboard browsing (still a plausible indoor number). No
task/diff for this step — it exists so a future reviewer doesn't wonder why the mock provider was
untouched.

- [ ] **Step 7: Manual verification — daily-integral-based status, calibrating gate, 3-day advisory**

Create `backend/scratch-verify-luminosity-integral.ts`:

```ts
import { PrismaClient } from '@prisma/client';
import { computeDeviceHealth } from './src/health/scoring.js';

const prisma = new PrismaClient();

async function main() {
  const profile = await prisma.plantProfile.upsert({
    where: { name: 'Scratch Verify Species H' },
    create: { name: 'Scratch Verify Species H', soilMoistureMinPercent: 15, soilMoistureMaxPercent: 60, lightMinMmol: 3000, lightMaxMmol: 6000 },
    update: {},
  });

  const device = await prisma.device.create({
    data: { id: 'SCRATCH-VERIFY-LUMINOSITY', kind: 'PARROT_POT', name: 'Scratch verify H', plantProfileId: profile.id },
  });

  const now = Date.now();
  // 3 complete past days, each a clean day/night cycle whose trapezoidal integral comfortably clears
  // the species' 3000mmol (3mol) minimum — sampled every 3h, well under the 2h... wait, exactly at
  // the edge is avoided on purpose: use 90-minute spacing so every gap is safely under MAX_GAP_MS.
  const hoursOfDay = [0, 1.5, 3, 4.5, 6, 7.5, 9, 10.5, 12, 13.5, 15, 16.5, 18, 19.5, 21, 22.5];
  const lightForHour = (h: number) => (h >= 6 && h <= 18 ? 0.1 + 15 * Math.sin(((h - 6) / 12) * Math.PI) : 0.1);

  for (let daysAgo = 3; daysAgo >= 1; daysAgo--) {
    const dayStart = new Date(now - daysAgo * 24 * 3600_000);
    dayStart.setUTCHours(0, 0, 0, 0);
    for (const h of hoursOfDay) {
      await prisma.reading.create({
        data: {
          deviceId: device.id,
          source: 'POLL',
          timestamp: new Date(dayStart.getTime() + h * 3600_000),
          soilMoisturePercent: 30,
          luminosity: lightForHour(h),
        },
      });
    }
  }

  const readings = await prisma.reading.findMany({ where: { deviceId: device.id }, orderBy: { timestamp: 'asc' }, include: { rawSensorLog: true } });
  const health = computeDeviceHealth(device, readings, profile, 1, null, 'UTC');
  console.log(JSON.stringify(health, null, 2));

  if (health.parameters.luminosity?.status !== 'ok') throw new Error(`Expected luminosity ok with a real sun curve, got ${health.parameters.luminosity?.status}`);
  if (health.parameters.luminosity?.liveValue == null) throw new Error('Expected a non-null liveValue (most recent raw reading exists)');
  if (health.luminosityRecentDaysTooLow) throw new Error('Expected luminosityRecentDaysTooLow=false with 3 good days');

  // Now add a 4th, very recent device with only a partial day of readings — must read 'calibrating',
  // never a misleading number, and must never include "today" in what it averages.
  const freshDevice = await prisma.device.create({
    data: { id: 'SCRATCH-VERIFY-LUMINOSITY-FRESH', kind: 'PARROT_POT', name: 'Scratch verify H fresh', plantProfileId: profile.id },
  });
  await prisma.reading.create({ data: { deviceId: freshDevice.id, source: 'POLL', timestamp: new Date(now - 3600_000), soilMoisturePercent: 30, luminosity: 5 } });
  const freshReadings = await prisma.reading.findMany({ where: { deviceId: freshDevice.id }, orderBy: { timestamp: 'asc' }, include: { rawSensorLog: true } });
  const freshHealth = computeDeviceHealth(freshDevice, freshReadings, profile, 1, null, 'UTC');
  if (freshHealth.parameters.luminosity?.status !== 'calibrating') {
    throw new Error(`Expected calibrating with 0 complete days, got ${freshHealth.parameters.luminosity?.status}`);
  }
  if (freshHealth.parameters.luminosity?.liveValue == null) throw new Error('Expected liveValue to still be populated even while calibrating');

  console.log('OK — daily-integral status, liveValue, and the calibrating gate all behave as expected');

  await prisma.reading.deleteMany({ where: { deviceId: { in: [device.id, freshDevice.id] } } });
  await prisma.device.deleteMany({ where: { id: { in: [device.id, freshDevice.id] } } });
  await prisma.plantProfile.delete({ where: { id: profile.id } });
}

main().finally(() => prisma.$disconnect());
```

```bash
cp backend/prisma/dev.db /tmp/health-engine-verify.db
cd backend
DATABASE_URL="file:/tmp/health-engine-verify.db" pnpm exec tsx scratch-verify-luminosity-integral.ts
rm scratch-verify-luminosity-integral.ts /tmp/health-engine-verify.db
```

Expected: ends with `OK — daily-integral status, liveValue, and the calibrating gate all behave as
expected`.

- [ ] **Step 8: Commit**

```bash
git add backend/src/health/scoring.ts backend/src/health/scheduler.ts backend/src/api/trpc/routers/health.ts backend/src/mqtt/publisher.ts
git commit -m "Luminosity: compare the daily light integral instead of the hourly instantaneous average (Part H)"
```

---

### Task 10: Frontend — timezone setting, daily-total gauge, advisory line

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Modify: `backend/src/api/trpc/routers/health.ts` (zod schema only — `upsertSettings`'s input)
- Modify: `frontend/src/components/health-engine-settings-section.tsx`
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`

**Interfaces:**
- Consumes: `ParameterHealth.liveValue`, `DeviceHealth.luminosityRecentDaysTooLow` from Task 9.
- Produces: no new exported names — this is the last consumer in the chain.

- [ ] **Step 1: Mirror the new backend types**

In `frontend/src/lib/types.ts`, update `ParameterHealth` and `DeviceHealth` (from Task 3's
version):

```ts
export interface ParameterHealth {
  value: number | null;
  status: ParameterStatus;
  speciesRange: [number, number | null] | null;
  personalDeviation: 'unusual_low' | 'unusual_high' | 'normal';
  liveValue: number | null;
}

export interface DeviceHealth {
  status: DeviceHealthStatus;
  parameters: Partial<Record<ParameterKey, ParameterHealth>>;
  trend: HealthTrend;
  warningParameters: ParameterKey[];
  luminosityRecentDaysTooLow: boolean;
}
```

Also confirm `ParameterStatus` (same file) already includes `'calibrating'` (added by Task 1/Part
D) — no change needed there, luminosity reuses it.

- [ ] **Step 2: Extend the `upsertSettings` zod input**

In `backend/src/api/trpc/routers/health.ts`, update the `upsertSettings` procedure's `.input(...)`:

```ts
upsertSettings: protectedProcedure
  .input(z.object({ baselineWindowDays: z.number().int().min(1).max(365), warmupMinDays: z.number().int().min(0).max(365), timezone: z.string().min(1) }))
  .mutation(({ input }) => upsertHealthSettings(input)),
```

(Detailed IANA-format validation already happens inside `upsertHealthSettings` itself, Task 7 —
this zod schema only guards against an empty string reaching that far.)

- [ ] **Step 3: Add a timezone input to the Settings card**

In `frontend/src/components/health-engine-settings-section.tsx`, add a `timezone` field alongside
the 2 existing ones:

```tsx
const [baselineWindowDays, setBaselineWindowDays] = useState(14);
const [warmupMinDays, setWarmupMinDays] = useState(3);
const [timezone, setTimezone] = useState('UTC');

useEffect(() => {
  if (!settings) return;
  setBaselineWindowDays(settings.baselineWindowDays);
  setWarmupMinDays(settings.warmupMinDays);
  setTimezone(settings.timezone);
}, [settings]);
```

Update the mutation call: `upsertMutation.mutate({ baselineWindowDays, warmupMinDays, timezone })`.

Add a 3rd field to the `CardContent`, right after the `warmupMinDays` field's closing `</div>`:

```tsx
<div className="flex flex-col gap-1">
  <Label htmlFor="health-timezone">Fuseau horaire</Label>
  <Input
    id="health-timezone"
    type="text"
    value={timezone}
    onChange={(event) => setTimezone(event.target.value)}
    placeholder="Europe/Paris"
    className="w-40"
  />
</div>
```

Update the `CardDescription` to mention its purpose:

```tsx
<CardDescription>
  Fenêtre glissante utilisée pour la baseline personnelle de chaque appareil, sa période de chauffe, et le fuseau
  horaire utilisé pour calculer la lumière reçue par jour (heure locale, minuit à minuit).
</CardDescription>
```

- [ ] **Step 4: Update the luminosity gauge**

In `frontend/src/routes/_authenticated/devices.$deviceId.tsx`, replace the luminosity block (lines
365-375 as of Task 4's version):

```tsx
{(health?.parameters.luminosity != null || reading.luminosity != null) &&
  (health?.parameters.luminosity?.status === 'calibrating' ? (
    <div className="flex w-28 flex-col items-center gap-2">
      <div className="flex h-21 w-21 items-center justify-center rounded-full border border-dashed border-muted-foreground/40">
        <Sun size={16} className="text-muted-foreground" />
      </div>
      <span className="text-center text-xs text-muted-foreground">Luminosité (DLI)</span>
      <span className="text-center text-[11px] text-muted-foreground/70">Historique de lumière insuffisant</span>
    </div>
  ) : (
    <div className="flex w-28 flex-col items-center gap-1">
      <SensorGauge
        label="Luminosité (DLI)"
        value={health?.parameters.luminosity?.value != null ? health.parameters.luminosity.value / 1000 : (reading.luminosity ?? 0)}
        max={30}
        unit=" mol/m²/j"
        tone={toneFor(health?.parameters.luminosity, 'accent')}
        icon={<Sun size={16} />}
        hint={[
          rangeHint(health?.parameters.luminosity, ' mol/m²/j', 1000),
          health?.parameters.luminosity?.liveValue != null && `Instantané : ${(health.parameters.luminosity.liveValue / 1000).toFixed(2)} mol/m²/j`,
          personalDeviationHint(health?.parameters.luminosity),
        ]
          .filter(Boolean)
          .join(' · ')}
      />
      {health?.luminosityRecentDaysTooLow && (
        <span className="text-center text-[11px] text-warning-foreground">
          Lumière insuffisante depuis 3 jours — envisagez de rapprocher la plante d'une fenêtre.
        </span>
      )}
    </div>
  ))}
```

(The gauge's main `value` now shows the last complete day's total — divided by 1000 to convert
`ParameterHealth.value`'s mmol back to the mol unit this gauge has always displayed, same `scale`
convention `rangeHint` already uses elsewhere in this file. Falls back to the raw live reading only
when `health` hasn't loaded yet, matching how every other gauge in this file already degrades.)

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter frontend exec tsc -b --noEmit
pnpm --filter backend exec tsc --noEmit
```

Expect a clean pass on both packages now.

- [ ] **Step 6: Manual verification — run the dev server against the mock provider**

```bash
pnpm --filter backend dev
```

In a second terminal:

```bash
pnpm --filter frontend dev
```

Log in with the dev admin account (`admin@admin.com` / `admin`). On `/settings`, confirm the
"Moteur de santé" card now shows a "Fuseau horaire" field defaulting to `UTC`, and that saving a
value like `Europe/Paris` persists across a page reload. On a Parrot Pot device detail page with a
species assigned, confirm the luminosity gauge still renders (mock devices always have at least 3
complete simulated days by the time this is tested manually, since the mock provider seeds them at
server startup) and its hint includes an "Instantané : X mol/m²/j" segment.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/lib/types.ts backend/src/api/trpc/routers/health.ts frontend/src/components/health-engine-settings-section.tsx frontend/src/routes/_authenticated/devices.\$deviceId.tsx
git commit -m "Frontend: timezone setting, daily-total luminosity gauge, move-the-plant advisory (Part H)"
```

---

### Task 11: Update `docs/HEALTH_ENGINE.md` and `CLAUDE.md` for Part H

**Files:**
- Modify: `docs/HEALTH_ENGINE.md`
- Modify: `CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Replace the luminosity unit-conversion note in `HEALTH_ENGINE.md`**

Find the "Special case — luminosity (unit conversion)" paragraph (already extended once by Task 6
Step 1 with an "indoor luminosity" sub-paragraph). Add, right after that indoor-luminosity
sub-paragraph:

```markdown
**Special case — daily light integral, not an instantaneous reading (2026-08-03)**: `39e1fa0b`,
despite its confirmed mol/m²/day (DLI) unit, was found — via 5 days of real production data from 2
real Parrot Pots — to behave as an INSTANTANEOUS light-derived reading, not a true accumulated daily
total: flat ~0.1 mol/day overnight, a sharp solar-noon peak (~70 mol/day observed on a window-side
pot), back to floor by evening. Comparing that instantaneous value directly against a species'
full-day DLI threshold (the behavior since Batch 4) was structurally invalid at ANY time of day, not
just at night — a pot could read `too_low` most of the day and `too_high` for the hour around solar
noon. `health/dailyLightIntegral.ts`'s `computeDailyTotals()` now integrates every raw reading
across each calendar day (trapezoidal rule: average rate × elapsed day-fraction between consecutive
points) into a real daily total, in the timezone configured on the Settings page
(`HealthSettings.timezone`, default UTC). Only fully complete days count (a day with a >2h gap
between readings, or the still-in-progress current day, is excluded entirely) — the most recent
complete day's total is what actually gets compared, for every environment (not just indoor). Zero
complete days yet (brand-new device) reports `'calibrating'`, reusing the same status conductivity
calibration already uses. The gauge separately shows the live instantaneous reading as informational
text, and a "move the plant" advisory appears if the 3 most recent complete days were all
`too_low`. Full design: `docs/superpowers/specs/2026-07-31-health-engine-consistency-fixes-design.md`,
Part H.
```

- [ ] **Step 2: Add a Project status entry to `CLAUDE.md`**

In `CLAUDE.md`'s "Project status (by batch)" section, right after the "Health Engine consistency
fixes" entry Task 6 added, add:

```markdown
- **Health Engine consistency fixes — Part H, real daily light integral** ✅ (2026-08-03) — added to
  the same batch above after SSH'ing into the production server and pulling 5 days of real `Reading`
  rows for both real Parrot Pots, prompted by DestCom noticing the dashboard calling out "not enough
  light" at times a plant obviously couldn't be receiving any (nighttime). The real data showed the
  luminosity comparison was broken at any time of day, not just at night: `39e1fa0b` behaves as an
  instantaneous reading (flat ~0.1 mol/day overnight, ~70 mol/day peak at solar noon on one real
  pot), not a true daily total, so comparing it directly against a full-day species threshold was
  structurally invalid. `health/dailyLightIntegral.ts`'s `computeDailyTotals()` (new file) now
  trapezoidal-integrates each raw reading across real calendar days (in a new
  `HealthSettings.timezone`, editable on `/settings`, default UTC) into a true daily total — this,
  not the old hourly average, is what `luminosity`'s status now compares, across every environment
  (not just indoor, unlike Part B above). A day is only "complete" if no gap between consecutive
  readings exceeds 2h, and the still-in-progress current day is never counted. Zero complete days
  yet reuses the existing `'calibrating'` status (Part D). The gauge separately shows the live
  instantaneous reading (informational only), and a "Lumière insuffisante depuis 3 jours" advisory
  appears if the 3 most recent complete days were all `too_low` — a single overcast day never
  triggers it. `personalDeviation` is deliberately left at `'normal'` for luminosity (Part C's
  instantaneous-value baseline isn't meaningful against a daily total; not asked for during
  brainstorming, flagged as a possible future follow-up rather than silently attempted).
  - **Verified**: `computeDailyTotals` against synthetic day/night data (a gapped day correctly
    excluded, today never included, a plausible mid-range total for a clean sun curve); full
    `computeDeviceHealth` integration against a scratch `dev.db` copy (3 good days → `ok` status +
    `luminosityRecentDaysTooLow: false`, a brand-new device with < 1 day of history → `'calibrating'`
    with a populated `liveValue`); `HealthSettings.timezone` default/round-trip/invalid-rejection.
    **Not yet re-validated against the real production Parrot Pots** (the 5-day dataset that
    motivated this fix predates the fix itself) — next deploy should be followed by checking both
    real pots' luminosity status once a few real calendar days have accumulated under the new logic.
```

- [ ] **Step 3: Commit**

```bash
git add docs/HEALTH_ENGINE.md CLAUDE.md
git commit -m "Document Part H (real daily light integral) in HEALTH_ENGINE.md and CLAUDE.md"
```

---

### Task 12: `calibrateWet` — reject an implausibly high captured wet-point value

**Files:**
- Modify: `backend/src/api/trpc/routers/plantDr.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: no new exported names — `calibrateWet`'s input/output shape is unchanged, it just
  throws in one more case than before.

- [ ] **Step 1: Add the upper-bound constant and check**

In `backend/src/api/trpc/routers/plantDr.ts`, add near the top (after the imports):

```ts
// A real potting mix saturates well below this — a captured value above it almost certainly means
// the "capture wet point" button was pressed while water was still actively draining through the
// soil right after pouring, not once the reading had settled a few minutes later (design spec Part
// I, confirmed against a real production capture that read 72.6%). A general ceiling for plausible
// soil saturation, not a per-species value — same YAGNI stance as this project's other gate
// constants (MIN_CALIBRATION_DAYS, MAX_GAP_MS, etc.).
const MAX_PLAUSIBLE_WET_VWC_PERCENT = 55;
```

In the `calibrateWet` mutation, right after the existing lower-bound check
(`if (wetVwcPercent <= dryVwcPercent) { ... }`), add:

```ts
    if (wetVwcPercent > MAX_PLAUSIBLE_WET_VWC_PERCENT) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Reading (${wetVwcPercent.toFixed(1)}%) is implausibly high for soil saturation — wait a few minutes after watering for the reading to settle, then retry.`,
      });
    }
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter backend exec tsc --noEmit
```

- [ ] **Step 3: Manual verification**

This mutation calls `ctx.provider.readSensors(...)` for a **live** device read, so it can't be
exercised with backdated `Reading` rows the way earlier tasks' scratch scripts do — the `mock`
provider's live-read path is the right tool here, same as this project's own established
convention for anything that goes through `connectionQueue`/a `DeviceProvider`. Run the dev server:

```bash
pnpm --filter backend dev
```

(`.env`'s BLE provider set to `mock`.) In a second terminal, log in as the dev admin
(`admin@admin.com` / `admin`) and, using `curl` with the session cookie (or the frontend's existing
`/devices/$deviceId/calibration` page), call `plantDr.calibrateWet` for `MOCK-POT-NORMAL` (a mock
device with a species assigned and `soilMoisturePercent` around 30-40%, well under the new 55%
ceiling) — confirm it still succeeds exactly as before (no regression to the normal path).

Then temporarily raise `MAX_PLAUSIBLE_WET_VWC_PERCENT` reasoning in the other direction — simplest
concrete check: temporarily edit `backend/src/providers/mock/index.ts`'s `MOCK-POT-NORMAL` initial
`soilMoisturePercent` to `70` (well above the 55% ceiling), restart the dev server, call
`plantDr.calibrateWet` again, and confirm it now fails with the new "implausibly high" message
instead of writing the calibration. Revert the temporary mock edit afterward (`git checkout --
backend/src/providers/mock/index.ts` or a manual undo) — it must not ship.

- [ ] **Step 4: Commit**

```bash
git add backend/src/api/trpc/routers/plantDr.ts
git commit -m "calibrateWet: reject an implausibly high captured wet-point reading (Part I)"
```

---

## Self-Review Notes (completed during planning)

- **Spec coverage**: Part A (no-op, verified by construction — outdoor/null environment path
  untouched) / Part B → Task 2 Steps 1-2, 7 / Part C → Task 2 Step 3, 7 / Part D → Task 1 / Part E →
  Task 4 / Part F → Task 2 Step 4, Task 3 Step 2 / Part G → Task 5 / Part H → Tasks 7-11 (migration
  and settings.ts in Task 7, algorithm in Task 8, scoring.ts integration in Task 9, frontend in Task
  10, docs in Task 11) / Part I → Task 12. All 9 spec parts covered.
- **Type consistency checked**: `ParameterHealth`/`DeviceHealth` field names and shapes match
  identically between Task 2/9 (backend) and Task 3/10 (frontend mirror) — `personalDeviation`,
  `warningParameters`, `speciesRange: [number, number | null] | null`, `liveValue`,
  `luminosityRecentDaysTooLow` used consistently across every task that touches them (2, 3, 4, 9,
  10). `computeDeviceHealth`'s call signature (5 params after Task 2, 6 after Task 9 adds
  `timezone`) matches at all 3 call sites in both tasks.
- **`Infinity`-over-JSON risk caught during planning** (not in the original spec, which illustrated
  the open-ended bound as `Number.POSITIVE_INFINITY`): fixed to use `null` instead, documented in
  Global Constraints above.
- **Part H-specific risk caught during planning**: `computeDailyTotals` naively including the
  current, still-in-progress calendar day would have silently reintroduced the exact bug Part H
  exists to fix (a partial-day total read as if it were complete) — Task 8's implementation
  explicitly excludes `todayKey` from its result, and Task 8's own verify step asserts this directly
  rather than relying on it falling out of the gap-exclusion logic by accident.
- **`personalDeviation` scope boundary made explicit, not left ambiguous**: Part H's design spec
  doesn't mention `personalDeviation` for luminosity at all. Task 9 deliberately hardcodes
  `'normal'` for it (a daily-total value compared against an instantaneous-reading baseline would be
  meaningless) rather than silently computing a misleading signal or leaving the loop's behavior
  for this case undefined — called out as a scope decision in Task 9 Step 3's comment, not
  discovered by an implementer mid-task.
