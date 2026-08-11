# Inference Engine — Phase A Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 4 findings the final whole-branch review of the inference engine's V1 slice deferred as a "before Phase C wiring" checklist (no clock injection, no staleness bound on the rolling-average fallback, hardcoded-UTC day bucketing, `AvailabilityReason` never actually set) — per the approved design spec, `docs/superpowers/specs/2026-08-10-inference-engine-phase-a-hardening-design.md`.

**Architecture:** Thread an explicit `now: Date` parameter through the pure pipeline (`InferenceEngine.run` → `computeIndicators` → each `IndicatorDefinition.compute`), defaulting to real time at the outermost entry point so no existing caller's behavior changes. Add a bounded-age check to the two rolling-average indicators' stale-data fallback. Make `dryingRateDeviationSigma`'s day bucketing read an optional `EnvironmentContext.timezone` (defaulting to `'UTC'`, preserving today's exact behavior when omitted). Add an optional `IndicatorValue.unavailableReason` field, set by all 4 indicators on every null-returning path, read by `evidence.ts`'s `indicatorEvidence` adapter.

**Tech Stack:** TypeScript, Node's built-in `node:test` + `node:assert/strict` (run via `tsx --test 'src/inference/**/*.test.ts'`), Biome (lint/format).

## Global Constraints

- Every file under `backend/src/inference/` stays a pure function: no Prisma queries, no I/O, no wall-clock reads baked in as a side effect (spec's Non-negotiable constraints).
- `backend/src/inference/` never imports `PlantProfile` except `referenceProfile.ts` — unaffected by this work, restated for completeness; the species-blindness CI check (`backend/scripts/checkInferenceBoundary.ts`) must still pass unchanged.
- Every default must preserve today's exact observed behavior when a new parameter is omitted — this is a hardening pass, not a behavior change for any existing caller.
- No consumer wiring (tRPC/MQTT/MCP/scheduler) — out of scope, still Phase C.
- No change to `Facts`/`Symptoms`/`Diagnosis`/`Recommendations` rule files (`facts/*.ts`, `symptoms/*.ts`, `diagnoses/*.ts`, `recommendations/*.ts`) beyond what's explicitly specified below.
- Test command: `cd backend && pnpm test` (equivalent to `tsx --test 'src/inference/**/*.test.ts'`).
- Typecheck command: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`.
- Lint command: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint` (Biome, 2 spaces, single quotes, project root `biome.json`).

---

### Task 1: Clock injection — types, engine, and all 4 Indicators (Fix 1)

**Why one task despite touching 10 files:** `IndicatorDefinition.compute`'s signature lives in `types.ts` and is shared by all 4 indicators and by `engine.ts`. A reviewer cannot meaningfully approve a partial change here — leaving any indicator or its test file on the old 2-argument call shape means that indicator silently reads `now` as `undefined` and crashes at runtime the moment its body switches from `Date.now()` to `now.getTime()`. This has to land as one atomic, if large, mechanical change.

**Files:**

- Modify: `backend/src/inference/types.ts` (`IndicatorDefinition.compute` signature)
- Modify: `backend/src/inference/engine.ts` (`computeIndicators`, `InferenceEngine.run`)
- Modify: `backend/src/inference/indicators/soilMoistureRollingAvg1h.ts`
- Modify: `backend/src/inference/indicators/soilMoistureRollingAvg1h.test.ts`
- Modify: `backend/src/inference/indicators/temperatureRollingAvg1h.ts`
- Modify: `backend/src/inference/indicators/temperatureRollingAvg1h.test.ts`
- Modify: `backend/src/inference/indicators/dryingRateDeviationSigma.ts`
- Modify: `backend/src/inference/indicators/dryingRateDeviationSigma.test.ts`
- Modify: `backend/src/inference/indicators/wateringIntervalDeviationSigma.ts`
- Modify: `backend/src/inference/indicators/wateringIntervalDeviationSigma.test.ts`

**Interfaces:**

- Produces: `IndicatorDefinition.compute(observations: DeviceObservations, environment: EnvironmentContext, now: Date): IndicatorValue` — the new signature every later task builds on. `InferenceEngine.run(observations, profile, environment, operational, now: Date = new Date()): InferenceResult` — the new optional 5th parameter.
- Consumes: nothing from a prior task (this is the first task).

- [ ] **Step 1: Add a failing determinism test to `soilMoistureRollingAvg1h.test.ts`**

Replace the entire file with:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { soilMoistureRollingAvg1h } from './soilMoistureRollingAvg1h.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
// Fixed reference instant, deliberately far from the real wall clock — every test in this file
// builds its fixtures relative to NOW and passes NOW into compute() explicitly. If the indicator
// ever reverts to reading Date.now()/new Date() internally instead of the injected `now`, the
// "recent window" filter below would compare against the real wall clock instead, and these tests
// would fail (or pass for the wrong reason) — this is the regression guard for clock injection.
const NOW = new Date('2020-06-15T12:00:00.000Z');

describe('soilMoistureRollingAvg1h', () => {
  it('averages readings from the last hour', () => {
    const readings = [
      fakeReading({ timestamp: new Date(NOW.getTime() - 10 * 60_000), soilMoisturePercent: 40 }),
      fakeReading({ timestamp: new Date(NOW.getTime() - 40 * 60_000), soilMoisturePercent: 44 }),
    ];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.ok(result.value != null && Math.abs(result.value - 42) < 1e-9);
    assert.equal(result.confidence, 1);
  });

  it('falls back to the last 5 readings when none are within the last hour, at reduced confidence', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (2 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, 50);
    assert.equal(result.confidence, 0.5);
  });

  it('returns null with 0 confidence when there is no soil moisture data at all', () => {
    const result = soilMoistureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('ignores LIVE-sourced readings', () => {
    const readings = [fakeReading({ timestamp: NOW, soilMoisturePercent: 99, source: 'LIVE' })];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
  });

  it('computes correctly against a `now` far from the real wall clock, proving it never reads Date.now()/new Date() internally', () => {
    const readings = [fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), soilMoisturePercent: 33 })];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    // If the indicator used the real Date.now() instead of the injected NOW (2020), this reading
    // (5 minutes before NOW, in 2020) would be years outside any real "last hour" window and would
    // incorrectly fall back to the 5-reading path instead of the primary "recent" path.
    assert.equal(result.value, 33);
    assert.equal(result.confidence, 1);
  });

  it('produces identical output for two separate calls with the same observations and the same fixed now', () => {
    const readings = [fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), soilMoisturePercent: 33 })];
    const observations = { readings, wateringEvents: [] };
    const first = soilMoistureRollingAvg1h.compute(observations, env, NOW);
    const second = soilMoistureRollingAvg1h.compute(observations, env, NOW);
    assert.deepEqual(first, second);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd backend && pnpm test -- --test-name-pattern='soilMoistureRollingAvg1h'`
Expected: the 5th test ("computes correctly against a `now` far from the real wall clock...") FAILS — the indicator still reads the real `Date.now()` internally, so a reading actually timestamped in 2020 is nowhere near "recent" relative to the real current wall clock, and the result falls back to a different code path than the test expects. (The extra 3rd argument passed to `compute` is silently ignored by the current implementation — `tsx` does not type-check, so this runs without a compile error.)

- [ ] **Step 3: Update `types.ts`'s `IndicatorDefinition.compute` signature**

In `backend/src/inference/types.ts`, change:

```ts
export interface IndicatorDefinition {
  id: IndicatorId;
  requiredFields: (keyof Reading)[];
  compute(observations: DeviceObservations, environment: EnvironmentContext): IndicatorValue;
}
```

to:

```ts
export interface IndicatorDefinition {
  id: IndicatorId;
  requiredFields: (keyof Reading)[];
  compute(observations: DeviceObservations, environment: EnvironmentContext, now: Date): IndicatorValue;
}
```

- [ ] **Step 4: Thread `now` through `engine.ts`**

In `backend/src/inference/engine.ts`, change:

```ts
function computeIndicators(defs: IndicatorDefinition[], observations: DeviceObservations, environment: EnvironmentContext): IndicatorIndex {
  const index: IndicatorIndex = new Map();
  for (const def of defs) {
    const isSupported = def.requiredFields.every((field) => {
      const capability = FIELD_TO_CAPABILITY[field];
      return capability == null || environment.capabilities.includes(capability);
    });
    if (!isSupported) continue;
    index.set(def.id, def.compute(observations, environment));
  }
  return index;
}
```

to:

```ts
function computeIndicators(
  defs: IndicatorDefinition[],
  observations: DeviceObservations,
  environment: EnvironmentContext,
  now: Date,
): IndicatorIndex {
  const index: IndicatorIndex = new Map();
  for (const def of defs) {
    const isSupported = def.requiredFields.every((field) => {
      const capability = FIELD_TO_CAPABILITY[field];
      return capability == null || environment.capabilities.includes(capability);
    });
    if (!isSupported) continue;
    index.set(def.id, def.compute(observations, environment, now));
  }
  return index;
}
```

And change the `run` method:

```ts
  run(
    observations: DeviceObservations,
    profile: ReferenceProfile | null,
    environment: EnvironmentContext,
    operational: OperationalConstraints,
  ): InferenceResult {
    const indicators = computeIndicators(this.indicatorDefs, observations, environment);
```

to:

```ts
  run(
    observations: DeviceObservations,
    profile: ReferenceProfile | null,
    environment: EnvironmentContext,
    operational: OperationalConstraints,
    now: Date = new Date(),
  ): InferenceResult {
    const indicators = computeIndicators(this.indicatorDefs, observations, environment, now);
```

- [ ] **Step 5: Update `soilMoistureRollingAvg1h.ts` to accept and use the injected `now`**

Replace the entire file with:

```ts
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;

export const soilMoistureRollingAvg1h: IndicatorDefinition = {
  id: 'soilMoistureRollingAvg1h',
  requiredFields: ['soilMoisturePercent'],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const nowMs = now.getTime();
    const recent = withMoisture.filter((r) => nowMs - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withMoisture.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0 };

    const values = sample.map((r) => r.soilMoisturePercent as number);
    const value = values.reduce((sum, v) => sum + v, 0) / values.length;
    const confidence = recent.length > 0 ? 1 : 0.5;

    return { id: 'soilMoistureRollingAvg1h', value, confidence, meta: { windowHours: 1, sampleSize: sample.length } };
  },
};
```

- [ ] **Step 6: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='soilMoistureRollingAvg1h'`
Expected: all 6 tests PASS.

- [ ] **Step 7: Add a failing determinism test to `temperatureRollingAvg1h.test.ts`**

Replace the entire file with:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { temperatureRollingAvg1h } from './temperatureRollingAvg1h.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
// See soilMoistureRollingAvg1h.test.ts for the full rationale on using a fixed, far-from-real-time
// reference instant instead of Date.now() in every fixture.
const NOW = new Date('2020-06-15T12:00:00.000Z');

describe('temperatureRollingAvg1h', () => {
  it('averages readings from the last hour', () => {
    const readings = [
      fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), temperatureC: 24 }),
      fakeReading({ timestamp: new Date(NOW.getTime() - 15 * 60_000), temperatureC: 26 }),
    ];
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.ok(result.value != null && Math.abs(result.value - 25) < 1e-9);
  });

  it('returns null when there is no temperature data', () => {
    const result = temperatureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('computes correctly against a `now` far from the real wall clock, proving it never reads Date.now()/new Date() internally', () => {
    const readings = [fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), temperatureC: 21 })];
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, 21);
    assert.equal(result.confidence, 1);
  });

  it('produces identical output for two separate calls with the same observations and the same fixed now', () => {
    const readings = [fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), temperatureC: 21 })];
    const observations = { readings, wateringEvents: [] };
    const first = temperatureRollingAvg1h.compute(observations, env, NOW);
    const second = temperatureRollingAvg1h.compute(observations, env, NOW);
    assert.deepEqual(first, second);
  });
});
```

- [ ] **Step 8: Run the test, verify it fails**

Run: `cd backend && pnpm test -- --test-name-pattern='temperatureRollingAvg1h'`
Expected: the 3rd test ("computes correctly against a `now` far from the real wall clock...") FAILS, for the same reason as Step 2.

- [ ] **Step 9: Update `temperatureRollingAvg1h.ts` to accept and use the injected `now`**

Replace the entire file with:

```ts
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;

