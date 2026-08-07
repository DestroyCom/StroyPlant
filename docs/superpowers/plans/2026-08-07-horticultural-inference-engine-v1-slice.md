# Horticultural Inference Engine — V1 Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the horticultural inference engine's generic core (Indicators → Facts → Symptoms →
Diagnosis → Recommendations) plus exactly one complete vertical slice (`chronic_underwatering` →
`TRIGGER_WATERING`), entirely in isolation under `backend/src/inference/`, with no consumer wired
in yet — this is Migration Plan Phase A of the approved spec.

**Architecture:** A pure, side-effect-free pipeline of pluggable rule registries orchestrated by one
`InferenceEngine` class. Every Indicator/Fact/Symptom/Diagnosis/Recommendation is its own small file
implementing a shared interface and registered in a per-layer `index.ts` array — adding a new rule
never requires touching the engine. Two canonical evidence-combination functions
(`combineWeightedEvidence`, `combineNoisyOr`) are the only math any rule uses.

**Tech Stack:** TypeScript, no new runtime dependency. Tests via Node's built-in `node:test` +
`node:assert/strict`, executed through `tsx` (already a `backend` devDependency) — no test runner
currently exists in this repo, so wiring this up is part of Task 1.

## Global Constraints

- Source spec: `docs/superpowers/specs/2026-08-07-horticultural-inference-engine-design.md` —
  every type/function signature below is copied verbatim from it unless a deviation is called out
  explicitly with its reason.
- `pnpm` exclusively, TypeScript everywhere (project-wide rule, `CLAUDE.md`).
- Nothing outside `backend/src/inference/` is modified by this plan except: `backend/package.json`
  (new `test` script), and the two files for Task 18 (CI import-scan script + workflow). No existing
  file (`scoring.ts`, `scheduler.ts`, any tRPC router, MQTT, frontend) is touched — this plan is
  Phase A only, explicitly isolated, zero production risk (spec's Migration Plan).
- `backend/src/inference/` may **never** import `PlantProfile` from `@prisma/client` except in
  `referenceProfile.ts` (Task 3) — this is itself enforced by Task 18, not just stated here.
- Every layer is a pure function: no Prisma queries, no I/O, inside any file under
  `backend/src/inference/` (the calling orchestration that will eventually fetch `Reading`/
  `WateringEvent` rows and call `resolveReferenceProfile` lives outside this plan's scope entirely —
  Phase B/C).
- `Reading` fields used: `soilMoisturePercent`, `temperatureC`, `timestamp`, `source` (`'POLL'` |
  `'LIVE'`). `WateringEvent` fields used: `timestamp`, `success`. `PlantProfile` fields used:
  `soilMoistureMinPercent`, `soilMoistureMaxPercent`, `temperatureMinC`, `temperatureMaxC`.
- All indicators/facts/symptoms/diagnoses/recommendations built in this plan are scoped to the
  `chronic_underwatering` vertical slice only — no other Diagnosis, no luminosity/conductivity/
  humidity handling, per the spec's "V1 scope" section. `DiagnosisEvent`/`RuleCalibration`
  persistence, the DSL, LLM narration, and the `IndicatorSnapshot` cache are explicitly out of scope
  for this plan (later increments per the spec).

---

## File Structure

```text
backend/
  package.json                              (Modify: add "test" script)
  src/inference/
    types.ts                                (Create: all shared interfaces/types)
    testHelpers.ts                          (Create: fakeReading/fakeWateringEvent fixtures)
    testHelpers.test.ts                     (Create)
    evidence.ts                             (Create: computeCoverage, combineWeightedEvidence, combineNoisyOr, sigmoid)
    evidence.test.ts                        (Create)
    adapters.ts                             (Create: factEvidence/indicatorEvidence/symptomEvidence/diagnosisEvidence/operationalEvidence)
    adapters.test.ts                        (Create)
    referenceProfile.ts                     (Create: resolveReferenceProfile — only file allowed to import PlantProfile)
    referenceProfile.test.ts                (Create)
    engine.ts                               (Create: InferenceEngine, validateRegistry, classifyTiers, reconcileRecommendations, internal compute* helpers)
    engine.test.ts                          (Create)
    dto.ts                                  (Create: PlantHealthStatusDTO, toPlantHealthStatusDTO)
    dto.test.ts                             (Create)
    registry.ts                             (Create: wires every registry into one InferenceEngine instance)
    registry.test.ts                        (Create: end-to-end integration tests for the full slice)
    indicators/
      soilMoistureRollingAvg1h.ts           (Create)
      soilMoistureRollingAvg1h.test.ts      (Create)
      temperatureRollingAvg1h.ts            (Create)
      temperatureRollingAvg1h.test.ts       (Create)
      dryingRateDeviationSigma.ts           (Create)
      dryingRateDeviationSigma.test.ts      (Create)
      wateringIntervalDeviationSigma.ts     (Create)
      wateringIntervalDeviationSigma.test.ts (Create)
      index.ts                              (Create: indicatorDefinitions array)
    facts/
      soilMoistureBelowProfileMin.ts        (Create)
      soilMoistureBelowProfileMin.test.ts   (Create)
      dryingRateUnusuallyFast.ts            (Create)
      dryingRateUnusuallyFast.test.ts       (Create)
      wateringIntervalUnusuallyLong.ts      (Create)
      wateringIntervalUnusuallyLong.test.ts (Create)
      index.ts                              (Create: factDefinitions array)
    symptoms/
      waterStress.ts                        (Create)
      waterStress.test.ts                   (Create)
      irregularWatering.ts                  (Create)
      irregularWatering.test.ts             (Create)
      index.ts                              (Create: symptomRules array)
    diagnoses/
      chronicUnderwatering.ts               (Create)
      chronicUnderwatering.test.ts          (Create)
      index.ts                              (Create: diagnosisRules array)
    recommendations/
      triggerWatering.ts                    (Create)
      triggerWatering.test.ts               (Create)
      index.ts                              (Create: recommendationRules array)
  scripts/
    checkInferenceBoundary.ts               (Create: CI import-scan)
.github/workflows/
  inference-boundary-check.yml              (Create)
```

**Layer responsibilities**: `types.ts` is the single source of truth for every shared shape — every
other file imports from it, nothing redefines a shape locally. `evidence.ts`/`adapters.ts` are the
only place evidence-combination math exists — every rule composes them, never reimplements them.
`engine.ts` is the only file that knows how to orchestrate the 5 layers — it contains zero
domain-specific knowledge (no mention of `soil_moisture_below_profile_min` or `chronic_underwatering`
anywhere in it). Each rule file (`indicators/*.ts`, `facts/*.ts`, etc.) is independent and
independently testable — a reviewer could approve `dryingRateDeviationSigma.ts` while requesting
changes to `wateringIntervalDeviationSigma.ts` without either blocking the other.

---

### Task 1: Test runner wiring + shared types + test fixtures

**Files:**
- Modify: `backend/package.json`
- Create: `backend/src/inference/types.ts`
- Create: `backend/src/inference/testHelpers.ts`
- Test: `backend/src/inference/testHelpers.test.ts`

**Interfaces:**
- Produces: every type in `types.ts` (`FactId`, `IndicatorId`, `SymptomId`, `DiagnosisId`,
  `RecommendationAction`, `AvailabilityReason`, `DeviceCapabilities`, `EnvironmentContext`,
  `DeviceObservations`, `Range`, `ReferenceProfile`, `IndicatorValue`, `IndicatorDefinition`,
  `IndicatorIndex`, `FactResult`, `FactDefinition`, `FactSnapshot`, `EvidenceCoverage`,
  `EvidenceSource`, `EvidenceItem`, `EvidenceContribution`, `EvidenceBreakdown`, `SymptomResult`,
  `SymptomRule`, `SymptomSnapshot`, `DiagnosisFinding`, `DiagnosisRule`, `DiagnosisSnapshot`,
  `OperationalConstraints`, `RecommendationResult`, `RecommendationRule`, `Recommendation`,
  `PlantState`, `InferenceContext`, `InferenceResult`) — every later task imports from here.
  `fakeReading(overrides?)`, `fakeWateringEvent(overrides?)` from `testHelpers.ts` — every later
  test file imports these.

- [ ] **Step 1: Add the test script to `backend/package.json`**

In the `"scripts"` block, add:

```json
"test": "tsx --test src/inference"
```

Node's built-in test runner (invoked here via `tsx`, which already transpiles TS for this project's
`dev`/`seed:admin` scripts) recursively discovers `*.test.ts` files under the given directory — no
glob needed.

- [ ] **Step 2: Write `backend/src/inference/types.ts`**

```ts
import type { Device, Reading, WateringEvent } from '@prisma/client';

export type FactId = string;
export type IndicatorId = string;
export type SymptomId = string;
export type DiagnosisId = string;
export type RecommendationAction = string;

export type AvailabilityReason = 'sensor_absent' | 'no_recent_data' | 'insufficient_history';

export type DeviceCapabilities = ('soilMoisture' | 'temperature' | 'luminosity' | 'conductivity' | 'humidity')[];

export interface EnvironmentContext {
  deviceKind: Device['kind'];
  environment: Device['environment'];
  capabilities: DeviceCapabilities;
  observationsAvailability: Record<string, AvailabilityReason | 'available'>;
}

export interface DeviceObservations {
  readings: Reading[];
  wateringEvents: WateringEvent[];
}

export interface Range {
  min: number | null;
  max: number | null;
}

export interface ReferenceProfile {
  soilMoisturePercent?: Range;
  temperatureC?: Range;
  humidityPercent?: Range;
  luminosityMmolPerDay?: Range;
  soilConductivityUsCm?: Range;
}

export interface IndicatorValue<T = number> {
  id: IndicatorId;
  value: T | null;
  confidence: number;
  meta?: { windowHours?: number; sampleSize?: number; trend?: 'improving' | 'stable' | 'degrading'; [key: string]: unknown };
}

export interface IndicatorDefinition {
  id: IndicatorId;
  requiredFields: (keyof Reading)[];
  compute(observations: DeviceObservations, environment: EnvironmentContext): IndicatorValue;
}

export type IndicatorIndex = Map<IndicatorId, IndicatorValue>;

export interface FactResult {
  id: FactId;
  holds: boolean;
  confidence: number;
  supportingIndicators: IndicatorId[];
  evidence?: Record<string, unknown>;
}

export interface FactDefinition {
  id: FactId;
  needsProfile: boolean;
  requiredIndicators: IndicatorId[];
  evaluate(indicators: IndicatorIndex, profile: ReferenceProfile | null): FactResult | null;
}

export type FactSnapshot = Map<FactId, FactResult>;

export interface EvidenceCoverage {
  availableWeight: number;
  totalWeight: number;
  ratio: number;
}

export type EvidenceSource =
  | { kind: 'fact'; id: FactId }
  | { kind: 'indicator'; id: IndicatorId }
  | { kind: 'symptom'; id: SymptomId }
  | { kind: 'diagnosis'; id: DiagnosisId }
  | { kind: 'operational'; id: string };

export interface EvidenceItem {
  source: EvidenceSource;
  weight: number;
  strength: number | null;
  confidence: number | null;
  polarity: 'supports' | 'contradicts';
  // Not in the original spec's EvidenceItem — added here because EvidenceBreakdown.missing needs a
  // reason per missing item, and only the adapter constructing the item knows why it's missing.
  // Defaults to 'sensor_absent' if omitted (see evidence.ts).
  missingReason?: AvailabilityReason;
}

export interface EvidenceContribution extends EvidenceItem {
  contribution: number;
}

export interface EvidenceBreakdown {
  formula: 'weightedAverage' | 'noisyOr';
  items: EvidenceContribution[];
  missing: Array<{ source: EvidenceSource; reason: AvailabilityReason }>;
}

export interface SymptomResult {
  id: SymptomId;
  severity: number;
  confidence: number;
  coverage: EvidenceCoverage;
  supportingFacts: FactId[];
  evidenceBreakdown: EvidenceBreakdown;
}

export interface SymptomRule {
  id: SymptomId;
  requiredFacts?: FactId[];
  consumes: { facts: FactId[]; indicators: IndicatorId[] };
  evaluate(ctx: InferenceContext): SymptomResult | null;
}

export type SymptomSnapshot = Map<SymptomId, SymptomResult>;

export interface DiagnosisFinding {
  id: DiagnosisId;
  severity: number;
  confidence: number;
  coverage: EvidenceCoverage;
  tier: 'dominant' | 'secondary' | 'weak_hypothesis';
  evidenceBreakdown: EvidenceBreakdown;
}

export interface DiagnosisRule {
  id: DiagnosisId;
  consumes: { symptoms: SymptomId[] };
  evaluate(ctx: InferenceContext & { symptoms: SymptomSnapshot }): Omit<DiagnosisFinding, 'tier'> | null;
}

export type DiagnosisSnapshot = Map<DiagnosisId, DiagnosisFinding>;

export interface OperationalConstraints {
  autoWateringEnabled: boolean;
  withinAllowedWindow: boolean;
  cooldownActive: boolean;
}

export interface RecommendationResult {
  action: RecommendationAction;
  urgency: 'info' | 'advisory' | 'action_needed';
  confidence: number;
  triggeredBy: DiagnosisId;
  evidenceBreakdown: EvidenceBreakdown;
}

export interface RecommendationRule {
  id: string;
  triggers: DiagnosisId[];
  evaluate(diagnosis: DiagnosisFinding, ctx: InferenceContext & { operationalConstraints: OperationalConstraints }): RecommendationResult | null;
}

export interface Recommendation {
  action: RecommendationAction;
  urgency: 'info' | 'advisory' | 'action_needed';
  confidence: number;
  triggeredBy: DiagnosisId[];
  importance: number;
}

export type PlantState = unknown;

export interface InferenceContext {
  indicators: IndicatorIndex;
  facts: FactSnapshot;
  plantState?: PlantState | null;
  environment: EnvironmentContext;
}

export interface InferenceResult {
  indicators: IndicatorIndex;
  facts: FactSnapshot;
  symptoms: SymptomSnapshot;
  diagnoses: DiagnosisFinding[];
  recommendations: Recommendation[];
}
```