export const temperatureRollingAvg1h: IndicatorDefinition = {
  id: 'temperatureRollingAvg1h',
  requiredFields: ['temperatureC'],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withTemp = observations.readings
      .filter((r) => r.source === 'POLL' && r.temperatureC != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const nowMs = now.getTime();
    const recent = withTemp.filter((r) => nowMs - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withTemp.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };

    const values = sample.map((r) => r.temperatureC as number);
    const value = values.reduce((sum, v) => sum + v, 0) / values.length;
    const confidence = recent.length > 0 ? 1 : 0.5;

    return { id: 'temperatureRollingAvg1h', value, confidence, meta: { windowHours: 1, sampleSize: sample.length } };
  },
};
```

- [ ] **Step 10: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='temperatureRollingAvg1h'`
Expected: all 4 tests PASS.

- [ ] **Step 11: Add a failing determinism test to `dryingRateDeviationSigma.test.ts`**

Replace the entire file with:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { dryingRateDeviationSigma } from './dryingRateDeviationSigma.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
const DAY_MS = 24 * 3_600_000;
// See soilMoistureRollingAvg1h.test.ts for the full rationale on using a fixed, far-from-real-time
// reference instant instead of Date.now() in every fixture.
const NOW = new Date('2020-06-15T12:00:00.000Z');

// `referenceNow` defaults to the file-level NOW so most call sites don't need to pass it — a later
// task (Fix 3, timezone-aware day bucketing) needs a second, different reference instant for one
// specific test, which is why this isn't just a closure over NOW.
function readingsForDay(daysAgo: number, startPercent: number, endPercent: number, referenceNow: Date = NOW) {
  const dayStart = new Date(referenceNow.getTime() - daysAgo * DAY_MS);
  dayStart.setUTCHours(0, 0, 0, 0);
  return [
    fakeReading({ timestamp: new Date(dayStart.getTime() + 1 * 3_600_000), soilMoisturePercent: startPercent }),
    fakeReading({ timestamp: new Date(dayStart.getTime() + 20 * 3_600_000), soilMoisturePercent: endPercent }),
  ];
}

describe('dryingRateDeviationSigma', () => {
  it('returns null when there are fewer than 5 baseline days', () => {
    const readings = [...readingsForDay(2, 50, 45), ...readingsForDay(1, 50, 45), ...readingsForDay(0, 50, 30)];
    const result = dryingRateDeviationSigma.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
  });

  it('reports a strongly positive sigma when today dries much faster than a stable baseline', () => {
    // Baseline days deliberately vary the day-end percent (44/45/46) rather than repeating an
    // identical value: an identical drop every day yields a real (not just float-noise) stddev of
    // exactly 0, which would be a degenerate fixture — it would exercise the MIN_STDDEV_PERCENT_PER_DAY
    // floor below rather than genuinely proving deviation detection against a real, non-degenerate
    // baseline spread. Hand-verified: mean ≈ 6.44%/day, stddev ≈ 1.05%/day — already above the 1.0
    // floor, so the floor does not bind here and this test exercises the raw stddev path.
    const endPercents = [44, 46, 45, 44, 46, 45, 44, 46, 45, 44]; // ~5-7.5%/day baseline, real spread
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, endPercents[i])).flat();
    const today = readingsForDay(0, 50, 20); // ~38%/day today — far above baseline
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env, NOW);
    assert.ok(result.value != null && result.value > 2, `expected sigma > 2, got ${result.value}`);
  });

  it('bounds sigma via the stddev floor when the baseline has near-zero real variance', () => {
    // Baseline daily drying rates are ~5%/day with only tiny, real day-to-day variation:
    // rates ≈ [5.0, 5.05, 4.95, 5.0, 5.1] → mean = 5.02, population stddev ≈ 0.051 %/day (well
    // under the MIN_STDDEV_PERCENT_PER_DAY = 1.0 floor, so the floor binds).
    // Without the floor, a today's rate of 7%/day (a real but moderate difference — not an extreme
    // event) would give sigma = (7 - 5.02) / 0.051 ≈ 38.8 — artificially huge for what is actually
    // an unremarkable deviation from a very stable device. With the floor applied, effective stddev
    // = max(0.051, 1.0) = 1.0, so sigma = (7 - 5.02) / 1.0 ≈ 1.98 — bounded and explainable.
    const rates = [5.0, 5.05, 4.95, 5.0, 5.1];
    const baselineDays = rates.flatMap((rate, i) => readingsForDay(i + 1, 50, 50 - (rate * 19) / 24));
    const today = readingsForDay(0, 50, 50 - (7 * 19) / 24); // ~7%/day today
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env, NOW);
    assert.ok(result.value != null && result.value > 0 && result.value < 10, `expected bounded sigma (< 10), got ${result.value}`);
  });

  it('returns null when today has no reading pair to compute a rate from', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const result = dryingRateDeviationSigma.compute({ readings: baselineDays, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
  });

  it('computes correctly against a `now` far from the real wall clock, proving it never reads Date.now()/new Date() internally', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const today = readingsForDay(0, 50, 44);
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env, NOW);
    // If the indicator computed "today" via the real Date.now() instead of the injected NOW (2020),
    // none of these 2020-dated readings would land in "today"'s bucket and this would return null.
    assert.notEqual(result.value, null);
  });

  it('produces identical output for two separate calls with the same observations and the same fixed now', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const today = readingsForDay(0, 50, 44);
    const observations = { readings: [...baselineDays, ...today], wateringEvents: [] };
    const first = dryingRateDeviationSigma.compute(observations, env, NOW);
    const second = dryingRateDeviationSigma.compute(observations, env, NOW);
    assert.deepEqual(first, second);
  });
});
```

- [ ] **Step 12: Run the test, verify it fails**

Run: `cd backend && pnpm test -- --test-name-pattern='dryingRateDeviationSigma'`
Expected: the 5th test ("computes correctly against a `now` far from the real wall clock...") FAILS — `dayKey(new Date())` still uses the real wall clock to determine "today", so none of the 2020-dated fixture readings land in the real "today" bucket, and `todayRate` is null.

- [ ] **Step 13: Update `dryingRateDeviationSigma.ts` to accept and use the injected `now`**

In `backend/src/inference/indicators/dryingRateDeviationSigma.ts`, change the import line:

```ts
import type { DeviceObservations, IndicatorDefinition, IndicatorValue } from '../types.js';
```

to:

```ts
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';
```

Change the `compute` method signature and its one use of `new Date()`:

```ts
  compute(observations: DeviceObservations): IndicatorValue {
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const byDay = new Map<string, Reading[]>();
    for (const reading of withMoisture) {
      const key = dayKey(reading.timestamp);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(reading);
      else byDay.set(key, [reading]);
    }

    const today = dayKey(new Date());
```

to:

```ts
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const byDay = new Map<string, Reading[]>();
    for (const reading of withMoisture) {
      const key = dayKey(reading.timestamp);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(reading);
      else byDay.set(key, [reading]);
    }

    const today = dayKey(now);
```

Everything else in the file (the `MIN_STDDEV_PERCENT_PER_DAY` constant and its comment, the `dayKey`/`dailyRate` helper functions, the baseline/stddev/sigma logic below `const today = dayKey(now);`) is unchanged in this step.

- [ ] **Step 14: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='dryingRateDeviationSigma'`
Expected: all 6 tests PASS.

- [ ] **Step 15: Add a failing determinism test to `wateringIntervalDeviationSigma.test.ts`**

Replace the entire file with:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeWateringEvent } from '../testHelpers.js';
import { wateringIntervalDeviationSigma } from './wateringIntervalDeviationSigma.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;
// See soilMoistureRollingAvg1h.test.ts for the full rationale on using a fixed, far-from-real-time
// reference instant instead of Date.now() in every fixture.
const NOW = new Date('2020-06-15T12:00:00.000Z');

describe('wateringIntervalDeviationSigma', () => {
  it('returns null with no successful watering events', () => {
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
  });

  it('returns null with fewer than 3 historical intervals', () => {
    const events = [
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 8 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 4 * DAY_MS) }),
    ];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env, NOW);
    assert.equal(result.value, null);
  });

  it('reports a positive sigma when the current gap is far longer than a regular history', () => {
    const events = [
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 40 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 36 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 32 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 28 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 15 * DAY_MS) }), // 13-day gap since — the "current" gap
    ];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env, NOW);
    assert.ok(result.value != null && result.value > 2, `expected sigma > 2, got ${result.value}`);
  });

  it('bounds sigma via the stddev floor when the baseline has near-zero real variance', () => {
    // Baseline intervals are ~96h (4 days) apart with only tiny, real jitter: [94, 96, 98, 96] hours
    // → mean = 96h, population stddev = sqrt(((-2)^2 + 0^2 + 2^2 + 0^2) / 4) = sqrt(2) ≈ 1.414h,
    // well under the MIN_STDDEV_HOURS = 12 floor, so the floor binds.
    // Current gap since the last watering is 130h (~5.4 days) — a real but moderate deviation from
    // the ~4-day habit, not an extreme event.
    // Without the floor: sigma = (130 - 96) / 1.414 ≈ 24.04 — artificially huge for a moderately
    // late watering on an otherwise very regular device.
    // With the floor applied: effective stddev = max(1.414, 12) = 12, so
    // sigma = (130 - 96) / 12 ≈ 2.83 — bounded and explainable.
    const currentGapHours = 130;
    const intervalsHours = [94, 96, 98, 96]; // oldest→newest gaps between successive waterings
    let agoHours = currentGapHours;
    const timestamps: Date[] = [new Date(NOW.getTime() - agoHours * HOUR_MS)]; // newest (last) event first
    for (let i = intervalsHours.length - 1; i >= 0; i--) {
      agoHours += intervalsHours[i];
      timestamps.push(new Date(NOW.getTime() - agoHours * HOUR_MS));
    }
    // timestamps is newest→oldest; fakeWateringEvent order doesn't matter, the indicator sorts.
    const events = timestamps.map((timestamp) => fakeWateringEvent({ timestamp }));
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env, NOW);
    assert.ok(result.value != null && result.value > 0 && result.value < 5, `expected bounded sigma (< 5), got ${result.value}`);
  });

  it('ignores failed watering events', () => {
    const events = [fakeWateringEvent({ timestamp: new Date(NOW.getTime() - DAY_MS), success: false })];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env, NOW);
    assert.equal(result.value, null);
  });

  it('computes correctly against a `now` far from the real wall clock, proving it never reads Date.now() internally', () => {
    const events = [
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 12 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 8 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 4 * DAY_MS) }),
    ];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env, NOW);
    // If the indicator used the real Date.now() instead of the injected NOW (2020) to compute the
    // "current gap since the last watering", the gap would be a huge, unrelated real-world number
    // instead of the ~4-day gap this fixture actually represents.
    assert.notEqual(result.value, null);
  });

  it('produces identical output for two separate calls with the same observations and the same fixed now', () => {
    const events = [
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 12 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 8 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 4 * DAY_MS) }),
    ];
    const observations = { readings: [], wateringEvents: events };
    const first = wateringIntervalDeviationSigma.compute(observations, env, NOW);
    const second = wateringIntervalDeviationSigma.compute(observations, env, NOW);
    assert.deepEqual(first, second);
  });
});
```

- [ ] **Step 16: Run the test, verify it fails**

Run: `cd backend && pnpm test -- --test-name-pattern='wateringIntervalDeviationSigma'`
Expected: the 6th test ("computes correctly against a `now` far from the real wall clock...") FAILS — `Date.now()` still computes the current gap against the real wall clock, giving a huge, unrelated sigma (or a non-representative one), not the ~4-day-gap scenario the fixture encodes.

- [ ] **Step 17: Update `wateringIntervalDeviationSigma.ts` to accept and use the injected `now`**

Replace the entire file with:

```ts
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const MIN_BASELINE_INTERVALS = 3;
// Deliberate floor on the baseline's standard deviation, same rationale and convention as
// `MIN_STDDEV_PERCENT_PER_DAY` in `dryingRateDeviationSigma.ts`: a device watered on a genuinely
// regular schedule (e.g. always ~every 4 days) can have a small-but-real, nonzero stddev from
// ordinary timing jitter (weekend vs weekday triggers, cooldown/allowed-hours window edges) —
// without a floor, sigma = (currentGap - mean) / stdDev amplifies that jitter into a huge,
// physically meaningless value for even a modest schedule deviation, especially with this
// indicator's typically small sample sizes. Unlike the drying-rate indicator (%/day), this one
// works in hours, so a separate constant is needed. 12 hours is an initial engineering estimate —
// half a day, small relative to the multi-day watering cycles this project's real
// devices use, but large enough to absorb realistic jitter — not derived from real sensor data
// yet; pending empirical recalibration once real production data accumulates (same convention as
// other initial-estimate constants in this codebase, e.g. `HEAT_CONTRIBUTION_MIDPOINT_C` in the
// `water_stress` symptom).
const MIN_STDDEV_HOURS = 12;