- [ ] **Step 3: Write `backend/src/inference/testHelpers.ts`**

```ts
import type { Reading, WateringEvent } from '@prisma/client';

let nextId = 1;

export function fakeReading(overrides: Partial<Reading> = {}): Reading {
  return {
    id: nextId++,
    deviceId: 'TEST-DEVICE',
    timestamp: new Date(),
    soilMoisturePercent: null,
    temperatureC: null,
    luminosity: null,
    waterTankLevelPercent: null,
    soilConductivityUsCm: null,
    isDrySoil: null,
    isWetSoil: null,
    isEmptyTank: null,
    isInAir: null,
    humidityPercent: null,
    batteryPercent: null,
    source: 'POLL',
    ...overrides,
  };
}

export function fakeWateringEvent(overrides: Partial<WateringEvent> = {}): WateringEvent {
  return {
    id: nextId++,
    deviceId: 'TEST-DEVICE',
    timestamp: new Date(),
    triggerSource: 'MANUAL',
    success: true,
    errorDetail: null,
    ...overrides,
  };
}
```

- [ ] **Step 4: Write the failing test — `backend/src/inference/testHelpers.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading, fakeWateringEvent } from './testHelpers.js';

describe('testHelpers', () => {
  it('fakeReading applies overrides on top of null defaults', () => {
    const reading = fakeReading({ soilMoisturePercent: 42 });
    assert.equal(reading.soilMoisturePercent, 42);
    assert.equal(reading.temperatureC, null);
    assert.equal(reading.source, 'POLL');
    assert.equal(reading.deviceId, 'TEST-DEVICE');
  });

  it('fakeReading assigns a unique id per call', () => {
    const a = fakeReading();
    const b = fakeReading();
    assert.notEqual(a.id, b.id);
  });

  it('fakeWateringEvent defaults to a successful manual trigger', () => {
    const event = fakeWateringEvent();
    assert.equal(event.success, true);
    assert.equal(event.triggerSource, 'MANUAL');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run (from `backend/`): `npx tsx --test src/inference/testHelpers.test.ts`
Expected: FAIL — `Cannot find module './testHelpers.js'` (or similar), since Step 3 hasn't been
committed yet in a real red/green cycle. If Steps 3 and 4 were written together, instead verify by
temporarily renaming `testHelpers.ts` and confirming the failure, then restoring it — the point is
to see the test fail before trusting it passes.

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx tsx --test src/inference/testHelpers.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 7: Run the full suite to confirm the new `test` script works end-to-end**

Run (from `backend/`): `pnpm test`
Expected: PASS, discovers and runs `testHelpers.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add backend/package.json backend/src/inference/types.ts backend/src/inference/testHelpers.ts backend/src/inference/testHelpers.test.ts
git commit -m "feat(inference): add shared types, test fixtures, and test runner wiring"
```

---

### Task 2: Evidence combination + adapter helpers

**Files:**
- Create: `backend/src/inference/evidence.ts`
- Test: `backend/src/inference/evidence.test.ts`
- Create: `backend/src/inference/adapters.ts`
- Test: `backend/src/inference/adapters.test.ts`

**Interfaces:**
- Consumes: `EvidenceItem`, `EvidenceCoverage`, `EvidenceBreakdown`, `EvidenceContribution` (Task 1).
- Produces: `computeCoverage(items)`, `combineWeightedEvidence(items)`, `combineNoisyOr(items)`,
  `sigmoid(value, midpoint, steepness)` from `evidence.ts`. `factEvidence(facts, factId, weight,
  polarity?)`, `indicatorEvidence(indicators, indicatorId, weight, toStrength, polarity?)`,
  `symptomEvidence(symptoms, symptomId, weight, polarity?)`, `diagnosisEvidence(diagnosis, weight,
  polarity?)`, `operationalEvidence(id, active, weight, polarity?)` from `adapters.ts` — every
  Fact/Symptom/Diagnosis/Recommendation rule from Task 9 onward uses these.

- [ ] **Step 1: Write the failing tests — `backend/src/inference/evidence.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { combineNoisyOr, combineWeightedEvidence, computeCoverage, sigmoid } from './evidence.js';
import type { EvidenceItem } from './types.js';

function item(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return { source: { kind: 'operational', id: 'test' }, weight: 1, strength: 1, confidence: 1, polarity: 'supports', ...overrides };
}

describe('computeCoverage', () => {
  it('is 1 when every item has a non-null strength', () => {
    const coverage = computeCoverage([item({ weight: 1 }), item({ weight: 2 })]);
    assert.equal(coverage.ratio, 1);
    assert.equal(coverage.availableWeight, 3);
    assert.equal(coverage.totalWeight, 3);
  });

  it('reflects the fraction of weight that is actually available', () => {
    const coverage = computeCoverage([item({ weight: 1, strength: 0.5 }), item({ weight: 3, strength: null })]);
    assert.equal(coverage.availableWeight, 1);
    assert.equal(coverage.totalWeight, 4);
    assert.equal(coverage.ratio, 0.25);
  });

  it('is 0 for an empty item list (no division by zero)', () => {
    assert.equal(computeCoverage([]).ratio, 0);
  });
});

describe('combineWeightedEvidence', () => {
  it('computes a plain weighted mean over available items', () => {
    const { value } = combineWeightedEvidence([item({ weight: 1, strength: 0.8 }), item({ weight: 1, strength: 0.4 })]);
    assert.ok(value != null && Math.abs(value - 0.6) < 1e-9);
  });

  it('renormalizes over available weight when an item is missing', () => {
    const { value } = combineWeightedEvidence([item({ weight: 1, strength: 0.8 }), item({ weight: 1, strength: null })]);
    assert.ok(value != null && Math.abs(value - 0.8) < 1e-9);
  });

  it('returns null when every item is missing', () => {
    const { value } = combineWeightedEvidence([item({ strength: null }), item({ strength: null })]);
    assert.equal(value, null);
  });

  it('records missing items in the breakdown with their reason', () => {
    const { breakdown } = combineWeightedEvidence([item({ strength: null, missingReason: 'insufficient_history' })]);
    assert.equal(breakdown.missing.length, 1);
    assert.equal(breakdown.missing[0].reason, 'insufficient_history');
  });
});

describe('combineNoisyOr', () => {
  it('returns close to full confidence for one strong supporting item', () => {
    const { confidence } = combineNoisyOr([item({ weight: 1, strength: 1, confidence: 1 })]);
    assert.ok(confidence > 0.99);
  });

  it('is monotonic: a second converging item increases confidence beyond either alone', () => {
    const solo = combineNoisyOr([item({ weight: 1, strength: 0.5, confidence: 1 })]).confidence;
    const combined = combineNoisyOr([
      item({ weight: 1, strength: 0.5, confidence: 1 }),
      item({ weight: 1, strength: 0.5, confidence: 1 }),
    ]).confidence;
    assert.ok(combined > solo);
  });

  it('never exceeds 1 no matter how much supporting evidence converges', () => {
    const items = Array.from({ length: 10 }, () => item({ weight: 1, strength: 0.9, confidence: 1 }));
    assert.ok(combineNoisyOr(items).confidence <= 1);
  });

  it('a contradicting item suppresses confidence', () => {
    const withoutContradiction = combineNoisyOr([item({ weight: 1, strength: 0.9, confidence: 1, polarity: 'supports' })]).confidence;
    const withContradiction = combineNoisyOr([
      item({ weight: 1, strength: 0.9, confidence: 1, polarity: 'supports' }),
      item({ weight: 1, strength: 0.9, confidence: 1, polarity: 'contradicts' }),
    ]).confidence;
    assert.ok(withContradiction < withoutContradiction);
  });

  it('is 0 when no evidence is available at all', () => {
    assert.equal(combineNoisyOr([item({ strength: null })]).confidence, 0);
  });
});