export const wateringIntervalDeviationSigma: IndicatorDefinition = {
  id: 'wateringIntervalDeviationSigma',
  requiredFields: [],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const successful = observations.wateringEvents
      .filter((event) => event.success)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (successful.length === 0) return { id: 'wateringIntervalDeviationSigma', value: null, confidence: 0 };

    const intervalsHours: number[] = [];
    for (let i = 1; i < successful.length; i++) {
      intervalsHours.push((successful[i].timestamp.getTime() - successful[i - 1].timestamp.getTime()) / 3_600_000);
    }

    if (intervalsHours.length < MIN_BASELINE_INTERVALS) {
      return { id: 'wateringIntervalDeviationSigma', value: null, confidence: 0, meta: { sampleSize: intervalsHours.length } };
    }

    const mean = intervalsHours.reduce((sum, h) => sum + h, 0) / intervalsHours.length;
    const variance = intervalsHours.reduce((sum, h) => sum + (h - mean) ** 2, 0) / intervalsHours.length;
    const stdDev = Math.sqrt(variance);
    // Floor rather than an exact-zero guard — see MIN_STDDEV_HOURS above: a near-zero-but-real
    // stddev is just as capable of producing an artificially huge sigma as an exact 0 is, and a
    // baseline that already meets MIN_BASELINE_INTERVALS but has zero/near-zero real variance is
    // still real evidence of a regular schedule — it should produce a bounded, meaningful sigma,
    // not null.
    const effectiveStdDev = Math.max(stdDev, MIN_STDDEV_HOURS);

    const lastWatering = successful[successful.length - 1];
    const currentGapHours = (now.getTime() - lastWatering.timestamp.getTime()) / 3_600_000;
    const sigma = (currentGapHours - mean) / effectiveStdDev;
    const confidence = Math.min(1, intervalsHours.length / (MIN_BASELINE_INTERVALS * 2));

    return { id: 'wateringIntervalDeviationSigma', value: sigma, confidence, meta: { sampleSize: intervalsHours.length } };
  },
};
```

- [ ] **Step 18: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='wateringIntervalDeviationSigma'`
Expected: all 7 tests PASS.

- [ ] **Step 19: Run the full test suite, typecheck, and lint**

Run: `cd backend && pnpm test`
Expected: all tests across the whole `src/inference/` tree PASS (this also proves `engine.test.ts` and `registry.test.ts` are unaffected — both call sites already tolerate the new signature: `engine.test.ts`'s inline indicator objects use arrow functions with fewer declared parameters than the interface, which TypeScript allows, and `registry.test.ts`'s `inferenceEngine.run(...)` calls omit the 5th `now` argument, which defaults to `new Date()`).

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: no errors (Biome's `assist.organizeImports` should find every import list above already alphabetically sorted — if it reports an import-order fix, apply it with `pnpm lint:fix` and re-check the diff matches what this step describes).

- [ ] **Step 20: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/inference/types.ts backend/src/inference/engine.ts \
  backend/src/inference/indicators/soilMoistureRollingAvg1h.ts backend/src/inference/indicators/soilMoistureRollingAvg1h.test.ts \
  backend/src/inference/indicators/temperatureRollingAvg1h.ts backend/src/inference/indicators/temperatureRollingAvg1h.test.ts \
  backend/src/inference/indicators/dryingRateDeviationSigma.ts backend/src/inference/indicators/dryingRateDeviationSigma.test.ts \
  backend/src/inference/indicators/wateringIntervalDeviationSigma.ts backend/src/inference/indicators/wateringIntervalDeviationSigma.test.ts
git commit -m "inference: thread an explicit now: Date through the pipeline (Fix 1, Phase A hardening)"
```

---

### Task 2: Staleness bound on the rolling-average indicators (Fix 2)

**Files:**

- Modify: `backend/src/inference/indicators/soilMoistureRollingAvg1h.ts`
- Modify: `backend/src/inference/indicators/soilMoistureRollingAvg1h.test.ts`
- Modify: `backend/src/inference/indicators/temperatureRollingAvg1h.ts`
- Modify: `backend/src/inference/indicators/temperatureRollingAvg1h.test.ts`

**Interfaces:**

- Consumes: Task 1's `compute(observations, environment, now)` signature and the `nowMs` local variable already present in both files.
- Produces: nothing new consumed by a later task — `unavailableReason` on this new null path is added in Task 4.

- [ ] **Step 1: Write the failing tests in `soilMoistureRollingAvg1h.test.ts`**

Add these two tests inside the existing `describe('soilMoistureRollingAvg1h', ...)` block, after the "produces identical output..." test:

```ts
  it('discards the fallback average when the most recent fallback reading is older than 24h (stale)', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (25 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('still uses the fallback average when the most recent fallback reading is within 24h', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (20 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, 50);
    assert.equal(result.confidence, 0.5);
  });
```

- [ ] **Step 2: Run the test, verify the first new test fails**

Run: `cd backend && pnpm test -- --test-name-pattern='soilMoistureRollingAvg1h'`
Expected: "discards the fallback average when the most recent fallback reading is older than 24h (stale)" FAILS — today the fallback path has no age bound, so it returns `value: 50, confidence: 0.5` regardless of age. The second new test already passes (it's the pre-existing behavior).

- [ ] **Step 3: Add the staleness bound to `soilMoistureRollingAvg1h.ts`**

Change:

```ts
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;

export const soilMoistureRollingAvg1h: IndicatorDefinition = {
  id: 'soilMoistureRollingAvg1h',
  requiredFields: ['soilMoisturePercent'],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const nowMs = now.getTime();
    const recent = withMoisture.filter((r) => nowMs - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withMoisture.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0 };

    const values = sample.map((r) => r.soilMoisturePercent as number);
```

to:

```ts
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;
// An initial engineering estimate (not derived from real data): beyond this age, even the
// reduced-confidence (0.5) fallback average is considered too stale to be worth reporting — a
// device offline for months should not produce a confident-enough value that could reach
// TRIGGER_WATERING. Same convention as this codebase's other threshold constants (e.g.
// MIN_STDDEV_PERCENT_PER_DAY in dryingRateDeviationSigma.ts).
const MAX_STALE_FALLBACK_AGE_MS = 24 * 3_600_000;

export const soilMoistureRollingAvg1h: IndicatorDefinition = {
  id: 'soilMoistureRollingAvg1h',
  requiredFields: ['soilMoisturePercent'],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const nowMs = now.getTime();
    const recent = withMoisture.filter((r) => nowMs - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withMoisture.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0 };

    if (recent.length === 0) {
      const mostRecentFallback = sample[sample.length - 1];
      if (nowMs - mostRecentFallback.timestamp.getTime() > MAX_STALE_FALLBACK_AGE_MS) {
        return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0 };
      }
    }

    const values = sample.map((r) => r.soilMoisturePercent as number);
```

The rest of the file (`const value = ...` through the closing `return`) is unchanged.

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='soilMoistureRollingAvg1h'`
Expected: all 8 tests PASS.

- [ ] **Step 5: Write the failing tests in `temperatureRollingAvg1h.test.ts`**

Add these two tests inside the existing `describe('temperatureRollingAvg1h', ...)` block, after the "produces identical output..." test:

```ts
  it('discards the fallback average when the most recent fallback reading is older than 24h (stale)', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (25 + i) * 3_600_000), temperatureC: 22 }),
    );
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('still uses the fallback average when the most recent fallback reading is within 24h', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (20 + i) * 3_600_000), temperatureC: 22 }),
    );
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, 22);
    assert.equal(result.confidence, 0.5);
  });
```

- [ ] **Step 6: Run the test, verify the first new test fails**

Run: `cd backend && pnpm test -- --test-name-pattern='temperatureRollingAvg1h'`
Expected: "discards the fallback average when the most recent fallback reading is older than 24h (stale)" FAILS, same reason as Step 2.

- [ ] **Step 7: Add the staleness bound to `temperatureRollingAvg1h.ts`**

Apply the exact same shape of change as Step 3, on the temperature indicator. Change:

```ts
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;

export const temperatureRollingAvg1h: IndicatorDefinition = {
  id: 'temperatureRollingAvg1h',
  requiredFields: ['temperatureC'],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withTemp = observations.readings
      .filter((r) => r.source === 'POLL' && r.temperatureC != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const nowMs = now.getTime();
    const recent = withTemp.filter((r) => nowMs - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withTemp.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };

    const values = sample.map((r) => r.temperatureC as number);
```

to:

```ts
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;
// An initial engineering estimate (not derived from real data): beyond this age, even the
// reduced-confidence (0.5) fallback average is considered too stale to be worth reporting — a
// device offline for months should not produce a confident-enough value that could reach
// TRIGGER_WATERING. Same convention as this codebase's other threshold constants (e.g.
// MIN_STDDEV_PERCENT_PER_DAY in dryingRateDeviationSigma.ts).
const MAX_STALE_FALLBACK_AGE_MS = 24 * 3_600_000;

export const temperatureRollingAvg1h: IndicatorDefinition = {
  id: 'temperatureRollingAvg1h',
  requiredFields: ['temperatureC'],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withTemp = observations.readings
      .filter((r) => r.source === 'POLL' && r.temperatureC != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const nowMs = now.getTime();
    const recent = withTemp.filter((r) => nowMs - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withTemp.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };

    if (recent.length === 0) {
      const mostRecentFallback = sample[sample.length - 1];
      if (nowMs - mostRecentFallback.timestamp.getTime() > MAX_STALE_FALLBACK_AGE_MS) {
        return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };
      }
    }

    const values = sample.map((r) => r.temperatureC as number);
```

The rest of the file is unchanged.

- [ ] **Step 8: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='temperatureRollingAvg1h'`
Expected: all 6 tests PASS.

- [ ] **Step 9: Run the full test suite, typecheck, and lint**

Run: `cd backend && pnpm test`
Expected: all tests PASS.

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/inference/indicators/soilMoistureRollingAvg1h.ts backend/src/inference/indicators/soilMoistureRollingAvg1h.test.ts \
  backend/src/inference/indicators/temperatureRollingAvg1h.ts backend/src/inference/indicators/temperatureRollingAvg1h.test.ts
git commit -m "inference: bound the rolling-average fallback to 24h of staleness (Fix 2, Phase A hardening)"
```

---

### Task 3: Timezone-aware day bucketing in `dryingRateDeviationSigma` (Fix 3)

**Files:**

- Modify: `backend/src/inference/types.ts` (`EnvironmentContext.timezone`)
- Modify: `backend/src/inference/indicators/dryingRateDeviationSigma.ts`
- Modify: `backend/src/inference/indicators/dryingRateDeviationSigma.test.ts`

**Interfaces:**

- Consumes: Task 1's `compute(observations, environment, now)` signature and `readingsForDay(daysAgo, startPercent, endPercent, referenceNow = NOW)` helper (already accepts an optional 4th argument for exactly this task's use).
- Produces: `EnvironmentContext.timezone?: string` — an optional field any future `EnvironmentContext` construction site may set; omitted or `'UTC'` preserves today's exact behavior.

- [ ] **Step 1: Add `timezone` to `EnvironmentContext` in `types.ts`**

Change:

```ts
export interface EnvironmentContext {
  deviceKind: Device['kind'];
  environment: Device['environment'];
  capabilities: DeviceCapabilities;
  observationsAvailability: Record<string, AvailabilityReason | 'available'>;
}
```

to:

```ts
export interface EnvironmentContext {
  deviceKind: Device['kind'];
  environment: Device['environment'];
  capabilities: DeviceCapabilities;
  observationsAvailability: Record<string, AvailabilityReason | 'available'>;
  // IANA timezone name (e.g. 'Europe/Paris'). Optional and defaults to 'UTC' at the one call site
  // that reads it today (dryingRateDeviationSigma's day bucketing) — omitting it, or setting it to
  // 'UTC', preserves the exact previous (hardcoded-UTC) behavior.
  timezone?: string;
}
```

- [ ] **Step 2: Write the failing tests in `dryingRateDeviationSigma.test.ts`**

Add these two tests inside the existing `describe('dryingRateDeviationSigma', ...)` block, after the "produces identical output..." test:

```ts
  it('buckets "today" by the device timezone, not hardcoded UTC — closes the ~2h blind spot right after UTC midnight', () => {
    const localNow = new Date('2020-06-16T01:00:00.000Z'); // 1am UTC = 2am in Etc/GMT-1, same local calendar day
    const timezone = 'Etc/GMT-1'; // fixed offset (UTC+1), no DST — deterministic
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45, localNow)).flat();
    const todayReadings = [
      // Local midnight (00:00 in Etc/GMT-1) is 2020-06-15T23:00:00Z — the start of local "today".
      fakeReading({ timestamp: new Date('2020-06-15T23:00:00.000Z'), soilMoisturePercent: 50 }),
      // localNow itself: local 02:00, exactly 2h into local "today" — meets MIN_HOURS_FOR_TODAY_RATE.
      fakeReading({ timestamp: localNow, soilMoisturePercent: 46 }),
    ];
    const result = dryingRateDeviationSigma.compute(
      { readings: [...baselineDays, ...todayReadings], wateringEvents: [] },
      { ...env, timezone },
      localNow,
    );
    // Bucketed by hardcoded UTC, "today" (June 16 UTC) would only span 00:00-01:00 UTC = 1h of
    // data, below MIN_HOURS_FOR_TODAY_RATE (2h), and this would incorrectly return null. Bucketed
    // by the device's actual 'Etc/GMT-1' timezone, "today" (local June 16) has been running since
    // 2020-06-15T23:00:00Z and spans exactly 2h by `localNow` — enough to compute a rate.
    assert.notEqual(result.value, null);
  });

  it('preserves the exact previous (UTC) behavior when timezone is omitted', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const today = readingsForDay(0, 50, 44);
    const observations = { readings: [...baselineDays, ...today], wateringEvents: [] };
    const withExplicitUtc = dryingRateDeviationSigma.compute(observations, { ...env, timezone: 'UTC' }, NOW);
    const withOmittedTimezone = dryingRateDeviationSigma.compute(observations, env, NOW);
    assert.deepEqual(withExplicitUtc, withOmittedTimezone);
  });
```

- [ ] **Step 3: Run the test, verify the first new test fails**

Run: `cd backend && pnpm test -- --test-name-pattern='dryingRateDeviationSigma'`
Expected: "buckets \"today\" by the device timezone, not hardcoded UTC..." FAILS — `dayKey` still ignores the `timezone` field entirely and buckets by hardcoded UTC, so "today"'s data only spans 1h and `dailyRate` returns `null`. The second new test already passes (both branches currently run through the same hardcoded-UTC `dayKey`, since `timezone` isn't read yet).

- [ ] **Step 4: Make `dayKey` timezone-aware in `dryingRateDeviationSigma.ts`**

Change the `dayKey` function:

```ts
function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
```

to:

```ts
// "YYYY-MM-DD" in the given IANA timezone — the en-CA locale is a standard trick for getting
// Intl.DateTimeFormat to produce ISO-ordered digits directly, no manual string reassembly needed.
// Deliberately duplicated from health/dailyLightIntegral.ts's own dayKey helper rather than
// imported: backend/src/inference/ must never depend on any other part of the app outside itself,
// mirroring the same isolation principle that already governs the species-blindness boundary.
function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
```

Change the `compute` method (parameter name and the 3 `dayKey` call sites):

```ts
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const byDay = new Map<string, Reading[]>();
    for (const reading of withMoisture) {
      const key = dayKey(reading.timestamp);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(reading);
      else byDay.set(key, [reading]);
    }

    const today = dayKey(now);
```

to:

```ts
  compute(observations: DeviceObservations, environment: EnvironmentContext, now: Date): IndicatorValue {
    const timezone = environment.timezone ?? 'UTC';
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const byDay = new Map<string, Reading[]>();
    for (const reading of withMoisture) {
      const key = dayKey(reading.timestamp, timezone);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(reading);
      else byDay.set(key, [reading]);
    }

    const today = dayKey(now, timezone);
```

Everything else in the file is unchanged.

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='dryingRateDeviationSigma'`
Expected: all 8 tests PASS.

- [ ] **Step 6: Run the full test suite, typecheck, and lint**

Run: `cd backend && pnpm test`
Expected: all tests PASS.

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/inference/types.ts backend/src/inference/indicators/dryingRateDeviationSigma.ts backend/src/inference/indicators/dryingRateDeviationSigma.test.ts
git commit -m "inference: bucket drying-rate days by the device timezone instead of hardcoded UTC (Fix 3, Phase A hardening)"
```

---

### Task 4: `AvailabilityReason` threading at the Indicator level (Fix 4)

**Files:**

- Modify: `backend/src/inference/types.ts` (`IndicatorValue.unavailableReason`)
- Modify: `backend/src/inference/adapters.ts` (`indicatorEvidence` — note this lives in `adapters.ts`, not `evidence.ts`; `evidence.ts` only holds `combineWeightedEvidence`/`combineNoisyOr`/`computeCoverage`/`sigmoid`, which this task does not touch)
- Modify: `backend/src/inference/adapters.test.ts`
- Modify: `backend/src/inference/indicators/soilMoistureRollingAvg1h.ts`
- Modify: `backend/src/inference/indicators/soilMoistureRollingAvg1h.test.ts`
- Modify: `backend/src/inference/indicators/temperatureRollingAvg1h.ts`
- Modify: `backend/src/inference/indicators/temperatureRollingAvg1h.test.ts`
- Modify: `backend/src/inference/indicators/dryingRateDeviationSigma.ts`
- Modify: `backend/src/inference/indicators/dryingRateDeviationSigma.test.ts`
- Modify: `backend/src/inference/indicators/wateringIntervalDeviationSigma.ts`
- Modify: `backend/src/inference/indicators/wateringIntervalDeviationSigma.test.ts`

**Interfaces:**

- Consumes: Task 1-3's final state of all 4 indicator files (every null-returning branch identified below already exists after those tasks).
- Produces: `IndicatorValue.unavailableReason?: AvailabilityReason` — set by every indicator on every null-returning path; read by `adapters.ts`'s `indicatorEvidence`, which is the one and only consumer in this codebase today.

- [ ] **Step 1: Add `unavailableReason` to `IndicatorValue` in `types.ts`**

Change:

```ts
export interface IndicatorValue<T = number> {
  id: IndicatorId;
  value: T | null;
  confidence: number;
  meta?: { windowHours?: number; sampleSize?: number; trend?: 'improving' | 'stable' | 'degrading'; [key: string]: unknown };
}
```

to:

```ts
export interface IndicatorValue<T = number> {
  id: IndicatorId;
  value: T | null;
  confidence: number;
  meta?: { windowHours?: number; sampleSize?: number; trend?: 'improving' | 'stable' | 'degrading'; [key: string]: unknown };
  // Only meaningful when value === null. Set by the Indicator itself on every null-returning path,
  // read by adapters.ts's indicatorEvidence to populate EvidenceBreakdown.missing with the real
  // reason instead of always defaulting to 'sensor_absent'. 'sensor_absent' is reserved for the
  // capability-gated-out case (engine.ts never even calls compute()) — an Indicator whose
  // compute() actually ran always sets 'no_recent_data' or 'insufficient_history' instead.
  unavailableReason?: AvailabilityReason;
}
```

- [ ] **Step 2: Write the failing tests in `adapters.test.ts`**

Add these two tests inside the existing `describe('indicatorEvidence', ...)` block, after the "is null when the indicator value itself is null" test:

```ts
  it("propagates the indicator's unavailableReason into missingReason when the value is null", () => {
    const indicators: IndicatorIndex = new Map([
      ['i1', { id: 'i1', value: null, confidence: 0, unavailableReason: 'insufficient_history' }],
    ]);
    const evidence = indicatorEvidence(indicators, 'i1', 1, (value) => value);
    assert.equal(evidence.missingReason, 'insufficient_history');
  });

  it('leaves missingReason undefined (evidence.ts applies the sensor_absent fallback) when the indicator was never computed at all', () => {
    const evidence = indicatorEvidence(new Map(), 'unknown', 1, (value) => value);
    assert.equal(evidence.strength, null);
    assert.equal(evidence.missingReason, undefined);
  });
```

- [ ] **Step 3: Run the test, verify the first new test fails**

Run: `cd backend && pnpm test -- --test-name-pattern='indicatorEvidence'`
Expected: "propagates the indicator's unavailableReason into missingReason..." FAILS — `indicatorEvidence` doesn't set `missingReason` at all today, so `evidence.missingReason` is `undefined`, not `'insufficient_history'`.

- [ ] **Step 4: Update `indicatorEvidence` in `adapters.ts`**

Change:

```ts
export function indicatorEvidence(
  indicators: IndicatorIndex,
  indicatorId: string,
  weight: number,
  toStrength: (value: number) => number,
  polarity: Polarity = 'supports',
): EvidenceItem {
  const indicator = indicators.get(indicatorId);
  const strength = indicator && indicator.value != null ? toStrength(indicator.value) : null;
  return {
    source: { kind: 'indicator', id: indicatorId },
    weight,
    strength,
    confidence: indicator?.confidence ?? null,
    polarity,
  };
}
```

to:

```ts
export function indicatorEvidence(
  indicators: IndicatorIndex,
  indicatorId: string,
  weight: number,
  toStrength: (value: number) => number,
  polarity: Polarity = 'supports',
): EvidenceItem {
  const indicator = indicators.get(indicatorId);
  const strength = indicator && indicator.value != null ? toStrength(indicator.value) : null;
  return {
    source: { kind: 'indicator', id: indicatorId },
    weight,
    strength,
    confidence: indicator?.confidence ?? null,
    polarity,
    // undefined both when the indicator was never computed at all (capability-gated-out) and when
    // it was computed but didn't set its own reason — either way, evidence.ts's missingFrom()
    // falls back to 'sensor_absent', which is correct for the former case and shouldn't occur for
    // the latter now that every registered Indicator sets this field on every null path.
    missingReason: indicator?.unavailableReason,
  };
}
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='indicatorEvidence'`
Expected: all 4 tests PASS.

- [ ] **Step 6: Write the failing tests in `soilMoistureRollingAvg1h.test.ts`**

Add these two tests inside the existing `describe('soilMoistureRollingAvg1h', ...)` block, after the two staleness tests added in Task 2:

```ts
  it('sets unavailableReason "no_recent_data" when there is no soil moisture data at all', () => {
    const result = soilMoistureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });

  it('sets unavailableReason "no_recent_data" when the fallback average is stale (> 24h old)', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (25 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });
```

- [ ] **Step 7: Run the test, verify both new tests fail**

Run: `cd backend && pnpm test -- --test-name-pattern='soilMoistureRollingAvg1h'`
Expected: both new tests FAIL — `result.unavailableReason` is `undefined` on both null-returning branches today.

- [ ] **Step 8: Set `unavailableReason` on both null branches in `soilMoistureRollingAvg1h.ts`**

Change:

```ts
    if (sample.length === 0) return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0 };

    if (recent.length === 0) {
      const mostRecentFallback = sample[sample.length - 1];
      if (nowMs - mostRecentFallback.timestamp.getTime() > MAX_STALE_FALLBACK_AGE_MS) {
        return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0 };
      }
    }
```

to:

```ts
    if (sample.length === 0) return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0, unavailableReason: 'no_recent_data' };

    if (recent.length === 0) {
      const mostRecentFallback = sample[sample.length - 1];
      if (nowMs - mostRecentFallback.timestamp.getTime() > MAX_STALE_FALLBACK_AGE_MS) {
        return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0, unavailableReason: 'no_recent_data' };
      }
    }
```

- [ ] **Step 9: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='soilMoistureRollingAvg1h'`
Expected: all 10 tests PASS.

- [ ] **Step 10: Write the failing tests in `temperatureRollingAvg1h.test.ts`**

Add these two tests inside the existing `describe('temperatureRollingAvg1h', ...)` block, after the two staleness tests added in Task 2:

```ts
  it('sets unavailableReason "no_recent_data" when there is no temperature data at all', () => {
    const result = temperatureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });

  it('sets unavailableReason "no_recent_data" when the fallback average is stale (> 24h old)', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (25 + i) * 3_600_000), temperatureC: 22 }),
    );
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });
```

- [ ] **Step 11: Run the test, verify both new tests fail**

Run: `cd backend && pnpm test -- --test-name-pattern='temperatureRollingAvg1h'`
Expected: both new tests FAIL, same reason as Step 7.

- [ ] **Step 12: Set `unavailableReason` on both null branches in `temperatureRollingAvg1h.ts`**

Apply the same shape of change as Step 8. Change:

```ts
    if (sample.length === 0) return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };

    if (recent.length === 0) {
      const mostRecentFallback = sample[sample.length - 1];
      if (nowMs - mostRecentFallback.timestamp.getTime() > MAX_STALE_FALLBACK_AGE_MS) {
        return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };
      }
    }