describe('sigmoid', () => {
  it('is exactly 0.5 at the midpoint', () => {
    assert.ok(Math.abs(sigmoid(30, 30, 0.3) - 0.5) < 1e-9);
  });

  it('approaches 1 well above the midpoint and 0 well below it', () => {
    assert.ok(sigmoid(100, 30, 0.3) > 0.999);
    assert.ok(sigmoid(-100, 30, 0.3) < 0.001);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/evidence.test.ts`
Expected: FAIL — `./evidence.js` does not exist.

- [ ] **Step 3: Write `backend/src/inference/evidence.ts`**

```ts
import type { EvidenceBreakdown, EvidenceContribution, EvidenceCoverage, EvidenceItem } from './types.js';

export function computeCoverage(items: EvidenceItem[]): EvidenceCoverage {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const availableWeight = items.filter((item) => item.strength != null).reduce((sum, item) => sum + item.weight, 0);
  return { availableWeight, totalWeight, ratio: totalWeight === 0 ? 0 : availableWeight / totalWeight };
}

function missingFrom(items: EvidenceItem[]): EvidenceBreakdown['missing'] {
  return items.filter((item) => item.strength == null).map((item) => ({ source: item.source, reason: item.missingReason ?? 'sensor_absent' }));
}

export function combineWeightedEvidence(items: EvidenceItem[]): { value: number | null; breakdown: EvidenceBreakdown } {
  const available = items.filter((item) => item.strength != null);
  const totalWeight = available.reduce((sum, item) => sum + item.weight, 0);

  const contributions: EvidenceContribution[] = items.map((item) => {
    if (item.strength == null || totalWeight === 0) return { ...item, contribution: 0 };
    return { ...item, contribution: (item.weight / totalWeight) * item.strength };
  });

  const value = totalWeight === 0 ? null : contributions.reduce((sum, contribution) => sum + contribution.contribution, 0);

  return { value, breakdown: { formula: 'weightedAverage', items: contributions, missing: missingFrom(items) } };
}

export function combineNoisyOr(items: EvidenceItem[]): { confidence: number; breakdown: EvidenceBreakdown } {
  let positiveComplement = 1;
  let negativeComplement = 1;

  const contributions: EvidenceContribution[] = items.map((item) => {
    if (item.strength == null) return { ...item, contribution: 0 };
    const effectiveConfidence = item.confidence ?? 1;
    const contribution = item.weight * item.strength * effectiveConfidence;
    if (item.polarity === 'supports') positiveComplement *= 1 - contribution;
    else negativeComplement *= 1 - contribution;
    return { ...item, contribution };
  });

  const positive = 1 - positiveComplement;
  const negative = 1 - negativeComplement;
  const confidence = positive * (1 - negative);

  return { confidence, breakdown: { formula: 'noisyOr', items: contributions, missing: missingFrom(items) } };
}

// Standard logistic sigmoid, centered at `midpoint`. Used by Symptom/Diagnosis rules to turn a
// continuous Indicator value into a 0..1 strength (e.g. "how much does this temperature contribute
// to water stress"), per the spec's Symptoms section.
export function sigmoid(value: number, midpoint: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/evidence.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Write the failing tests — `backend/src/inference/adapters.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnosisEvidence, factEvidence, indicatorEvidence, operationalEvidence, symptomEvidence } from './adapters.js';
import type { DiagnosisFinding, FactSnapshot, IndicatorIndex, SymptomSnapshot } from './types.js';

describe('factEvidence', () => {
  it('maps a holding fact to strength 1', () => {
    const facts: FactSnapshot = new Map([['f1', { id: 'f1', holds: true, confidence: 0.9, supportingIndicators: [] }]]);
    const evidence = factEvidence(facts, 'f1', 0.5);
    assert.equal(evidence.strength, 1);
    assert.equal(evidence.confidence, 0.9);
    assert.deepEqual(evidence.source, { kind: 'fact', id: 'f1' });
  });

  it('maps a non-holding fact to strength 0 (present, negative — not missing)', () => {
    const facts: FactSnapshot = new Map([['f1', { id: 'f1', holds: false, confidence: 0.9, supportingIndicators: [] }]]);
    assert.equal(factEvidence(facts, 'f1', 0.5).strength, 0);
  });

  it('maps a missing fact to strength null', () => {
    const evidence = factEvidence(new Map(), 'unknown', 0.5);
    assert.equal(evidence.strength, null);
    assert.equal(evidence.confidence, null);
  });
});

describe('indicatorEvidence', () => {
  it('applies the strength transform to an available indicator', () => {
    const indicators: IndicatorIndex = new Map([['i1', { id: 'i1', value: 10, confidence: 1 }]]);
    const evidence = indicatorEvidence(indicators, 'i1', 1, (value) => value / 20);
    assert.equal(evidence.strength, 0.5);
  });

  it('is null when the indicator value itself is null', () => {
    const indicators: IndicatorIndex = new Map([['i1', { id: 'i1', value: null, confidence: 0 }]]);
    assert.equal(indicatorEvidence(indicators, 'i1', 1, (value) => value).strength, null);
  });
});

describe('symptomEvidence', () => {
  it('maps a symptom to its severity as strength', () => {
    const symptoms: SymptomSnapshot = new Map([
      ['s1', { id: 's1', severity: 0.7, confidence: 0.8, coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 }, supportingFacts: [], evidenceBreakdown: { formula: 'weightedAverage', items: [], missing: [] } }],
    ]);
    assert.equal(symptomEvidence(symptoms, 's1', 1).strength, 0.7);
  });
});

describe('diagnosisEvidence', () => {
  it('maps a diagnosis to its confidence as strength', () => {
    const diagnosis: DiagnosisFinding = { id: 'd1', severity: 0.6, confidence: 0.85, coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 }, tier: 'secondary', evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } };
    const evidence = diagnosisEvidence(diagnosis, 1);
    assert.equal(evidence.strength, 0.85);
    assert.deepEqual(evidence.source, { kind: 'diagnosis', id: 'd1' });
  });
});

describe('operationalEvidence', () => {
  it('maps true/false to strength 1/0 with full confidence', () => {
    assert.equal(operationalEvidence('cooldown', true, 1).strength, 1);
    assert.equal(operationalEvidence('cooldown', false, 1).strength, 0);
    assert.equal(operationalEvidence('cooldown', true, 1).confidence, 1);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx tsx --test src/inference/adapters.test.ts`
Expected: FAIL — `./adapters.js` does not exist.

- [ ] **Step 7: Write `backend/src/inference/adapters.ts`**

```ts
import type { DiagnosisFinding, EvidenceItem, FactSnapshot, IndicatorIndex, SymptomSnapshot } from './types.js';

type Polarity = 'supports' | 'contradicts';

export function factEvidence(facts: FactSnapshot, factId: string, weight: number, polarity: Polarity = 'supports'): EvidenceItem {
  const fact = facts.get(factId);
  return {
    source: { kind: 'fact', id: factId },
    weight,
    strength: fact ? (fact.holds ? 1 : 0) : null,
    confidence: fact?.confidence ?? null,
    polarity,
  };
}

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

export function symptomEvidence(symptoms: SymptomSnapshot, symptomId: string, weight: number, polarity: Polarity = 'supports'): EvidenceItem {
  const symptom = symptoms.get(symptomId);
  return {
    source: { kind: 'symptom', id: symptomId },
    weight,
    strength: symptom ? symptom.severity : null,
    confidence: symptom?.confidence ?? null,
    polarity,
  };
}

export function diagnosisEvidence(diagnosis: DiagnosisFinding, weight: number, polarity: Polarity = 'supports'): EvidenceItem {
  return {
    source: { kind: 'diagnosis', id: diagnosis.id },
    weight,
    strength: diagnosis.confidence,
    confidence: diagnosis.confidence,
    polarity,
  };
}

export function operationalEvidence(id: string, active: boolean, weight: number, polarity: Polarity = 'supports'): EvidenceItem {
  return {
    source: { kind: 'operational', id },
    weight,
    strength: active ? 1 : 0,
    confidence: 1,
    polarity,
  };
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx tsx --test src/inference/adapters.test.ts`
Expected: PASS, all tests.

- [ ] **Step 9: Commit**

```bash
git add backend/src/inference/evidence.ts backend/src/inference/evidence.test.ts backend/src/inference/adapters.ts backend/src/inference/adapters.test.ts
git commit -m "feat(inference): add the two canonical evidence-combination functions and adapters"
```

---

### Task 3: `resolveReferenceProfile`

**Files:**
- Create: `backend/src/inference/referenceProfile.ts`
- Test: `backend/src/inference/referenceProfile.test.ts`

**Interfaces:**
- Consumes: `Range`, `ReferenceProfile` (Task 1).
- Produces: `resolveReferenceProfile(plantProfile, environment)` — this plan's Task 16
  (registry-level integration test) does not call it directly (it constructs `ReferenceProfile`
  objects by hand to keep the engine test independent of Prisma types), but it is the function the
  real Phase B/C orchestration (out of this plan's scope) will call.

- [ ] **Step 1: Write the failing test — `backend/src/inference/referenceProfile.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveReferenceProfile } from './referenceProfile.js';
import type { PlantProfile } from '@prisma/client';

function fakePlantProfile(overrides: Partial<PlantProfile> = {}): PlantProfile {
  return {
    id: 1,
    name: 'Test Plant',
    commonName: null,
    soilMoistureMinPercent: null,
    soilMoistureMaxPercent: null,
    soilConductivityMinUsCm: null,
    soilConductivityMaxUsCm: null,
    soilPhMin: null,
    soilPhMax: null,
    temperatureMinC: null,
    temperatureMaxC: null,
    humidityMinPercent: null,
    humidityMaxPercent: null,
    lightMinLux: null,
    lightMaxLux: null,
    lightMinMmol: null,
    lightMaxMmol: null,
    ...overrides,
  };
}

describe('resolveReferenceProfile', () => {
  it('maps soil moisture and temperature ranges directly', () => {
    const profile = fakePlantProfile({ soilMoistureMinPercent: 15, soilMoistureMaxPercent: 60, temperatureMinC: 12, temperatureMaxC: 32 });
    const resolved = resolveReferenceProfile(profile, null);
    assert.deepEqual(resolved.soilMoisturePercent, { min: 15, max: 60 });
    assert.deepEqual(resolved.temperatureC, { min: 12, max: 32 });
  });

  it('omits a range entirely when both bounds are null', () => {
    const resolved = resolveReferenceProfile(fakePlantProfile(), null);
    assert.equal(resolved.soilMoisturePercent, undefined);
    assert.equal(resolved.temperatureC, undefined);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/referenceProfile.test.ts`
Expected: FAIL — `./referenceProfile.js` does not exist.

- [ ] **Step 3: Write `backend/src/inference/referenceProfile.ts`**

```ts
import type { Device, PlantProfile } from '@prisma/client';
import type { Range, ReferenceProfile } from './types.js';

function rangeOrUndefined(min: number | null, max: number | null): Range | undefined {
  return min != null || max != null ? { min, max } : undefined;
}

// The ONLY file under backend/src/inference/ allowed to import PlantProfile — enforced by
// Task 18's CI check. Maps only the fields the V1 vertical slice's Facts/Symptoms actually
// consume (soilMoisturePercent, temperatureC). humidityPercent/luminosityMmolPerDay/
// soilConductivityUsCm — and any indoor-luminosity floor adjustment — are added here only once a
// Fact/Symptom in a later slice actually needs them (YAGNI), not preemptively. The `0;0` →
// null;null CSV-import convention (docs/HEALTH_ENGINE.md) is already applied upstream by
// importSpeciesProfiles.ts, so this function does not need to re-handle it.
export function resolveReferenceProfile(plantProfile: PlantProfile, _environment: Device['environment']): ReferenceProfile {
  return {
    soilMoisturePercent: rangeOrUndefined(plantProfile.soilMoistureMinPercent, plantProfile.soilMoistureMaxPercent),
    temperatureC: rangeOrUndefined(plantProfile.temperatureMinC, plantProfile.temperatureMaxC),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/referenceProfile.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/referenceProfile.ts backend/src/inference/referenceProfile.test.ts
git commit -m "feat(inference): add resolveReferenceProfile, the sole PlantProfile-import boundary"
```

---

### Task 4: `InferenceEngine` core orchestration

**Files:**
- Create: `backend/src/inference/engine.ts`
- Test: `backend/src/inference/engine.test.ts`

**Interfaces:**
- Consumes: every type from Task 1.
- Produces: `class InferenceEngine` (constructor takes 5 registry arrays, exposes `run(...)`),
  `validateRegistry(registries)`, `classifyTiers(findings)`, `reconcileRecommendations(candidates,
  diagnoses, mutuallyExclusiveActions?)`, `MUTUALLY_EXCLUSIVE_ACTIONS` — Task 16's `registry.ts`
  constructs the real `InferenceEngine` from this.

- [ ] **Step 1: Write the failing tests — `backend/src/inference/engine.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { InferenceEngine, classifyTiers, reconcileRecommendations, validateRegistry } from './engine.js';
import type { DiagnosisFinding, DiagnosisRule, EvidenceCoverage, FactDefinition, IndicatorDefinition, RecommendationResult, SymptomRule } from './types.js';

function coverage(ratio: number): EvidenceCoverage {
  return { availableWeight: ratio, totalWeight: 1, ratio };
}

describe('validateRegistry', () => {
  it('throws when a Fact requires an unregistered Indicator', () => {
    const fact: FactDefinition = { id: 'f1', needsProfile: false, requiredIndicators: ['missing_indicator'], evaluate: () => null };
    assert.throws(() => validateRegistry({ indicators: [], facts: [fact], symptoms: [], diagnoses: [], recommendations: [] }), /missing_indicator/);
  });

  it('does not throw when every reference resolves', () => {
    const indicator: IndicatorDefinition = { id: 'i1', requiredFields: [], compute: () => ({ id: 'i1', value: 1, confidence: 1 }) };
    const fact: FactDefinition = { id: 'f1', needsProfile: false, requiredIndicators: ['i1'], evaluate: () => null };
    assert.doesNotThrow(() => validateRegistry({ indicators: [indicator], facts: [fact], symptoms: [], diagnoses: [], recommendations: [] }));
  });

  it('throws when a Symptom consumes an unregistered Fact', () => {
    const symptom: SymptomRule = { id: 's1', consumes: { facts: ['missing_fact'], indicators: [] }, evaluate: () => null };
    assert.throws(() => validateRegistry({ indicators: [], facts: [], symptoms: [symptom], diagnoses: [], recommendations: [] }), /missing_fact/);
  });

  it('throws when a Recommendation triggers on an unregistered Diagnosis', () => {
    assert.throws(
      () => validateRegistry({ indicators: [], facts: [], symptoms: [], diagnoses: [], recommendations: [{ id: 'r1', triggers: ['missing_diagnosis'], evaluate: () => null }] }),
      /missing_diagnosis/,
    );
  });
});

describe('classifyTiers', () => {
  it('ranks a severe, well-evidenced finding above a mild, thinly-evidenced one — the spec\'s own worked example', () => {
    const findings: Array<Omit<DiagnosisFinding, 'tier'>> = [
      { id: 'a', severity: 0.9, confidence: 0.65, coverage: coverage(0.95), evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } },
      { id: 'b', severity: 0.3, confidence: 0.75, coverage: coverage(0.2), evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } },
    ];
    const tiered = classifyTiers(findings);
    const a = tiered.find((f) => f.id === 'a');
    const b = tiered.find((f) => f.id === 'b');
    assert.equal(a?.tier, 'dominant');
    assert.equal(b?.tier, 'weak_hypothesis');
  });

  it('returns an empty array for no findings', () => {
    assert.deepEqual(classifyTiers([]), []);
  });
});

describe('reconcileRecommendations', () => {
  const baseDiagnosis: DiagnosisFinding = { id: 'd1', severity: 0.8, confidence: 0.8, coverage: coverage(1), tier: 'dominant', evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } };

  it('merges two candidates recommending the same action, unioning triggeredBy', () => {
    const candidates: RecommendationResult[] = [
      { action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence: 0.6, triggeredBy: 'd1', evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } },
      { action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence: 0.9, triggeredBy: 'd2', evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } },
    ];
    const [reconciled] = reconcileRecommendations(candidates, [baseDiagnosis, { ...baseDiagnosis, id: 'd2' }]);
    assert.equal(reconciled.confidence, 0.9);
    assert.deepEqual(reconciled.triggeredBy.sort(), ['d1', 'd2']);
  });

  it('drops the lower-importance side of a mutually exclusive pair', () => {
    const candidates: RecommendationResult[] = [
      { action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence: 0.9, triggeredBy: 'd1', evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } },
      { action: 'DELAY_WATERING', urgency: 'advisory', confidence: 0.9, triggeredBy: 'd_weak', evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } },
    ];
    const diagnoses = [baseDiagnosis, { ...baseDiagnosis, id: 'd_weak', severity: 0.1, confidence: 0.1, coverage: coverage(0.1) }];
    const reconciled = reconcileRecommendations(candidates, diagnoses, [['TRIGGER_WATERING', 'DELAY_WATERING']]);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].action, 'TRIGGER_WATERING');
  });

  it('sorts by urgency then confidence', () => {
    const candidates: RecommendationResult[] = [
      { action: 'A', urgency: 'info', confidence: 0.9, triggeredBy: 'd1', evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } },
      { action: 'B', urgency: 'action_needed', confidence: 0.1, triggeredBy: 'd1', evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } },
    ];
    const reconciled = reconcileRecommendations(candidates, [baseDiagnosis]);
    assert.equal(reconciled[0].action, 'B');
  });
});

describe('InferenceEngine', () => {
  it('runs a trivial end-to-end registry and produces a recommendation', () => {
    const indicator: IndicatorDefinition = { id: 'moisture', requiredFields: [], compute: () => ({ id: 'moisture', value: 10, confidence: 1 }) };
    const fact: FactDefinition = {
      id: 'dry',
      needsProfile: false,
      requiredIndicators: ['moisture'],
      evaluate: (indicators) => {
        const value = indicators.get('moisture')?.value;
        return value == null ? null : { id: 'dry', holds: value < 20, confidence: 1, supportingIndicators: ['moisture'] };
      },
    };
    const symptom: SymptomRule = {
      id: 'thirsty',
      consumes: { facts: ['dry'], indicators: [] },
      evaluate: (ctx) => {
        const holds = ctx.facts.get('dry')?.holds;
        return holds == null ? null : { id: 'thirsty', severity: holds ? 1 : 0, confidence: 1, coverage: coverage(1), supportingFacts: ['dry'], evidenceBreakdown: { formula: 'weightedAverage', items: [], missing: [] } };
      },
    };
    const diagnosis: DiagnosisRule = {
      id: 'underwatered',
      consumes: { symptoms: ['thirsty'] },
      evaluate: (ctx) => {
        const s = ctx.symptoms.get('thirsty');
        return !s || s.severity === 0 ? null : { id: 'underwatered', severity: s.severity, confidence: s.confidence, coverage: coverage(1), evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } };
      },
    };
    const engine = new InferenceEngine(
      [indicator],
      [fact],
      [symptom],
      [diagnosis],
      [{ id: 'water_now', triggers: ['underwatered'], evaluate: (d) => ({ action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence: d.confidence, triggeredBy: d.id, evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] } }) }],
    );

    const result = engine.run(
      { readings: [], wateringEvents: [] },
      null,
      { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} },
      { autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: false },
    );

    assert.equal(result.diagnoses.length, 1);
    assert.equal(result.diagnoses[0].id, 'underwatered');
    assert.equal(result.recommendations.length, 1);
    assert.equal(result.recommendations[0].action, 'TRIGGER_WATERING');
  });

  it('throws at construction time if the registries are inconsistent', () => {
    const badFact: FactDefinition = { id: 'f1', needsProfile: false, requiredIndicators: ['nope'], evaluate: () => null };
    assert.throws(() => new InferenceEngine([], [badFact], [], [], []));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/engine.test.ts`
Expected: FAIL — `./engine.js` does not exist.

- [ ] **Step 3: Write `backend/src/inference/engine.ts`**

```ts
import type {
  DeviceObservations,
  DiagnosisFinding,
  DiagnosisRule,
  EnvironmentContext,
  FactDefinition,
  FactSnapshot,
  IndicatorDefinition,
  IndicatorIndex,
  InferenceContext,
  InferenceResult,
  OperationalConstraints,
  Reading,
  Recommendation,
  RecommendationRule,
  RecommendationResult,
  ReferenceProfile,
  SymptomRule,
  SymptomSnapshot,
} from './types.js';

const DOMINANT_IMPORTANCE_THRESHOLD = 0.5; // to recalibrate empirically once real data exists (spec's Priority Score section)
const WEAK_HYPOTHESIS_IMPORTANCE_THRESHOLD = 0.15;

// Empty in V1 — only one RecommendationAction (TRIGGER_WATERING) exists, so no pair can ever
// conflict yet. Populate once a second, genuinely conflicting action (e.g. DELAY_WATERING) ships.
export const MUTUALLY_EXCLUSIVE_ACTIONS: [string, string][] = [];

function importanceOf(f: { severity: number; confidence: number; coverage: { ratio: number } }): number {
  return f.severity * f.confidence * f.coverage.ratio;
}

// Reading field -> the DeviceCapabilities category it belongs to. Drives the "an Indicator whose
// required fields aren't present for this device is simply never computed" rule (spec's
// Extensibility section). Fields with no capability mapping (e.g. none needed by a
// WateringEvent-only indicator) are treated as always-supported.
const FIELD_TO_CAPABILITY: Partial<Record<keyof Reading, 'soilMoisture' | 'temperature' | 'luminosity' | 'conductivity' | 'humidity'>> = {
  soilMoisturePercent: 'soilMoisture',
  temperatureC: 'temperature',
  luminosity: 'luminosity',
  soilConductivityUsCm: 'conductivity',
  humidityPercent: 'humidity',
};

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

function computeFacts(defs: FactDefinition[], indicators: IndicatorIndex, profile: ReferenceProfile | null): FactSnapshot {
  const snapshot: FactSnapshot = new Map();
  for (const def of defs) {
    if (def.needsProfile && !profile) continue;
    const result = def.evaluate(indicators, profile);
    if (result) snapshot.set(def.id, result);
  }
  return snapshot;
}

function computeSymptoms(rules: SymptomRule[], ctx: InferenceContext): SymptomSnapshot {
  const snapshot: SymptomSnapshot = new Map();
  for (const rule of rules) {
    if (rule.requiredFacts && !rule.requiredFacts.every((factId) => ctx.facts.get(factId)?.holds)) continue;
    const result = rule.evaluate(ctx);
    if (result) snapshot.set(rule.id, result);
  }
  return snapshot;
}

export function classifyTiers(findings: Array<Omit<DiagnosisFinding, 'tier'>>): DiagnosisFinding[] {
  if (findings.length === 0) return [];
  const maxImportance = Math.max(...findings.map(importanceOf));
  return findings.map((finding) => {
    const importance = importanceOf(finding);
    const tier: DiagnosisFinding['tier'] =
      importance < WEAK_HYPOTHESIS_IMPORTANCE_THRESHOLD
        ? 'weak_hypothesis'
        : importance >= DOMINANT_IMPORTANCE_THRESHOLD && importance === maxImportance
          ? 'dominant'
          : 'secondary';
    return { ...finding, tier };
  });
}

function computeDiagnoses(rules: DiagnosisRule[], ctx: InferenceContext & { symptoms: SymptomSnapshot }): DiagnosisFinding[] {
  const findings: Array<Omit<DiagnosisFinding, 'tier'>> = [];
  for (const rule of rules) {
    const result = rule.evaluate(ctx);
    if (result) findings.push(result);
  }
  return classifyTiers(findings);
}

function computeRecommendationCandidates(
  rules: RecommendationRule[],
  diagnoses: DiagnosisFinding[],
  ctx: InferenceContext & { operationalConstraints: OperationalConstraints },
): RecommendationResult[] {
  const candidates: RecommendationResult[] = [];
  for (const rule of rules) {
    for (const diagnosis of diagnoses) {
      if (!rule.triggers.includes(diagnosis.id)) continue;
      const result = rule.evaluate(diagnosis, ctx);
      if (result) candidates.push(result);
    }
  }
  return candidates;
}

const URGENCY_RANK: Record<Recommendation['urgency'], number> = { action_needed: 2, advisory: 1, info: 0 };

export function reconcileRecommendations(
  candidates: RecommendationResult[],
  diagnoses: DiagnosisFinding[],
  mutuallyExclusiveActions: [string, string][] = MUTUALLY_EXCLUSIVE_ACTIONS,
): Recommendation[] {
  const importanceByDiagnosisId = new Map(diagnoses.map((d) => [d.id, importanceOf(d)]));
  const byAction = new Map<string, Recommendation>();

  for (const candidate of candidates) {
    const importance = importanceByDiagnosisId.get(candidate.triggeredBy) ?? 0;
    const existing = byAction.get(candidate.action);
    if (!existing) {
      byAction.set(candidate.action, { action: candidate.action, urgency: candidate.urgency, confidence: candidate.confidence, triggeredBy: [candidate.triggeredBy], importance });
      continue;
    }
    existing.confidence = Math.max(existing.confidence, candidate.confidence);
    existing.importance = Math.max(existing.importance, importance);
    if (!existing.triggeredBy.includes(candidate.triggeredBy)) existing.triggeredBy.push(candidate.triggeredBy);
  }

  const reconciled = [...byAction.values()];
  for (const [actionA, actionB] of mutuallyExclusiveActions) {
    const a = reconciled.find((r) => r.action === actionA);
    const b = reconciled.find((r) => r.action === actionB);
    if (a && b) {
      const loser = a.importance >= b.importance ? b : a;
      reconciled.splice(reconciled.indexOf(loser), 1);
    }
  }

  return reconciled.sort((a, b) => URGENCY_RANK[b.urgency] - URGENCY_RANK[a.urgency] || b.confidence - a.confidence);
}

export interface EngineRegistries {
  indicators: IndicatorDefinition[];
  facts: FactDefinition[];
  symptoms: SymptomRule[];
  diagnoses: DiagnosisRule[];
  recommendations: RecommendationRule[];
}

// Statically checks every rule's declared dependency manifest against the ids actually present in
// the sibling registries — without executing any rule. Run once, at InferenceEngine construction
// (spec's Extensibility section, "Guard against silent breakage").
export function validateRegistry(registries: EngineRegistries): void {
  const indicatorIds = new Set(registries.indicators.map((d) => d.id));
  const factIds = new Set(registries.facts.map((d) => d.id));
  const symptomIds = new Set(registries.symptoms.map((d) => d.id));
  const diagnosisIds = new Set(registries.diagnoses.map((d) => d.id));
  const errors: string[] = [];

  for (const fact of registries.facts) {
    for (const indicatorId of fact.requiredIndicators) {
      if (!indicatorIds.has(indicatorId)) errors.push(`Fact "${fact.id}" requires unknown indicator "${indicatorId}"`);
    }
  }
  for (const symptom of registries.symptoms) {
    for (const factId of symptom.consumes.facts) {
      if (!factIds.has(factId)) errors.push(`Symptom "${symptom.id}" consumes unknown fact "${factId}"`);
    }
    for (const indicatorId of symptom.consumes.indicators) {
      if (!indicatorIds.has(indicatorId)) errors.push(`Symptom "${symptom.id}" consumes unknown indicator "${indicatorId}"`);
    }
  }
  for (const diagnosis of registries.diagnoses) {
    for (const symptomId of diagnosis.consumes.symptoms) {
      if (!symptomIds.has(symptomId)) errors.push(`Diagnosis "${diagnosis.id}" consumes unknown symptom "${symptomId}"`);
    }
  }
  for (const recommendation of registries.recommendations) {
    for (const diagnosisId of recommendation.triggers) {
      if (!diagnosisIds.has(diagnosisId)) errors.push(`Recommendation "${recommendation.id}" triggers on unknown diagnosis "${diagnosisId}"`);
    }
  }

  if (errors.length > 0) throw new Error(`Inference engine registry validation failed:\n${errors.join('\n')}`);
}

export class InferenceEngine {
  constructor(
    private indicatorDefs: IndicatorDefinition[],
    private factDefs: FactDefinition[],
    private symptomRules: SymptomRule[],
    private diagnosisRules: DiagnosisRule[],
    private recommendationRules: RecommendationRule[],
  ) {
    validateRegistry({ indicators: indicatorDefs, facts: factDefs, symptoms: symptomRules, diagnoses: diagnosisRules, recommendations: recommendationRules });
  }

  run(observations: DeviceObservations, profile: ReferenceProfile | null, environment: EnvironmentContext, operational: OperationalConstraints): InferenceResult {
    const indicators = computeIndicators(this.indicatorDefs, observations, environment);
    const facts = computeFacts(this.factDefs, indicators, profile);
    const ctx: InferenceContext = { indicators, facts, plantState: null, environment };
    const symptoms = computeSymptoms(this.symptomRules, ctx);
    const diagnoses = computeDiagnoses(this.diagnosisRules, { ...ctx, symptoms });
    const candidates = computeRecommendationCandidates(this.recommendationRules, diagnoses, { ...ctx, operationalConstraints: operational });
    const recommendations = reconcileRecommendations(candidates, diagnoses);
    return { indicators, facts, symptoms, diagnoses, recommendations };
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/engine.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/engine.ts backend/src/inference/engine.test.ts
git commit -m "feat(inference): add InferenceEngine orchestration, validateRegistry, tiering, and recommendation reconciliation"
```

---

### Task 5: Indicator — `soilMoistureRollingAvg1h`

**Files:**
- Create: `backend/src/inference/indicators/soilMoistureRollingAvg1h.ts`
- Test: `backend/src/inference/indicators/soilMoistureRollingAvg1h.test.ts`

**Interfaces:**
- Consumes: `IndicatorDefinition`, `DeviceObservations`, `IndicatorValue` (Task 1); `fakeReading`
  (Task 1).
- Produces: `soilMoistureRollingAvg1h: IndicatorDefinition` — consumed by Task 9 (Facts registry
  via `facts/soilMoistureBelowProfileMin.ts`) and Task 8 (indicators `index.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { soilMoistureRollingAvg1h } from './soilMoistureRollingAvg1h.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };

describe('soilMoistureRollingAvg1h', () => {
  it('averages readings from the last hour', () => {
    const now = Date.now();
    const readings = [
      fakeReading({ timestamp: new Date(now - 10 * 60_000), soilMoisturePercent: 40 }),
      fakeReading({ timestamp: new Date(now - 40 * 60_000), soilMoisturePercent: 44 }),
    ];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env);
    assert.ok(result.value != null && Math.abs(result.value - 42) < 1e-9);
    assert.equal(result.confidence, 1);
  });

  it('falls back to the last 5 readings when none are within the last hour, at reduced confidence', () => {
    const now = Date.now();
    const readings = Array.from({ length: 5 }, (_, i) => fakeReading({ timestamp: new Date(now - (2 + i) * 3_600_000), soilMoisturePercent: 50 }));
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env);
    assert.equal(result.value, 50);
    assert.equal(result.confidence, 0.5);
  });

  it('returns null with 0 confidence when there is no soil moisture data at all', () => {
    const result = soilMoistureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('ignores LIVE-sourced readings', () => {
    const readings = [fakeReading({ timestamp: new Date(), soilMoisturePercent: 99, source: 'LIVE' })];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/indicators/soilMoistureRollingAvg1h.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write `backend/src/inference/indicators/soilMoistureRollingAvg1h.ts`**

```ts
import type { DeviceObservations, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;

export const soilMoistureRollingAvg1h: IndicatorDefinition = {
  id: 'soilMoistureRollingAvg1h',
  requiredFields: ['soilMoisturePercent'],
  compute(observations: DeviceObservations): IndicatorValue {
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const now = Date.now();
    const recent = withMoisture.filter((r) => now - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withMoisture.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'soilMoistureRollingAvg1h', value: null, confidence: 0 };

    const values = sample.map((r) => r.soilMoisturePercent as number);
    const value = values.reduce((sum, v) => sum + v, 0) / values.length;
    const confidence = recent.length > 0 ? 1 : 0.5;

    return { id: 'soilMoistureRollingAvg1h', value, confidence, meta: { windowHours: 1, sampleSize: sample.length } };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/indicators/soilMoistureRollingAvg1h.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/indicators/soilMoistureRollingAvg1h.ts backend/src/inference/indicators/soilMoistureRollingAvg1h.test.ts
git commit -m "feat(inference): add soilMoistureRollingAvg1h indicator"
```

---

### Task 6: Indicator — `temperatureRollingAvg1h`

**Files:**
- Create: `backend/src/inference/indicators/temperatureRollingAvg1h.ts`
- Test: `backend/src/inference/indicators/temperatureRollingAvg1h.test.ts`

**Interfaces:**
- Consumes: same as Task 5.
- Produces: `temperatureRollingAvg1h: IndicatorDefinition` — consumed by Task 12
  (`symptoms/waterStress.ts`) and Task 8 (indicators `index.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { temperatureRollingAvg1h } from './temperatureRollingAvg1h.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };

describe('temperatureRollingAvg1h', () => {
  it('averages readings from the last hour', () => {
    const now = Date.now();
    const readings = [fakeReading({ timestamp: new Date(now - 5 * 60_000), temperatureC: 24 }), fakeReading({ timestamp: new Date(now - 15 * 60_000), temperatureC: 26 })];
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env);
    assert.ok(result.value != null && Math.abs(result.value - 25) < 1e-9);
  });

  it('returns null when there is no temperature data', () => {
    const result = temperatureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/indicators/temperatureRollingAvg1h.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/indicators/temperatureRollingAvg1h.ts`**

```ts
import type { DeviceObservations, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;

export const temperatureRollingAvg1h: IndicatorDefinition = {
  id: 'temperatureRollingAvg1h',
  requiredFields: ['temperatureC'],
  compute(observations: DeviceObservations): IndicatorValue {
    const withTemp = observations.readings
      .filter((r) => r.source === 'POLL' && r.temperatureC != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const now = Date.now();
    const recent = withTemp.filter((r) => now - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withTemp.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };

    const values = sample.map((r) => r.temperatureC as number);
    const value = values.reduce((sum, v) => sum + v, 0) / values.length;
    const confidence = recent.length > 0 ? 1 : 0.5;

    return { id: 'temperatureRollingAvg1h', value, confidence, meta: { windowHours: 1, sampleSize: sample.length } };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/indicators/temperatureRollingAvg1h.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/indicators/temperatureRollingAvg1h.ts backend/src/inference/indicators/temperatureRollingAvg1h.test.ts
git commit -m "feat(inference): add temperatureRollingAvg1h indicator"
```

---

### Task 7: Indicator — `dryingRateDeviationSigma`

**Files:**
- Create: `backend/src/inference/indicators/dryingRateDeviationSigma.ts`
- Test: `backend/src/inference/indicators/dryingRateDeviationSigma.test.ts`

**Interfaces:**
- Consumes: same as Task 5.
- Produces: `dryingRateDeviationSigma: IndicatorDefinition` — consumed by Task 10
  (`facts/dryingRateUnusuallyFast.ts`) and Task 8 (indicators `index.ts`).

**Design note (deviation from the spec's prose, stated explicitly)**: day boundaries use UTC
calendar days (`toISOString().slice(0, 10)`), not the device's configured timezone the way
`dailyLightIntegral.ts` does for DLI. Acceptable simplification for a multi-day trend indicator
(unlike a single day's light integral, a several-day drying trend is not meaningfully distorted by
a few hours of boundary misalignment) — flagged here rather than silently copied.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { dryingRateDeviationSigma } from './dryingRateDeviationSigma.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
const DAY_MS = 24 * 3_600_000;

function readingsForDay(daysAgo: number, startPercent: number, endPercent: number) {
  const dayStart = new Date(Date.now() - daysAgo * DAY_MS);
  dayStart.setUTCHours(0, 0, 0, 0);
  return [
    fakeReading({ timestamp: new Date(dayStart.getTime() + 1 * 3_600_000), soilMoisturePercent: startPercent }),
    fakeReading({ timestamp: new Date(dayStart.getTime() + 20 * 3_600_000), soilMoisturePercent: endPercent }),
  ];
}

describe('dryingRateDeviationSigma', () => {
  it('returns null when there are fewer than 5 baseline days', () => {
    const readings = [...readingsForDay(2, 50, 45), ...readingsForDay(1, 50, 45), ...readingsForDay(0, 50, 30)];
    const result = dryingRateDeviationSigma.compute({ readings, wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });

  it('reports a strongly positive sigma when today dries much faster than a stable baseline', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat(); // ~5%/day baseline
    const today = readingsForDay(0, 50, 20); // ~30%/day today — far above baseline
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env);
    assert.ok(result.value != null && result.value > 2, `expected sigma > 2, got ${result.value}`);
  });

  it('returns null when today has no reading pair to compute a rate from', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const result = dryingRateDeviationSigma.compute({ readings: baselineDays, wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/indicators/dryingRateDeviationSigma.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/indicators/dryingRateDeviationSigma.ts`**

```ts
import type { Reading } from '@prisma/client';
import type { DeviceObservations, IndicatorDefinition, IndicatorValue } from '../types.js';

const MIN_BASELINE_DAYS = 5;
const BASELINE_WINDOW_DAYS = 14;
const MIN_HOURS_FOR_TODAY_RATE = 2;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// Positive = drying (losing moisture) over the day; negative = gaining (e.g. after watering).
function dailyRate(dayReadings: Reading[]): number | null {
  if (dayReadings.length < 2) return null;
  const first = dayReadings[0];
  const last = dayReadings[dayReadings.length - 1];
  const hours = (last.timestamp.getTime() - first.timestamp.getTime()) / 3_600_000;
  if (hours < MIN_HOURS_FOR_TODAY_RATE) return null;
  return (((first.soilMoisturePercent as number) - (last.soilMoisturePercent as number)) / hours) * 24;
}

export const dryingRateDeviationSigma: IndicatorDefinition = {
  id: 'dryingRateDeviationSigma',
  requiredFields: ['soilMoisturePercent'],
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

    const mean = recentBaselineRates.reduce((sum, r) => sum + r, 0) / recentBaselineRates.length;
    const variance = recentBaselineRates.reduce((sum, r) => sum + (r - mean) ** 2, 0) / recentBaselineRates.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev === 0) return { id: 'dryingRateDeviationSigma', value: null, confidence: 0, meta: { sampleSize: recentBaselineRates.length } };

    const sigma = (todayRate - mean) / stdDev;
    const confidence = Math.min(1, recentBaselineRates.length / BASELINE_WINDOW_DAYS);

    return { id: 'dryingRateDeviationSigma', value: sigma, confidence, meta: { sampleSize: recentBaselineRates.length } };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/indicators/dryingRateDeviationSigma.test.ts`
Expected: PASS. If the "strongly positive sigma" case doesn't clear `> 2` on the first run, adjust
the test fixture's percentages (not the implementation) — hand-authoring a synthetic time series to
hit a specific statistical threshold sometimes needs one iteration; this is expected, not a bug.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/indicators/dryingRateDeviationSigma.ts backend/src/inference/indicators/dryingRateDeviationSigma.test.ts
git commit -m "feat(inference): add dryingRateDeviationSigma indicator"
```

---

### Task 8: Indicator — `wateringIntervalDeviationSigma` + Indicators registry

**Files:**
- Create: `backend/src/inference/indicators/wateringIntervalDeviationSigma.ts`
- Test: `backend/src/inference/indicators/wateringIntervalDeviationSigma.test.ts`
- Create: `backend/src/inference/indicators/index.ts`
- Test: `backend/src/inference/indicators/index.test.ts`

**Interfaces:**
- Consumes: `IndicatorDefinition`, `DeviceObservations`, `fakeWateringEvent` (Task 1); the 3
  indicators from Tasks 5–7.
- Produces: `wateringIntervalDeviationSigma: IndicatorDefinition`; `indicatorDefinitions:
  IndicatorDefinition[]` — consumed by Task 16 (`registry.ts`).

**Design note**: `requiredFields: []` — this indicator depends on `WateringEvent`, not any `Reading`
field, so the engine's capability gating (Task 4) always treats it as supported. On a device with no
pump (e.g. Xiaomi), `observations.wateringEvents` is simply always empty, so it harmlessly returns
`{ value: null, confidence: 0 }` rather than being skipped outright — a known, accepted minor
inefficiency (wasted computation, never incorrect output), since `DeviceCapabilities` has no
"can-water" category to gate on.

- [ ] **Step 1: Write the failing test — `wateringIntervalDeviationSigma.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeWateringEvent } from '../testHelpers.js';
import { wateringIntervalDeviationSigma } from './wateringIntervalDeviationSigma.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
const DAY_MS = 24 * 3_600_000;

describe('wateringIntervalDeviationSigma', () => {
  it('returns null with no successful watering events', () => {
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });

  it('returns null with fewer than 3 historical intervals', () => {
    const events = [fakeWateringEvent({ timestamp: new Date(Date.now() - 8 * DAY_MS) }), fakeWateringEvent({ timestamp: new Date(Date.now() - 4 * DAY_MS) })];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env);
    assert.equal(result.value, null);
  });

  it('reports a positive sigma when the current gap is far longer than a regular history', () => {
    const events = [
      fakeWateringEvent({ timestamp: new Date(Date.now() - 40 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(Date.now() - 36 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(Date.now() - 32 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(Date.now() - 28 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(Date.now() - 15 * DAY_MS) }), // 13-day gap since — the "current" gap
    ];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env);
    assert.ok(result.value != null && result.value > 2, `expected sigma > 2, got ${result.value}`);
  });

  it('ignores failed watering events', () => {
    const events = [fakeWateringEvent({ timestamp: new Date(Date.now() - DAY_MS), success: false })];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env);
    assert.equal(result.value, null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/indicators/wateringIntervalDeviationSigma.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/indicators/wateringIntervalDeviationSigma.ts`**

```ts
import type { DeviceObservations, IndicatorDefinition, IndicatorValue } from '../types.js';

const MIN_BASELINE_INTERVALS = 3;

export const wateringIntervalDeviationSigma: IndicatorDefinition = {
  id: 'wateringIntervalDeviationSigma',
  requiredFields: [],
  compute(observations: DeviceObservations): IndicatorValue {
    const successful = observations.wateringEvents.filter((event) => event.success).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
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
    if (stdDev === 0) return { id: 'wateringIntervalDeviationSigma', value: null, confidence: 0, meta: { sampleSize: intervalsHours.length } };

    const lastWatering = successful[successful.length - 1];
    const currentGapHours = (Date.now() - lastWatering.timestamp.getTime()) / 3_600_000;
    const sigma = (currentGapHours - mean) / stdDev;
    const confidence = Math.min(1, intervalsHours.length / (MIN_BASELINE_INTERVALS * 2));

    return { id: 'wateringIntervalDeviationSigma', value: sigma, confidence, meta: { sampleSize: intervalsHours.length } };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/indicators/wateringIntervalDeviationSigma.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test — `index.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { indicatorDefinitions } from './index.js';

describe('indicator registry', () => {
  it('registers exactly the 4 V1-slice indicators, each with a unique id', () => {
    const ids = indicatorDefinitions.map((d) => d.id);
    assert.deepEqual(ids.sort(), ['dryingRateDeviationSigma', 'soilMoistureRollingAvg1h', 'temperatureRollingAvg1h', 'wateringIntervalDeviationSigma']);
    assert.equal(new Set(ids).size, ids.length);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx tsx --test src/inference/indicators/index.test.ts`
Expected: FAIL.

- [ ] **Step 7: Write `backend/src/inference/indicators/index.ts`**

```ts
import { dryingRateDeviationSigma } from './dryingRateDeviationSigma.js';
import { soilMoistureRollingAvg1h } from './soilMoistureRollingAvg1h.js';
import { temperatureRollingAvg1h } from './temperatureRollingAvg1h.js';
import { wateringIntervalDeviationSigma } from './wateringIntervalDeviationSigma.js';
import type { IndicatorDefinition } from '../types.js';

export const indicatorDefinitions: IndicatorDefinition[] = [soilMoistureRollingAvg1h, temperatureRollingAvg1h, dryingRateDeviationSigma, wateringIntervalDeviationSigma];
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx tsx --test src/inference/indicators/index.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/inference/indicators/wateringIntervalDeviationSigma.ts backend/src/inference/indicators/wateringIntervalDeviationSigma.test.ts backend/src/inference/indicators/index.ts backend/src/inference/indicators/index.test.ts
git commit -m "feat(inference): add wateringIntervalDeviationSigma indicator and the indicators registry"
```

---

### Task 9: Fact — `soil_moisture_below_profile_min`

**Files:**
- Create: `backend/src/inference/facts/soilMoistureBelowProfileMin.ts`
- Test: `backend/src/inference/facts/soilMoistureBelowProfileMin.test.ts`

**Interfaces:**
- Consumes: `FactDefinition`, `IndicatorIndex`, `ReferenceProfile` (Task 1).
- Produces: `soilMoistureBelowProfileMin: FactDefinition` — consumed by Task 11 (Facts registry)
  and Task 12 (`symptoms/waterStress.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { soilMoistureBelowProfileMin } from './soilMoistureBelowProfileMin.js';
import type { IndicatorIndex, ReferenceProfile } from '../types.js';

function indicators(value: number | null): IndicatorIndex {
  return new Map([['soilMoistureRollingAvg1h', { id: 'soilMoistureRollingAvg1h', value, confidence: 1 }]]);
}

const profile: ReferenceProfile = { soilMoisturePercent: { min: 35, max: 65 } };

describe('soil_moisture_below_profile_min', () => {
  it('holds when the indicator is below the profile minimum', () => {
    const result = soilMoistureBelowProfileMin.evaluate(indicators(20), profile);
    assert.equal(result?.holds, true);
    assert.equal(result?.evidence?.currentValue, 20);
    assert.equal(result?.evidence?.minimumExpected, 35);
  });

  it('does not hold when the indicator is within range', () => {
    assert.equal(soilMoistureBelowProfileMin.evaluate(indicators(50), profile)?.holds, false);
  });

  it('is null when there is no profile', () => {
    assert.equal(soilMoistureBelowProfileMin.evaluate(indicators(20), null), null);
  });

  it('is null when the indicator has no value', () => {
    assert.equal(soilMoistureBelowProfileMin.evaluate(indicators(null), profile), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/facts/soilMoistureBelowProfileMin.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/facts/soilMoistureBelowProfileMin.ts`**

```ts
import type { FactDefinition } from '../types.js';

export const soilMoistureBelowProfileMin: FactDefinition = {
  id: 'soil_moisture_below_profile_min',
  needsProfile: true,
  requiredIndicators: ['soilMoistureRollingAvg1h'],
  evaluate(indicators, profile) {
    const indicator = indicators.get('soilMoistureRollingAvg1h');
    const min = profile?.soilMoisturePercent?.min;
    if (!indicator || indicator.value == null || min == null) return null;

    return {
      id: 'soil_moisture_below_profile_min',
      holds: indicator.value < min,
      confidence: indicator.confidence,
      supportingIndicators: ['soilMoistureRollingAvg1h'],
      evidence: { currentValue: indicator.value, minimumExpected: min },
    };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/facts/soilMoistureBelowProfileMin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/facts/soilMoistureBelowProfileMin.ts backend/src/inference/facts/soilMoistureBelowProfileMin.test.ts
git commit -m "feat(inference): add soil_moisture_below_profile_min fact"
```

---

### Task 10: Fact — `drying_rate_unusually_fast`

**Files:**
- Create: `backend/src/inference/facts/dryingRateUnusuallyFast.ts`
- Test: `backend/src/inference/facts/dryingRateUnusuallyFast.test.ts`

**Interfaces:**
- Consumes: same as Task 9.
- Produces: `dryingRateUnusuallyFast: FactDefinition` — consumed by Task 11 and Task 12.

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dryingRateUnusuallyFast } from './dryingRateUnusuallyFast.js';
import type { IndicatorIndex } from '../types.js';

function indicators(value: number | null): IndicatorIndex {
  return new Map([['dryingRateDeviationSigma', { id: 'dryingRateDeviationSigma', value, confidence: 0.9 }]]);
}

describe('drying_rate_unusually_fast', () => {
  it('holds when sigma is above 2', () => {
    assert.equal(dryingRateUnusuallyFast.evaluate(indicators(2.5), null)?.holds, true);
  });

  it('does not hold when sigma is at or below 2', () => {
    assert.equal(dryingRateUnusuallyFast.evaluate(indicators(1.2), null)?.holds, false);
  });

  it('is null when the indicator is unavailable', () => {
    assert.equal(dryingRateUnusuallyFast.evaluate(indicators(null), null), null);
  });

  it('does not need a profile', () => {
    assert.equal(dryingRateUnusuallyFast.needsProfile, false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/facts/dryingRateUnusuallyFast.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/facts/dryingRateUnusuallyFast.ts`**

```ts
import type { FactDefinition } from '../types.js';

const SIGNIFICANT_SIGMA = 2;

export const dryingRateUnusuallyFast: FactDefinition = {
  id: 'drying_rate_unusually_fast',
  needsProfile: false,
  requiredIndicators: ['dryingRateDeviationSigma'],
  evaluate(indicators) {
    const indicator = indicators.get('dryingRateDeviationSigma');
    if (!indicator || indicator.value == null) return null;

    return {
      id: 'drying_rate_unusually_fast',
      holds: indicator.value > SIGNIFICANT_SIGMA,
      confidence: indicator.confidence,
      supportingIndicators: ['dryingRateDeviationSigma'],
      evidence: { sigma: indicator.value },
    };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/facts/dryingRateUnusuallyFast.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/facts/dryingRateUnusuallyFast.ts backend/src/inference/facts/dryingRateUnusuallyFast.test.ts
git commit -m "feat(inference): add drying_rate_unusually_fast fact"
```

---

### Task 11: Fact — `watering_interval_unusually_long` + Facts registry

**Files:**
- Create: `backend/src/inference/facts/wateringIntervalUnusuallyLong.ts`
- Test: `backend/src/inference/facts/wateringIntervalUnusuallyLong.test.ts`
- Create: `backend/src/inference/facts/index.ts`
- Test: `backend/src/inference/facts/index.test.ts`

**Interfaces:**
- Consumes: same as Task 9; the 2 Facts from Tasks 9–10.
- Produces: `wateringIntervalUnusuallyLong: FactDefinition`; `factDefinitions: FactDefinition[]` —
  consumed by Task 16.

- [ ] **Step 1: Write the failing test — `wateringIntervalUnusuallyLong.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { wateringIntervalUnusuallyLong } from './wateringIntervalUnusuallyLong.js';
import type { IndicatorIndex } from '../types.js';

function indicators(value: number | null): IndicatorIndex {
  return new Map([['wateringIntervalDeviationSigma', { id: 'wateringIntervalDeviationSigma', value, confidence: 0.9 }]]);
}

describe('watering_interval_unusually_long', () => {
  it('holds when sigma is above 2', () => {
    assert.equal(wateringIntervalUnusuallyLong.evaluate(indicators(3), null)?.holds, true);
  });

  it('does not hold otherwise', () => {
    assert.equal(wateringIntervalUnusuallyLong.evaluate(indicators(0.5), null)?.holds, false);
  });

  it('is null when unavailable', () => {
    assert.equal(wateringIntervalUnusuallyLong.evaluate(indicators(null), null), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/facts/wateringIntervalUnusuallyLong.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/facts/wateringIntervalUnusuallyLong.ts`**

```ts
import type { FactDefinition } from '../types.js';

const SIGNIFICANT_SIGMA = 2;

export const wateringIntervalUnusuallyLong: FactDefinition = {
  id: 'watering_interval_unusually_long',
  needsProfile: false,
  requiredIndicators: ['wateringIntervalDeviationSigma'],
  evaluate(indicators) {
    const indicator = indicators.get('wateringIntervalDeviationSigma');
    if (!indicator || indicator.value == null) return null;

    return {
      id: 'watering_interval_unusually_long',
      holds: indicator.value > SIGNIFICANT_SIGMA,
      confidence: indicator.confidence,
      supportingIndicators: ['wateringIntervalDeviationSigma'],
      evidence: { sigma: indicator.value },
    };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/facts/wateringIntervalUnusuallyLong.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test — `index.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { factDefinitions } from './index.js';

describe('fact registry', () => {
  it('registers exactly the 3 V1-slice facts, each with a unique id', () => {
    const ids = factDefinitions.map((d) => d.id);
    assert.deepEqual(ids.sort(), ['drying_rate_unusually_fast', 'soil_moisture_below_profile_min', 'watering_interval_unusually_long']);
    assert.equal(new Set(ids).size, ids.length);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx tsx --test src/inference/facts/index.test.ts`
Expected: FAIL.

- [ ] **Step 7: Write `backend/src/inference/facts/index.ts`**

```ts
import { dryingRateUnusuallyFast } from './dryingRateUnusuallyFast.js';
import { soilMoistureBelowProfileMin } from './soilMoistureBelowProfileMin.js';
import { wateringIntervalUnusuallyLong } from './wateringIntervalUnusuallyLong.js';
import type { FactDefinition } from '../types.js';

export const factDefinitions: FactDefinition[] = [soilMoistureBelowProfileMin, dryingRateUnusuallyFast, wateringIntervalUnusuallyLong];
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx tsx --test src/inference/facts/index.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/inference/facts/wateringIntervalUnusuallyLong.ts backend/src/inference/facts/wateringIntervalUnusuallyLong.test.ts backend/src/inference/facts/index.ts backend/src/inference/facts/index.test.ts
git commit -m "feat(inference): add watering_interval_unusually_long fact and the facts registry"
```

---

### Task 12: Symptom — `water_stress`

**Files:**
- Create: `backend/src/inference/symptoms/waterStress.ts`
- Test: `backend/src/inference/symptoms/waterStress.test.ts`

**Interfaces:**
- Consumes: `SymptomRule`, `InferenceContext`, `EvidenceItem` (Task 1); `combineWeightedEvidence`,
  `combineNoisyOr`, `computeCoverage`, `sigmoid` (Task 2); `factEvidence`, `indicatorEvidence`
  (Task 2).
- Produces: `waterStress: SymptomRule` — consumed by Task 13 (Symptoms registry) and Task 14
  (`diagnoses/chronicUnderwatering.ts`).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { waterStress } from './waterStress.js';
import type { EnvironmentContext, FactSnapshot, IndicatorIndex } from '../types.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };

describe('water_stress', () => {
  it('reports high severity when soil is dry, drying fast, and it is hot', () => {
    const facts: FactSnapshot = new Map([
      ['soil_moisture_below_profile_min', { id: 'soil_moisture_below_profile_min', holds: true, confidence: 1, supportingIndicators: [] }],
      ['drying_rate_unusually_fast', { id: 'drying_rate_unusually_fast', holds: true, confidence: 1, supportingIndicators: [] }],
    ]);
    const indicators: IndicatorIndex = new Map([['temperatureRollingAvg1h', { id: 'temperatureRollingAvg1h', value: 32, confidence: 1 }]]);

    const result = waterStress.evaluate({ indicators, facts, environment: env });
    assert.ok(result != null);
    assert.ok(result.severity > 0.7, `expected severity > 0.7, got ${result.severity}`);
    assert.ok(result.confidence > 0.7, `expected confidence > 0.7, got ${result.confidence}`);
    assert.equal(result.coverage.ratio, 1);
  });

  it('is null when none of its evidence is available', () => {
    const result = waterStress.evaluate({ indicators: new Map(), facts: new Map(), environment: env });
    assert.equal(result, null);
  });

  it('has reduced coverage when only some evidence is available', () => {
    const facts: FactSnapshot = new Map([['soil_moisture_below_profile_min', { id: 'soil_moisture_below_profile_min', holds: true, confidence: 1, supportingIndicators: [] }]]);
    const result = waterStress.evaluate({ indicators: new Map(), facts, environment: env });
    assert.ok(result != null && result.coverage.ratio < 1 && result.coverage.ratio > 0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/symptoms/waterStress.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/symptoms/waterStress.ts`**

```ts
import { factEvidence, indicatorEvidence } from '../adapters.js';
import { combineNoisyOr, combineWeightedEvidence, computeCoverage, sigmoid } from '../evidence.js';
import type { EvidenceItem, SymptomRule } from '../types.js';

// Temperature midpoint below which heat doesn't meaningfully add to water stress — an initial
// estimate (not derived from data), pending real-world recalibration per the spec's Calibration
// Layer section (deferred to a later increment, not built in this plan).
const HEAT_CONTRIBUTION_MIDPOINT_C = 28;
const HEAT_CONTRIBUTION_STEEPNESS = 0.3;

export const waterStress: SymptomRule = {
  id: 'water_stress',
  consumes: { facts: ['soil_moisture_below_profile_min', 'drying_rate_unusually_fast'], indicators: ['temperatureRollingAvg1h'] },
  evaluate(ctx) {
    const items: EvidenceItem[] = [
      factEvidence(ctx.facts, 'soil_moisture_below_profile_min', 0.5),
      factEvidence(ctx.facts, 'drying_rate_unusually_fast', 0.3),
      indicatorEvidence(ctx.indicators, 'temperatureRollingAvg1h', 0.2, (value) => sigmoid(value, HEAT_CONTRIBUTION_MIDPOINT_C, HEAT_CONTRIBUTION_STEEPNESS)),
    ];

    const { value: severity } = combineWeightedEvidence(items);
    if (severity == null) return null;

    const { confidence, breakdown } = combineNoisyOr(items);
    const coverage = computeCoverage(items);

    return {
      id: 'water_stress',
      severity,
      confidence,
      coverage,
      supportingFacts: ['soil_moisture_below_profile_min', 'drying_rate_unusually_fast'],
      evidenceBreakdown: breakdown,
    };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/symptoms/waterStress.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/symptoms/waterStress.ts backend/src/inference/symptoms/waterStress.test.ts
git commit -m "feat(inference): add water_stress symptom"
```

---

### Task 13: Symptom — `irregular_watering` + Symptoms registry

**Files:**
- Create: `backend/src/inference/symptoms/irregularWatering.ts`
- Test: `backend/src/inference/symptoms/irregularWatering.test.ts`
- Create: `backend/src/inference/symptoms/index.ts`
- Test: `backend/src/inference/symptoms/index.test.ts`

**Interfaces:**
- Consumes: same as Task 12; `waterStress` from Task 12.
- Produces: `irregularWatering: SymptomRule`; `symptomRules: SymptomRule[]` — consumed by Task 14.

- [ ] **Step 1: Write the failing test — `irregularWatering.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { irregularWatering } from './irregularWatering.js';
import type { EnvironmentContext, FactSnapshot } from '../types.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };

describe('irregular_watering', () => {
  it('reports full severity when the fact holds', () => {
    const facts: FactSnapshot = new Map([['watering_interval_unusually_long', { id: 'watering_interval_unusually_long', holds: true, confidence: 0.9, supportingIndicators: [] }]]);
    const result = irregularWatering.evaluate({ indicators: new Map(), facts, environment: env });
    assert.equal(result?.severity, 1);
    assert.ok(result != null && result.confidence > 0);
  });

  it('reports zero severity when the fact does not hold', () => {
    const facts: FactSnapshot = new Map([['watering_interval_unusually_long', { id: 'watering_interval_unusually_long', holds: false, confidence: 0.9, supportingIndicators: [] }]]);
    const result = irregularWatering.evaluate({ indicators: new Map(), facts, environment: env });
    assert.equal(result?.severity, 0);
  });

  it('is null when the fact is unavailable', () => {
    assert.equal(irregularWatering.evaluate({ indicators: new Map(), facts: new Map(), environment: env }), null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/symptoms/irregularWatering.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/symptoms/irregularWatering.ts`**

```ts
import { factEvidence } from '../adapters.js';
import { combineNoisyOr, combineWeightedEvidence, computeCoverage } from '../evidence.js';
import type { EvidenceItem, SymptomRule } from '../types.js';

export const irregularWatering: SymptomRule = {
  id: 'irregular_watering',
  consumes: { facts: ['watering_interval_unusually_long'], indicators: [] },
  evaluate(ctx) {
    const items: EvidenceItem[] = [factEvidence(ctx.facts, 'watering_interval_unusually_long', 1)];

    const { value: severity } = combineWeightedEvidence(items);
    if (severity == null) return null;

    const { confidence, breakdown } = combineNoisyOr(items);
    const coverage = computeCoverage(items);

    return {
      id: 'irregular_watering',
      severity,
      confidence,
      coverage,
      supportingFacts: ['watering_interval_unusually_long'],
      evidenceBreakdown: breakdown,
    };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/symptoms/irregularWatering.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test — `index.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { symptomRules } from './index.js';

describe('symptom registry', () => {
  it('registers exactly the 2 V1-slice symptoms, each with a unique id', () => {
    const ids = symptomRules.map((r) => r.id);
    assert.deepEqual(ids.sort(), ['irregular_watering', 'water_stress']);
    assert.equal(new Set(ids).size, ids.length);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx tsx --test src/inference/symptoms/index.test.ts`
Expected: FAIL.

- [ ] **Step 7: Write `backend/src/inference/symptoms/index.ts`**

```ts
import { irregularWatering } from './irregularWatering.js';
import { waterStress } from './waterStress.js';
import type { SymptomRule } from '../types.js';

export const symptomRules: SymptomRule[] = [waterStress, irregularWatering];
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx tsx --test src/inference/symptoms/index.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/inference/symptoms/irregularWatering.ts backend/src/inference/symptoms/irregularWatering.test.ts backend/src/inference/symptoms/index.ts backend/src/inference/symptoms/index.test.ts
git commit -m "feat(inference): add irregular_watering symptom and the symptoms registry"
```

---

### Task 14: Diagnosis — `chronic_underwatering` + Diagnoses registry

**Files:**
- Create: `backend/src/inference/diagnoses/chronicUnderwatering.ts`
- Test: `backend/src/inference/diagnoses/chronicUnderwatering.test.ts`
- Create: `backend/src/inference/diagnoses/index.ts`
- Test: `backend/src/inference/diagnoses/index.test.ts`

**Interfaces:**
- Consumes: `DiagnosisRule`, `InferenceContext`, `SymptomSnapshot` (Task 1); `symptomEvidence`
  (Task 2); `water_stress`/`irregular_watering` symptom ids (Tasks 12–13).
- Produces: `chronicUnderwatering: DiagnosisRule`; `diagnosisRules: DiagnosisRule[]` — consumed by
  Task 15 (`recommendations/triggerWatering.ts`) and Task 16.

- [ ] **Step 1: Write the failing test — `chronicUnderwatering.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chronicUnderwatering } from './chronicUnderwatering.js';
import type { EnvironmentContext, SymptomSnapshot } from '../types.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };
const emptyBreakdown = { formula: 'weightedAverage' as const, items: [], missing: [] };

describe('chronic_underwatering', () => {
  it('combines water_stress and irregular_watering into a diagnosis with real interpretation (not an alias)', () => {
    const symptoms: SymptomSnapshot = new Map([
      ['water_stress', { id: 'water_stress', severity: 0.8, confidence: 0.9, coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 }, supportingFacts: [], evidenceBreakdown: emptyBreakdown }],
      ['irregular_watering', { id: 'irregular_watering', severity: 1, confidence: 0.8, coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 }, supportingFacts: [], evidenceBreakdown: emptyBreakdown }],
    ]);
    const result = chronicUnderwatering.evaluate({ indicators: new Map(), facts: new Map(), environment: env, symptoms });
    assert.ok(result != null);
    // Not equal to water_stress's own severity (0.8) — genuinely combines both symptoms.
    assert.notEqual(result.severity, 0.8);
    assert.ok(result.severity > 0.8, `expected combined severity above water_stress alone, got ${result.severity}`);
  });

  it('is null when neither contributing symptom is present', () => {
    const result = chronicUnderwatering.evaluate({ indicators: new Map(), facts: new Map(), environment: env, symptoms: new Map() });
    assert.equal(result, null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/diagnoses/chronicUnderwatering.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/diagnoses/chronicUnderwatering.ts`**

```ts
import { symptomEvidence } from '../adapters.js';
import { combineNoisyOr, combineWeightedEvidence, computeCoverage } from '../evidence.js';
import type { DiagnosisRule, EvidenceItem } from '../types.js';

export const chronicUnderwatering: DiagnosisRule = {
  id: 'chronic_underwatering',
  consumes: { symptoms: ['water_stress', 'irregular_watering'] },
  evaluate(ctx) {
    const items: EvidenceItem[] = [symptomEvidence(ctx.symptoms, 'water_stress', 0.65), symptomEvidence(ctx.symptoms, 'irregular_watering', 0.35)];

    const { value: severity } = combineWeightedEvidence(items);
    if (severity == null) return null;

    const { confidence, breakdown } = combineNoisyOr(items);
    const coverage = computeCoverage(items);

    return { id: 'chronic_underwatering', severity, confidence, coverage, evidenceBreakdown: breakdown };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/diagnoses/chronicUnderwatering.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test — `index.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { diagnosisRules } from './index.js';

describe('diagnosis registry', () => {
  it('registers exactly the 1 V1-slice diagnosis', () => {
    assert.deepEqual(diagnosisRules.map((r) => r.id), ['chronic_underwatering']);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx tsx --test src/inference/diagnoses/index.test.ts`
Expected: FAIL.

- [ ] **Step 7: Write `backend/src/inference/diagnoses/index.ts`**

```ts
import { chronicUnderwatering } from './chronicUnderwatering.js';
import type { DiagnosisRule } from '../types.js';

export const diagnosisRules: DiagnosisRule[] = [chronicUnderwatering];
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx tsx --test src/inference/diagnoses/index.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/inference/diagnoses/chronicUnderwatering.ts backend/src/inference/diagnoses/chronicUnderwatering.test.ts backend/src/inference/diagnoses/index.ts backend/src/inference/diagnoses/index.test.ts
git commit -m "feat(inference): add chronic_underwatering diagnosis and the diagnoses registry"
```

---

### Task 15: Recommendation — `trigger_watering` + Recommendations registry

**Files:**
- Create: `backend/src/inference/recommendations/triggerWatering.ts`
- Test: `backend/src/inference/recommendations/triggerWatering.test.ts`
- Create: `backend/src/inference/recommendations/index.ts`
- Test: `backend/src/inference/recommendations/index.test.ts`

**Interfaces:**
- Consumes: `RecommendationRule`, `DiagnosisFinding`, `OperationalConstraints` (Task 1);
  `diagnosisEvidence`, `operationalEvidence` (Task 2); `combineNoisyOr` (Task 2).
- Produces: `triggerWatering: RecommendationRule`; `recommendationRules: RecommendationRule[]` —
  consumed by Task 16.

- [ ] **Step 1: Write the failing test — `triggerWatering.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { triggerWatering } from './triggerWatering.js';
import type { DiagnosisFinding, EnvironmentContext, InferenceContext, OperationalConstraints } from '../types.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };

function ctx(operationalConstraints: OperationalConstraints): InferenceContext & { operationalConstraints: OperationalConstraints } {
  return { indicators: new Map(), facts: new Map(), environment: env, operationalConstraints };
}

const diagnosis: DiagnosisFinding = {
  id: 'chronic_underwatering',
  severity: 0.8,
  confidence: 0.85,
  coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
  tier: 'dominant',
  evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
};

describe('trigger_watering', () => {
  it('recommends TRIGGER_WATERING with high confidence when there is no cooldown', () => {
    const result = triggerWatering.evaluate(diagnosis, ctx({ autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: false }));
    assert.equal(result?.action, 'TRIGGER_WATERING');
    assert.equal(result?.triggeredBy, 'chronic_underwatering');
    assert.ok(result != null && result.confidence > 0.7);
  });

  it('has lower confidence when a cooldown is active', () => {
    const withoutCooldown = triggerWatering.evaluate(diagnosis, ctx({ autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: false }));
    const withCooldown = triggerWatering.evaluate(diagnosis, ctx({ autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: true }));
    assert.ok(withoutCooldown != null && withCooldown != null && withCooldown.confidence < withoutCooldown.confidence);
  });

  it('only triggers on chronic_underwatering', () => {
    assert.deepEqual(triggerWatering.triggers, ['chronic_underwatering']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/recommendations/triggerWatering.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/recommendations/triggerWatering.ts`**

```ts
import { diagnosisEvidence, operationalEvidence } from '../adapters.js';
import { combineNoisyOr } from '../evidence.js';
import type { EvidenceItem, RecommendationRule } from '../types.js';

export const triggerWatering: RecommendationRule = {
  id: 'trigger_watering',
  triggers: ['chronic_underwatering'],
  evaluate(diagnosis, ctx) {
    const items: EvidenceItem[] = [diagnosisEvidence(diagnosis, 1), operationalEvidence('cooldown_active', ctx.operationalConstraints.cooldownActive, 1, 'contradicts')];

    const { confidence, breakdown } = combineNoisyOr(items);

    return { action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence, triggeredBy: diagnosis.id, evidenceBreakdown: breakdown };
  },
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/recommendations/triggerWatering.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test — `index.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { recommendationRules } from './index.js';

describe('recommendation registry', () => {
  it('registers exactly the 1 V1-slice recommendation', () => {
    assert.deepEqual(recommendationRules.map((r) => r.id), ['trigger_watering']);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx tsx --test src/inference/recommendations/index.test.ts`
Expected: FAIL.

- [ ] **Step 7: Write `backend/src/inference/recommendations/index.ts`**

```ts
import { triggerWatering } from './triggerWatering.js';
import type { RecommendationRule } from '../types.js';

export const recommendationRules: RecommendationRule[] = [triggerWatering];
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx tsx --test src/inference/recommendations/index.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/inference/recommendations/triggerWatering.ts backend/src/inference/recommendations/triggerWatering.test.ts backend/src/inference/recommendations/index.ts backend/src/inference/recommendations/index.test.ts
git commit -m "feat(inference): add trigger_watering recommendation and the recommendations registry"
```

---

### Task 16: Full registry wiring + end-to-end integration tests

**Files:**
- Create: `backend/src/inference/registry.ts`
- Test: `backend/src/inference/registry.test.ts`

**Interfaces:**
- Consumes: `InferenceEngine` (Task 4); `indicatorDefinitions`/`factDefinitions`/`symptomRules`/
  `diagnosisRules`/`recommendationRules` (Tasks 8, 11, 13, 14, 15); `fakeReading`/
  `fakeWateringEvent` (Task 1).
- Produces: `inferenceEngine: InferenceEngine` — the fully wired, ready-to-use V1 engine instance.
  Nothing outside this plan consumes it yet (that's Phase B/C, out of scope) — this task's job is
  to prove, end to end, that the vertical slice actually fires.

**Test design note, worth understanding before writing this task**: the individual pure functions
(sigmoid, the two combinators, each Indicator/Fact/Symptom/Diagnosis/Recommendation's own math) are
already exhaustively unit-tested with precise numeric assertions in Tasks 2–15. This integration
test does **not** re-assert exact floating-point values — it asserts on *structure and wiring*: do
the right ids show up at each layer, does a diagnosis appear, does a recommendation appear. That
split is deliberate good test design: unit tests pin down the math, integration tests prove the
layers are actually connected correctly.

- [ ] **Step 1: Write the failing tests — `registry.test.ts`**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading, fakeWateringEvent } from './testHelpers.js';
import { inferenceEngine } from './registry.js';
import type { EnvironmentContext, ReferenceProfile } from './types.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: 'INDOOR', capabilities: ['soilMoisture', 'temperature'], observationsAvailability: {} };
const profile: ReferenceProfile = { soilMoisturePercent: { min: 35, max: 65 }, temperatureC: { min: 12, max: 32 } };
const operational = { autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: false };
const DAY_MS = 24 * 3_600_000;

function healthyHistory() {
  const readings = [];
  const wateringEvents = [];
  // 16 days of a stable 4-day watering cycle: 60% -> 40% then reset, well within the 35-65 profile range.
  for (let day = 16; day >= 0; day--) {
    const cyclePosition = (16 - day) % 4;
    const moisture = 60 - cyclePosition * 5;
    readings.push(fakeReading({ timestamp: new Date(Date.now() - day * DAY_MS - 2 * 3_600_000), soilMoisturePercent: moisture, temperatureC: 22 }));
    readings.push(fakeReading({ timestamp: new Date(Date.now() - day * DAY_MS - 20 * 3_600_000), soilMoisturePercent: moisture - 5, temperatureC: 22 }));
    if (cyclePosition === 3) wateringEvents.push(fakeWateringEvent({ timestamp: new Date(Date.now() - day * DAY_MS) }));
  }
  return { readings, wateringEvents };
}

function underwateredHistory() {
  const { readings, wateringEvents } = healthyHistory();
  // Drop every watering event more recent than 12 days ago, and crash today's moisture far below
  // the profile minimum with a fast decline — deliberately far outside the healthy baseline above.
  const staleWateringEvents = wateringEvents.filter((event) => Date.now() - event.timestamp.getTime() > 12 * DAY_MS);
  const staleReadings = readings.filter((reading) => Date.now() - reading.timestamp.getTime() > 1 * DAY_MS);
  const today = [
    fakeReading({ timestamp: new Date(Date.now() - 8 * 3_600_000), soilMoisturePercent: 30, temperatureC: 29 }),
    fakeReading({ timestamp: new Date(Date.now() - 1 * 3_600_000), soilMoisturePercent: 16, temperatureC: 30 }),
  ];
  return { readings: [...staleReadings, ...today], wateringEvents: staleWateringEvents };
}

describe('inferenceEngine — chronic_underwatering vertical slice', () => {
  it('produces no diagnosis or recommendation for a healthy watering history', () => {
    const result = inferenceEngine.run(healthyHistory(), profile, env, operational);
    assert.equal(result.diagnoses.length, 0);
    assert.equal(result.recommendations.length, 0);
  });

  it('produces chronic_underwatering and a TRIGGER_WATERING recommendation for a genuinely underwatered device', () => {
    const result = inferenceEngine.run(underwateredHistory(), profile, env, operational);

    assert.equal(result.facts.get('soil_moisture_below_profile_min')?.holds, true);
    assert.ok(result.symptoms.has('water_stress'));

    const diagnosis = result.diagnoses.find((d) => d.id === 'chronic_underwatering');
    assert.ok(diagnosis != null, 'expected a chronic_underwatering diagnosis');
    assert.notEqual(diagnosis.tier, 'weak_hypothesis');

    const recommendation = result.recommendations.find((r) => r.action === 'TRIGGER_WATERING');
    assert.ok(recommendation != null, 'expected a TRIGGER_WATERING recommendation');
    assert.deepEqual(recommendation.triggeredBy, ['chronic_underwatering']);
  });

  it('withholds the recommendation while a cooldown is active, without withholding the diagnosis', () => {
    const result = inferenceEngine.run(underwateredHistory(), profile, env, { ...operational, cooldownActive: true });
    assert.ok(result.diagnoses.some((d) => d.id === 'chronic_underwatering'), 'diagnosis is horticultural reasoning, unaffected by operational constraints');
    const recommendation = result.recommendations.find((r) => r.action === 'TRIGGER_WATERING');
    // Still present (Recommendation vs. Execution: the engine only lowers confidence, it does not
    // itself withhold the recommendation — a real scheduler consuming this would apply its own
    // independent cooldown gate on top, per the spec's "Recommendation vs. Execution" section).
    assert.ok(recommendation != null);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/registry.test.ts`
Expected: FAIL — `./registry.js` does not exist.

- [ ] **Step 3: Write `backend/src/inference/registry.ts`**

```ts
import { InferenceEngine } from './engine.js';
import { factDefinitions } from './facts/index.js';
import { indicatorDefinitions } from './indicators/index.js';
import { diagnosisRules } from './diagnoses/index.js';
import { recommendationRules } from './recommendations/index.js';
import { symptomRules } from './symptoms/index.js';

// The V1 vertical slice, fully wired. validateRegistry() runs inside the InferenceEngine
// constructor — an inconsistent registry fails at import time, not silently at request time.
export const inferenceEngine = new InferenceEngine(indicatorDefinitions, factDefinitions, symptomRules, diagnosisRules, recommendationRules);
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/registry.test.ts`
Expected: PASS. If the "underwatered" scenario doesn't produce a diagnosis on the first run, this
is the same expected hand-tuning iteration noted in Task 7 — adjust `underwateredHistory()`'s
moisture/timing values (not the engine or rule code) until the synthetic fixture genuinely
represents an underwatered device relative to its own fabricated healthy baseline.

- [ ] **Step 5: Run the full test suite**

Run (from `backend/`): `pnpm test`
Expected: PASS — every test file written across Tasks 1–16.

- [ ] **Step 6: Commit**

```bash
git add backend/src/inference/registry.ts backend/src/inference/registry.test.ts
git commit -m "feat(inference): wire the full chronic_underwatering vertical slice end to end"
```

---

### Task 17: `PlantHealthStatusDTO`

**Files:**
- Create: `backend/src/inference/dto.ts`
- Test: `backend/src/inference/dto.test.ts`

**Interfaces:**
- Consumes: `InferenceResult` (Task 1); `inferenceEngine` (Task 16, for the test only).
- Produces: `PlantHealthStatusDTO`, `toPlantHealthStatusDTO(result)` — the External
  Representations boundary the spec defines; not wired into any consumer by this plan (Phase C).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toPlantHealthStatusDTO } from './dto.js';
import type { InferenceResult } from './types.js';

const emptyBreakdown = { formula: 'noisyOr' as const, items: [], missing: [] };

describe('toPlantHealthStatusDTO', () => {
  it('maps diagnoses and recommendations to their minimal external shape only', () => {
    const result: InferenceResult = {
      indicators: new Map(),
      facts: new Map(),
      symptoms: new Map(),
      diagnoses: [{ id: 'chronic_underwatering', severity: 0.8, confidence: 0.9, coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 }, tier: 'dominant', evidenceBreakdown: emptyBreakdown }],
      recommendations: [{ action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence: 0.85, triggeredBy: ['chronic_underwatering'], importance: 0.7 }],
    };

    const dto = toPlantHealthStatusDTO(result);

    assert.deepEqual(dto, {
      diagnoses: [{ id: 'chronic_underwatering', severity: 0.8, confidence: 0.9, tier: 'dominant' }],
      recommendations: [{ action: 'TRIGGER_WATERING', confidence: 0.85 }],
    });
    // Internal-only fields (coverage, evidenceBreakdown, importance, triggeredBy) never appear.
    assert.equal('evidenceBreakdown' in dto.diagnoses[0], false);
    assert.equal('importance' in dto.recommendations[0], false);
  });

  it('returns empty arrays for an empty result', () => {
    const result: InferenceResult = { indicators: new Map(), facts: new Map(), symptoms: new Map(), diagnoses: [], recommendations: [] };
    assert.deepEqual(toPlantHealthStatusDTO(result), { diagnoses: [], recommendations: [] });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx tsx --test src/inference/dto.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `backend/src/inference/dto.ts`**

```ts
import type { InferenceResult } from './types.js';

export interface PlantHealthStatusDTO {
  diagnoses: Array<{ id: string; severity: number; confidence: number; tier: string }>;
  recommendations: Array<{ action: string; confidence: number }>;
}

// The only shape ever crossing an external boundary (tRPC/MQTT/MCP, all Phase C — out of this
// plan's scope). InferenceResult and EvidenceBreakdown never serialize directly, per the spec's
// "External representations" section.
export function toPlantHealthStatusDTO(result: InferenceResult): PlantHealthStatusDTO {
  return {
    diagnoses: result.diagnoses.map((d) => ({ id: d.id, severity: d.severity, confidence: d.confidence, tier: d.tier })),
    recommendations: result.recommendations.map((r) => ({ action: r.action, confidence: r.confidence })),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx tsx --test src/inference/dto.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/inference/dto.ts backend/src/inference/dto.test.ts
git commit -m "feat(inference): add PlantHealthStatusDTO external representation boundary"
```

---

### Task 18: Species-blindness CI enforcement

**Files:**
- Create: `backend/scripts/checkInferenceBoundary.ts`
- Create: `.github/workflows/inference-boundary-check.yml`

**Interfaces:**
- Consumes: nothing from earlier tasks (a standalone static-analysis script over the filesystem).
- Produces: a CI gate — no exported functions consumed elsewhere.

This task has no unit test of its own (it's a filesystem-scanning script, not application logic) —
instead its two verification steps run the script itself against a known-good and a known-bad
fixture.

- [ ] **Step 1: Write `backend/scripts/checkInferenceBoundary.ts`**

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const INFERENCE_DIR = join(import.meta.dirname, '..', 'src', 'inference');
const EXEMPT_FILE = 'referenceProfile.ts';
const FORBIDDEN_PATTERN = /from\s+['"]@prisma\/client['"]/;

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function main(): void {
  const violations: string[] = [];

  for (const filePath of collectTsFiles(INFERENCE_DIR)) {
    if (filePath.endsWith(EXEMPT_FILE)) continue;
    const content = readFileSync(filePath, 'utf-8');
    if (FORBIDDEN_PATTERN.test(content) && content.includes('PlantProfile')) {
      violations.push(filePath);
    }
  }

  if (violations.length > 0) {
    console.error('Species-blindness boundary violated — these files import PlantProfile from @prisma/client:');
    for (const file of violations) console.error(`  ${file}`);
    console.error(`\nOnly ${EXEMPT_FILE} is allowed to do this (spec: "Species-blindness — the one botanical boundary").`);
    process.exit(1);
  }

  console.log('Species-blindness boundary check passed.');
}

main();
```

- [ ] **Step 2: Verify it passes against the current, clean codebase**

Run (from `backend/`): `npx tsx scripts/checkInferenceBoundary.ts`
Expected: `Species-blindness boundary check passed.`, exit code 0. (After Tasks 1–17, only
`referenceProfile.ts` imports `PlantProfile`, and it's exempted — this should already pass.)

- [ ] **Step 3: Verify it fails against a deliberately broken fixture**

Temporarily add a throwaway line `import type { PlantProfile } from '@prisma/client';` to
`backend/src/inference/evidence.ts`, run the script again, confirm it exits non-zero and names
`evidence.ts` in its output, then revert the throwaway line (`git checkout -- backend/src/inference/evidence.ts`).

- [ ] **Step 4: Write `.github/workflows/inference-boundary-check.yml`**

```yaml
name: Inference engine species-blindness check

on:
  pull_request:
    paths:
      - 'backend/src/inference/**'
  push:
    branches: [main]
    paths:
      - 'backend/src/inference/**'

jobs:
  check-boundary:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: npx tsx scripts/checkInferenceBoundary.ts
        working-directory: backend
```

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/checkInferenceBoundary.ts .github/workflows/inference-boundary-check.yml
git commit -m "ci(inference): enforce the species-blindness boundary on every PR touching backend/src/inference"
```

---

## Self-Review

**Spec coverage**: `Range`/`ReferenceProfile`/`resolveReferenceProfile` (Task 3) ✓. Shared types,
`IndicatorIndex` vs `IndicatorSnapshot` distinction — the cache-shaped `IndicatorSnapshot` itself is
explicitly spec'd as a later-increment concern (caching), not built here; only the types needed for
the pure pipeline are (Task 1) ✓. `combineWeightedEvidence`/`combineNoisyOr`/`computeCoverage`
(Task 2) ✓. `validateRegistry`/`classifyTiers`/`reconcileRecommendations`/`InferenceEngine` (Task 4)
✓. One full Indicator→Fact→Symptom→Diagnosis→Recommendation slice (Tasks 5–16) ✓.
`PlantHealthStatusDTO` (Task 17) ✓. Species-blindness CI enforcement (Task 18) ✓. Explicitly and
correctly **not** covered, matching the spec's own "V1 scope"/"not in V1" list: the DSL, LLM
narration, `ExplanationToken`/ `toExplanationTokens`, `RuleCalibration`/`applyCalibration`,
`DiagnosisEvent` persistence, `IndicatorSnapshot` caching, Success Metrics queries, the rollback
feature flag, and any consumer wiring (scheduler/tRPC/MQTT/MCP/frontend) — all correctly deferred to
later plans per the user's explicit scoping instruction for this plan.

**Placeholder scan**: no "TBD"/"TODO"/"add appropriate error handling" found — every step has
runnable code. The two places synthetic time-series fixtures might need one hand-tuning iteration
(Tasks 7 and 16) are called out explicitly as expected TDD iteration, not left vague.

**Type consistency**: `FactDefinition.evaluate`'s 2nd parameter is `ReferenceProfile | null`
throughout (Tasks 1, 3, 9). `SymptomRule.evaluate`/`DiagnosisRule.evaluate` both key off
`InferenceContext` consistently (Tasks 1, 4, 12–15). `IndicatorDefinition.compute`'s return `id`
field matches each definition's own top-level `id` in every indicator (Tasks 5–8). `EvidenceItem`'s
added `missingReason` field (a deviation from the spec's literal type, needed to give
`EvidenceBreakdown.missing` a real reason per item) is declared once in Task 1 and consumed
consistently by `evidence.ts` (Task 2) — no other task reintroduces or contradicts it.
`reconcileRecommendations`'s `mutuallyExclusiveActions` parameter (added for testability, defaulting
to the spec's module-level `MUTUALLY_EXCLUSIVE_ACTIONS` — empty in V1 since only one
`RecommendationAction` exists) is used consistently between Task 4's implementation and its own
tests.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-07-horticultural-inference-engine-v1-slice.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