```

to:

```ts
    if (sample.length === 0) return { id: 'temperatureRollingAvg1h', value: null, confidence: 0, unavailableReason: 'no_recent_data' };

    if (recent.length === 0) {
      const mostRecentFallback = sample[sample.length - 1];
      if (nowMs - mostRecentFallback.timestamp.getTime() > MAX_STALE_FALLBACK_AGE_MS) {
        return { id: 'temperatureRollingAvg1h', value: null, confidence: 0, unavailableReason: 'no_recent_data' };
      }
    }
```

- [ ] **Step 13: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='temperatureRollingAvg1h'`
Expected: all 8 tests PASS.

- [ ] **Step 14: Write the failing tests in `dryingRateDeviationSigma.test.ts`**

Add these two tests inside the existing `describe('dryingRateDeviationSigma', ...)` block, after the two timezone tests added in Task 3:

```ts
  it('sets unavailableReason "insufficient_history" when there are fewer than 5 baseline days', () => {
    const readings = [...readingsForDay(2, 50, 45), ...readingsForDay(1, 50, 45), ...readingsForDay(0, 50, 30)];
    const result = dryingRateDeviationSigma.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'insufficient_history');
  });

  it('sets unavailableReason "no_recent_data" when today has no reading pair to compute a rate from', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const result = dryingRateDeviationSigma.compute({ readings: baselineDays, wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });
```

- [ ] **Step 15: Run the test, verify both new tests fail**

Run: `cd backend && pnpm test -- --test-name-pattern='dryingRateDeviationSigma'`
Expected: both new tests FAIL — neither null branch sets `unavailableReason` today.

- [ ] **Step 16: Set `unavailableReason` on both null branches in `dryingRateDeviationSigma.ts`**

Change:

```ts
    const today = dayKey(now, timezone);
    const todayRate = dailyRate(byDay.get(today) ?? []);
    if (todayRate == null) return { id: 'dryingRateDeviationSigma', value: null, confidence: 0 };

    const baselineRates: number[] = [];
    for (const [day, dayReadings] of byDay) {
      if (day === today) continue;
      const rate = dailyRate(dayReadings);
      if (rate != null) baselineRates.push(rate);
    }
    const recentBaselineRates = baselineRates.slice(-BASELINE_WINDOW_DAYS);

    if (recentBaselineRates.length < MIN_BASELINE_DAYS) {
      return { id: 'dryingRateDeviationSigma', value: null, confidence: 0, meta: { sampleSize: recentBaselineRates.length } };
    }
```

to:

```ts
    const today = dayKey(now, timezone);
    const todayRate = dailyRate(byDay.get(today) ?? []);
    if (todayRate == null) return { id: 'dryingRateDeviationSigma', value: null, confidence: 0, unavailableReason: 'no_recent_data' };

    const baselineRates: number[] = [];
    for (const [day, dayReadings] of byDay) {
      if (day === today) continue;
      const rate = dailyRate(dayReadings);
      if (rate != null) baselineRates.push(rate);
    }
    const recentBaselineRates = baselineRates.slice(-BASELINE_WINDOW_DAYS);

    if (recentBaselineRates.length < MIN_BASELINE_DAYS) {
      return {
        id: 'dryingRateDeviationSigma',
        value: null,
        confidence: 0,
        meta: { sampleSize: recentBaselineRates.length },
        unavailableReason: 'insufficient_history',
      };
    }
```

- [ ] **Step 17: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='dryingRateDeviationSigma'`
Expected: all 10 tests PASS.

- [ ] **Step 18: Write the failing tests in `wateringIntervalDeviationSigma.test.ts`**

Add these two tests inside the existing `describe('wateringIntervalDeviationSigma', ...)` block, after the two determinism/clock-injection tests added in Task 1:

```ts
  it('sets unavailableReason "no_recent_data" with no successful watering events', () => {
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });

  it('sets unavailableReason "insufficient_history" with fewer than 3 historical intervals', () => {
    const events = [
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 8 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(NOW.getTime() - 4 * DAY_MS) }),
    ];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env, NOW);
    assert.equal(result.unavailableReason, 'insufficient_history');
  });
```

- [ ] **Step 19: Run the test, verify both new tests fail**

Run: `cd backend && pnpm test -- --test-name-pattern='wateringIntervalDeviationSigma'`
Expected: both new tests FAIL — neither null branch sets `unavailableReason` today.

- [ ] **Step 20: Set `unavailableReason` on both null branches in `wateringIntervalDeviationSigma.ts`**

Change:

```ts
    if (successful.length === 0) return { id: 'wateringIntervalDeviationSigma', value: null, confidence: 0 };

    const intervalsHours: number[] = [];
    for (let i = 1; i < successful.length; i++) {
      intervalsHours.push((successful[i].timestamp.getTime() - successful[i - 1].timestamp.getTime()) / 3_600_000);
    }

    if (intervalsHours.length < MIN_BASELINE_INTERVALS) {
      return { id: 'wateringIntervalDeviationSigma', value: null, confidence: 0, meta: { sampleSize: intervalsHours.length } };
    }
```

to:

```ts
    if (successful.length === 0) {
      return { id: 'wateringIntervalDeviationSigma', value: null, confidence: 0, unavailableReason: 'no_recent_data' };
    }

    const intervalsHours: number[] = [];
    for (let i = 1; i < successful.length; i++) {
      intervalsHours.push((successful[i].timestamp.getTime() - successful[i - 1].timestamp.getTime()) / 3_600_000);
    }

    if (intervalsHours.length < MIN_BASELINE_INTERVALS) {
      return {
        id: 'wateringIntervalDeviationSigma',
        value: null,
        confidence: 0,
        meta: { sampleSize: intervalsHours.length },
        unavailableReason: 'insufficient_history',
      };
    }
```

- [ ] **Step 21: Run the test, verify it passes**

Run: `cd backend && pnpm test -- --test-name-pattern='wateringIntervalDeviationSigma'`
Expected: all 9 tests PASS.

- [ ] **Step 22: Run the full test suite, typecheck, and lint**

Run: `cd backend && pnpm test`
Expected: all tests PASS.

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: no errors.

- [ ] **Step 23: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/inference/types.ts backend/src/inference/adapters.ts backend/src/inference/adapters.test.ts \
  backend/src/inference/indicators/soilMoistureRollingAvg1h.ts backend/src/inference/indicators/soilMoistureRollingAvg1h.test.ts \
  backend/src/inference/indicators/temperatureRollingAvg1h.ts backend/src/inference/indicators/temperatureRollingAvg1h.test.ts \
  backend/src/inference/indicators/dryingRateDeviationSigma.ts backend/src/inference/indicators/dryingRateDeviationSigma.test.ts \
  backend/src/inference/indicators/wateringIntervalDeviationSigma.ts backend/src/inference/indicators/wateringIntervalDeviationSigma.test.ts
git commit -m "inference: set unavailableReason on every Indicator null path, read by indicatorEvidence (Fix 4, Phase A hardening)"
```

---

### Task 5: `registry.ts` checklist rewrite, `CLAUDE.md` update, and final verification

**Files:**

- Modify: `backend/src/inference/registry.ts`
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: the completed state of Tasks 1-4 (all 4 findings resolved).
- Produces: nothing consumed by a later task — this is the final task of this plan.

- [ ] **Step 1: Rewrite the checklist comment in `registry.ts`**

Change:

```ts
// Known follow-up before wiring a real consumer (tRPC/MQTT/MCP/scheduler) to inferenceEngine —
// all deferred together since they share one root cause (the engine's real-time/data-availability
// boundary is thin because nothing consumes it yet) and carry zero risk while unwired:
// 1. AvailabilityReason (types.ts) is never actually set by any adapter — EvidenceBreakdown.missing
//    always reports 'sensor_absent' regardless of the real reason (offline vs. never-existed).
// 2. No clock injection: all 4 indicators call Date.now()/new Date() directly, so the pipeline is
//    not replayable/reproducible against the same historical readings — contradicts the RFC's
//    stated reason for not persisting the full evidence tree.
// 3. The two rolling-average indicators' stale-data fallback (last 5 readings) has no age bound —
//    a device offline for months can still produce a confident-enough value that reaches
//    TRIGGER_WATERING.
// 4. dryingRateDeviationSigma buckets days in hardcoded UTC (not the device's configured timezone,
//    unlike the rest of this codebase's convention, e.g. health/dailyLightIntegral.ts's
//    HealthSettings.timezone) — a ~2h/day blind spot right after UTC midnight where the "today"
//    bucket can't span the minimum window.
import { diagnosisRules } from './diagnoses/index.js';
```

to:

```ts
// Before wiring a real consumer (tRPC/MQTT/MCP/scheduler) to inferenceEngine: AvailabilityReason
// (types.ts) is threaded through Indicators only (IndicatorValue.unavailableReason), not yet
// through Facts/Symptoms/Diagnoses — a deliberate scope cut made by the 2026-08-10 Phase A
// hardening pass (docs/superpowers/specs/2026-08-10-inference-engine-phase-a-hardening-design.md),
// not an oversight; nothing downstream consumes evidenceBreakdown.missing at the Fact/Symptom/
// Diagnosis level yet. The other 3 findings that same pass identified (no clock injection, no
// staleness bound on the rolling-average fallback, hardcoded-UTC day bucketing) are resolved.
import { diagnosisRules } from './diagnoses/index.js';
```

- [ ] **Step 2: Run the full test suite, typecheck, and lint one more time**

Run: `cd backend && pnpm test`
Expected: all tests PASS (registry.ts's comment change has no behavioral effect, this just confirms nothing in Tasks 1-4 regressed).

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: no errors.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: no errors.

- [ ] **Step 3: Update `CLAUDE.md`'s Project status section**

In `CLAUDE.md`, find the end of the "Horticultural inference engine — V1 vertical slice, Phase A" bullet — it ends with this paragraph, immediately followed by the `## Repo structure` heading:

```markdown
  - **Not done**: no consumer is wired to `inferenceEngine` yet — no tRPC procedure, no MQTT
    publisher, no MCP tool, no scheduler change. `backend/src/health/` remains the only code path
    actually read by the app today. The RFC's own 5-phase Migration Plan (shadow mode → migrate
    read-only consumers → migrate the auto-watering scheduler only after zero-disagreement
    verification → cleanup) is the deliberate next step, not started.

## Repo structure
```

Insert a new bullet between them, so the result reads:

```markdown
  - **Not done**: no consumer is wired to `inferenceEngine` yet — no tRPC procedure, no MQTT
    publisher, no MCP tool, no scheduler change. `backend/src/health/` remains the only code path
    actually read by the app today. The RFC's own 5-phase Migration Plan (shadow mode → migrate
    read-only consumers → migrate the auto-watering scheduler only after zero-disagreement
    verification → cleanup) is the deliberate next step, not started.
- **Inference engine — Phase A hardening** ✅ (2026-08-11) — fixed the 4 findings the V1 slice's
  final whole-branch review had deferred as a "before Phase C wiring" checklist (comment atop
  `backend/src/inference/registry.ts`), per DestCom's explicit request to resolve them now rather
  than carry them into Phase C. Full design in
  `docs/superpowers/specs/2026-08-10-inference-engine-phase-a-hardening-design.md`. Still entirely
  isolated under `backend/src/inference/` — no consumer wiring, same as the entry above.
  - **Clock injection**: `InferenceEngine.run` gained an optional 5th parameter, `now: Date = new
    Date()`, threaded down into every `IndicatorDefinition.compute(observations, environment, now)`
    call — all 4 Indicators now use the injected `now` instead of reading `Date.now()`/`new Date()`
    internally, making the pipeline genuinely replayable against historical readings (the RFC's own
    stated justification for not persisting the full evidence tree).
  - **Staleness bound**: the two rolling-average indicators' stale-data fallback (last 5 readings
    when nothing is within the last hour) now discards the fallback entirely — returning `{ value:
    null, confidence: 0 }` instead of a falsely-confident stale average — if the most recent
    fallback reading is more than `MAX_STALE_FALLBACK_AGE_MS` (24h, an initial engineering estimate)
    old.
  - **Timezone-aware day bucketing**: `EnvironmentContext` gained an optional `timezone` field
    (IANA name, defaulting to `'UTC'`). `dryingRateDeviationSigma`'s day-bucketing `dayKey` helper
    now uses it via the same `Intl.DateTimeFormat`/`en-CA` technique already used by
    `health/dailyLightIntegral.ts`'s own `dayKey` — deliberately duplicated, not imported, since
    `backend/src/inference/` must never depend on any other part of the app. Closes a ~2h/day blind
    spot right after UTC midnight where the "today" bucket couldn't span the minimum window for a
    device whose real local day had already been running for hours.
  - **`AvailabilityReason` threading (Indicator level only)**: `IndicatorValue` gained an optional
    `unavailableReason` field, set by all 4 Indicators on every null-returning path
    (`'no_recent_data'` vs. `'insufficient_history'`, per indicator) and read by `adapters.ts`'s
    `indicatorEvidence`, which now populates `EvidenceBreakdown.missing` with the real reason
    instead of always defaulting to `'sensor_absent'`. Deliberately not threaded further through
    Facts/Symptoms/Diagnoses in this pass (DestCom's explicit choice) — `registry.ts`'s comment now
    records this as the one remaining deliberately-deferred residual.
  - **Verified**: full `pnpm test` suite (all existing tests plus new determinism/staleness/
    timezone/`unavailableReason` cases) and `tsc --noEmit`/`biome check` both clean.

## Repo structure
```

- [ ] **Step 4: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/inference/registry.ts CLAUDE.md
git commit -m "inference: rewrite registry.ts's before-Phase-C checklist to the single remaining residual, document the hardening pass"
```
