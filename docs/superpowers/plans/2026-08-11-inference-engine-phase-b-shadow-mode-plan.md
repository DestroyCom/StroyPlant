# Inference Engine — Phase B (Shadow Mode) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the new horticultural inference engine alongside the legacy Health Engine on every scheduler tick, log a structured comparison whenever they disagree, and store it — with the legacy engine remaining the sole authority for the dashboard and the sole input to the real auto-watering trigger.

**Architecture:** A new orchestration module (`backend/src/health/inferenceShadow.ts`, plus a pure sibling `inferenceShadowMapping.ts`) is the only code that imports both `computeDeviceHealth` (legacy) and `inferenceEngine` (new). It's called from `scheduler.ts`'s existing `tick()` loop as an independent step with its own try/catch — never nested inside the safety-critical `evaluateDevice()` — gated by a new `HealthSettings.shadowModeEnabled` toggle (default off).

**Tech Stack:** TypeScript, Prisma/SQLite, Node's built-in `node:test` (pure functions only — the rest of `backend/src/health/` has never had automated tests; this plan follows that existing precedent, see Global Constraints), Fastify/tRPC, React/shadcn `Switch`.

## Global Constraints

- `backend/src/inference/` stays pure: no Prisma queries, no I/O, no dependency on any other part
  of the app except `PlantProfile` via `referenceProfile.ts`. Every file this plan creates or
  modifies outside `backend/src/inference/types.ts` lives in `backend/src/health/` or
  `frontend/src/`, never inside `backend/src/inference/` itself (the one exception: adding the
  optional `migrationNote` field to two already-exported `backend/src/inference/types.ts`
  interfaces — a type-only addition, not new logic).
- The legacy engine (`computeDeviceHealth`) remains the sole authority for `DeviceHealth.status`
  and the sole input to the auto-watering trigger. The new engine's result is read only by the
  new shadow-comparison code — no other file this plan touches changes what it reads or acts on.
- A failure anywhere in the new engine's shadow evaluation must never affect the legacy path —
  its own try/catch, never sharing one with `evaluateDevice`.
- **Testing convention**: `backend/src/inference/` is the only part of this codebase with
  automated tests today (`pnpm test` = `tsx --test 'src/inference/**/*.test.ts'`); everything
  under `backend/src/health/` (including `scheduler.ts`, `scoring.ts`) has always been verified
  manually against a scratch copy of `dev.db`, never with `node:test`. This plan follows both
  conventions where each applies: the two new **pure** functions
  (`toLegacyDeviceHealth`/`collectMainDifferences` in `inferenceShadowMapping.ts`) get real
  `node:test` unit tests, and the `pnpm test` glob is widened to pick them up
  (`"test": "tsx --test 'src/inference/**/*.test.ts' 'src/health/**/*.test.ts'"` — two glob
  arguments, not brace-expansion, to avoid depending on the test runner's glob-engine supporting
  `{a,b}` syntax). The **impure** orchestration (`evaluateShadow`, the `scheduler.ts` wiring) is
  verified manually against a scratch `dev.db` copy, exactly like every other Prisma-touching
  feature in this project's history — building new Prisma-backed test infrastructure is out of
  scope for this plan.
- Test command (pure functions): `cd backend && pnpm test`. Typecheck: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`. Lint (repo root): `pnpm lint`.
- Migration command: `cd backend && pnpm exec prisma migrate dev --name <name>`.

---

### Task 1: `ShadowDivergence` model, `HealthSettings.shadowModeEnabled`, and `health/settings.ts`

**Files:**

- Modify: `backend/prisma/schema.prisma`
- Modify: `backend/src/health/settings.ts`

**Interfaces:**

- Produces: `ShadowDivergence` Prisma model; `HealthSettingsValues` gains `shadowModeEnabled:
  boolean`; `getHealthSettings()`/`upsertHealthSettings(values)` both read/write it.
- Consumes: nothing from a prior task (first task).

- [ ] **Step 1: Add `shadowModeEnabled` to `HealthSettings` in `schema.prisma`**

In `backend/prisma/schema.prisma`, find:

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

Change to:

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
  // Inference engine Phase B (shadow mode, docs/superpowers/specs/2026-08-11-inference-engine-
  // phase-b-shadow-mode-design.md) — off by default so the new engine doesn't start evaluating on
  // every scheduler tick the moment this ships; DestCom enables it deliberately from /settings.
  shadowModeEnabled  Boolean  @default(false)
  updatedAt          DateTime @updatedAt
}
```

- [ ] **Step 2: Add the `ShadowDivergence` model**

In `backend/prisma/schema.prisma`, add this new model directly after the `WateringEvent` model
(before the `SyncSource` enum / `SyncEvent` model):

```prisma
// Inference engine Phase B (shadow mode) — one row per real disagreement between the legacy
// Health Engine and the new inference engine, written by backend/src/health/inferenceShadow.ts.
// Deliberately lighter than a full DiagnosisEvent/Contributor/Recommendation schema (that's a
// later increment for aggregate Success Metrics, not needed for manual divergence review) — one
// row per divergence, mainDifferences as a plain JSON string array rather than normalized child
// rows, since nothing here needs cross-device SQL aggregation yet. No retention/pruning policy —
// same open-ended stance as SyncEvent/RawSensorLog.
model ShadowDivergence {
  id                    Int      @id @default(autoincrement())
  deviceId              String
  device                Device   @relation(fields: [deviceId], references: [id])
  timestamp             DateTime @default(now())
  legacyStatus          String
  inferenceDiagnosisId  String?
  inferenceTier         String?
  inferenceSeverity     Float?
  inferenceConfidence   Float?
  recommendationAction  String?
  mainDifferences       Json

  @@index([deviceId, timestamp])
}
```

- [ ] **Step 3: Add the reverse relation on `Device`**

In `backend/prisma/schema.prisma`, find the `Device` model:

```prisma
  readings       Reading[]
  wateringEvents WateringEvent[]
  syncEvents     SyncEvent[]
  schedule       Schedule?
}
```

Change to:

```prisma
  readings          Reading[]
  wateringEvents    WateringEvent[]
  syncEvents        SyncEvent[]
  schedule          Schedule?
  shadowDivergences ShadowDivergence[]
}
```

- [ ] **Step 4: Run the migration**

Run: `cd backend && pnpm exec prisma migrate dev --name add_shadow_divergence_and_shadow_mode_setting`
Expected: a new migration directory under `backend/prisma/migrations/`, applied to `backend/dev.db`, and `prisma generate` runs automatically as part of `migrate dev` — no manual `prisma generate` needed.

- [ ] **Step 5: Update `health/settings.ts`**

Replace the entire file `backend/src/health/settings.ts` with:

```ts
import { prisma } from '../db/client.js';

const SETTINGS_ID = 1;

export interface HealthSettingsValues {
  baselineWindowDays: number;
  warmupMinDays: number;
  // IANA timezone name, used by health/dailyLightIntegral.ts's calendar-day grouping (Part H).
  timezone: string;
  // Inference engine Phase B (shadow mode) — off by default, see schema.prisma's comment.
  shadowModeEnabled: boolean;
}

const DEFAULTS: HealthSettingsValues = { baselineWindowDays: 14, warmupMinDays: 3, timezone: 'UTC', shadowModeEnabled: false };

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
    ? {
        baselineWindowDays: settings.baselineWindowDays,
        warmupMinDays: settings.warmupMinDays,
        timezone: settings.timezone,
        shadowModeEnabled: settings.shadowModeEnabled,
      }
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
  return {
    baselineWindowDays: settings.baselineWindowDays,
    warmupMinDays: settings.warmupMinDays,
    timezone: settings.timezone,
    shadowModeEnabled: settings.shadowModeEnabled,
  };
}
```

- [ ] **Step 6: Manually verify the round trip**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json` — expect clean (no type errors from the new field).

Run this one-off script to confirm the DB round-trip, from the `backend` directory:

```bash
cd backend && cat <<'EOF' | pnpm exec tsx
import { getHealthSettings, upsertHealthSettings } from './src/health/settings.js';

const before = await getHealthSettings();
console.log('before:', before);

const after = await upsertHealthSettings({ ...before, shadowModeEnabled: true });
console.log('after upsert:', after);

const reread = await getHealthSettings();
console.log('re-read:', reread);

// Restore to false so this manual check doesn't leave shadow mode on in dev.db.
await upsertHealthSettings({ ...reread, shadowModeEnabled: false });
console.log('restored to false');
EOF
```

Expected: `before.shadowModeEnabled` is `false` (default, assuming no prior row or a prior row
created before this field existed — Prisma backfills the column default on migration). `after
upsert` and `re-read` both show `shadowModeEnabled: true`. The final `restored to false` line
runs with no error.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/prisma/schema.prisma backend/prisma/migrations backend/src/health/settings.ts
git commit -m "health: add ShadowDivergence model and HealthSettings.shadowModeEnabled (Phase B, shadow mode)"
```

---

### Task 2: `migrationNote` on `FactDefinition`/`SymptomRule`, set on the existing rules

**Files:**

- Modify: `backend/src/inference/types.ts`
- Modify: `backend/src/inference/facts/soilMoistureBelowProfileMin.ts`
- Modify: `backend/src/inference/facts/dryingRateUnusuallyFast.ts`
- Modify: `backend/src/inference/facts/wateringIntervalUnusuallyLong.ts`
- Modify: `backend/src/inference/symptoms/waterStress.ts`

**Interfaces:**

- Produces: `FactDefinition.migrationNote?: string`, `SymptomRule.migrationNote?: string` — read by
  Task 4's `collectMainDifferences`.
- Consumes: nothing from a prior task.

- [ ] **Step 1: Add the field to both interfaces in `types.ts`**

In `backend/src/inference/types.ts`, change:

```ts
export interface FactDefinition {
  id: FactId;
  needsProfile: boolean;
  requiredIndicators: IndicatorId[];
  evaluate(indicators: IndicatorIndex, profile: ReferenceProfile | null): FactResult | null;
}
```

to:

```ts
export interface FactDefinition {
  id: FactId;
  needsProfile: boolean;
  requiredIndicators: IndicatorId[];
  // Optional, static, human-readable (French) explanation of what this Fact newly considers that
  // the legacy Health Engine didn't — collected by health/inferenceShadowMapping.ts's
  // collectMainDifferences() whenever this Fact meaningfully contributes to a diagnosis that
  // disagrees with the legacy engine (Phase B, shadow mode). Purely descriptive, never read by
  // evaluate() or anything inside backend/src/inference/ itself.
  migrationNote?: string;
  evaluate(indicators: IndicatorIndex, profile: ReferenceProfile | null): FactResult | null;
}
```

And change:

```ts
export interface SymptomRule {
  id: SymptomId;
  requiredFacts?: FactId[];
  consumes: { facts: FactId[]; indicators: IndicatorId[] };
  evaluate(ctx: InferenceContext): SymptomResult | null;
}
```

to:

```ts
export interface SymptomRule {
  id: SymptomId;
  requiredFacts?: FactId[];
  consumes: { facts: FactId[]; indicators: IndicatorId[] };
  // See FactDefinition.migrationNote above — same purpose, same mechanism, one level up.
  migrationNote?: string;
  evaluate(ctx: InferenceContext): SymptomResult | null;
}
```

- [ ] **Step 2: Set it on `soil_moisture_below_profile_min`**

`soil_moisture_below_profile_min` has a direct legacy equivalent (`soilMoisturePercent.status ===
'too_low'`), so it never explains a real divergence on its own — leave it without a
`migrationNote` (no change to `backend/src/inference/facts/soilMoistureBelowProfileMin.ts`).

- [ ] **Step 3: Set it on `drying_rate_unusually_fast`**

In `backend/src/inference/facts/dryingRateUnusuallyFast.ts`, change:

```ts
export const dryingRateUnusuallyFast: FactDefinition = {
  id: 'drying_rate_unusually_fast',
  needsProfile: false,
  requiredIndicators: ['dryingRateDeviationSigma'],
  evaluate(indicators) {
```

to:

```ts
export const dryingRateUnusuallyFast: FactDefinition = {
  id: 'drying_rate_unusually_fast',
  needsProfile: false,
  requiredIndicators: ['dryingRateDeviationSigma'],
  migrationNote: 'Prend en compte la vitesse de séchage du sol, absente du calcul historique.',
  evaluate(indicators) {
```

- [ ] **Step 4: Set it on `watering_interval_unusually_long`**

In `backend/src/inference/facts/wateringIntervalUnusuallyLong.ts`, change:

```ts
export const wateringIntervalUnusuallyLong: FactDefinition = {
  id: 'watering_interval_unusually_long',
  needsProfile: false,
  requiredIndicators: ['wateringIntervalDeviationSigma'],
  evaluate(indicators) {
```

to:

```ts
export const wateringIntervalUnusuallyLong: FactDefinition = {
  id: 'watering_interval_unusually_long',
  needsProfile: false,
  requiredIndicators: ['wateringIntervalDeviationSigma'],
  migrationNote: "Prend en compte l'intervalle entre arrosages, absent du calcul historique.",
  evaluate(indicators) {
```

- [ ] **Step 5: Set it on `water_stress`**

In `backend/src/inference/symptoms/waterStress.ts`, change:

```ts
export const waterStress: SymptomRule = {
  id: 'water_stress',
  consumes: { facts: ['soil_moisture_below_profile_min', 'drying_rate_unusually_fast'], indicators: ['temperatureRollingAvg1h'] },
  evaluate(ctx) {
```

to:

```ts
export const waterStress: SymptomRule = {
  id: 'water_stress',
  consumes: { facts: ['soil_moisture_below_profile_min', 'drying_rate_unusually_fast'], indicators: ['temperatureRollingAvg1h'] },
  migrationNote: "Combine humidité du sol, température et régularité d'arrosage en un seul score, au lieu d'un seuil unique.",
  evaluate(ctx) {
```

- [ ] **Step 6: Run the full test suite, typecheck, and lint**

Run: `cd backend && pnpm test`
Expected: all existing tests still pass (the `migrationNote` field is optional and additive — no existing test constructs these objects with an exhaustive/exact-shape check that would break from a new optional field. If any test uses `assert.deepEqual` against a full rule-object literal, e.g. in `facts/index.test.ts` or `symptoms/index.test.ts`, verify it doesn't fail; if it does, the fixture is comparing against the full object rather than just checking `.id`, which would need widening — read the failing test before assuming this is expected).

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/inference/types.ts backend/src/inference/facts/dryingRateUnusuallyFast.ts \
  backend/src/inference/facts/wateringIntervalUnusuallyLong.ts backend/src/inference/symptoms/waterStress.ts
git commit -m "inference: add optional migrationNote field to FactDefinition/SymptomRule, set on 3 rules (Phase B, shadow mode)"
```

---

### Task 3: Export `isWithinAllowedWindow` and `DeviceForTick` from `scheduler.ts`

**Files:**

- Modify: `backend/src/health/scheduler.ts`

**Interfaces:**

- Produces: `isWithinAllowedWindow(hour: number, startHour: number, endHour: number): boolean`
  (already existed, was module-private) and `DeviceForTick` (already existed as a private type
  alias) — both now exported, no behavior change. Consumed by Task 5's `inferenceShadow.ts`.
- Consumes: nothing from a prior task.

- [ ] **Step 1: Export `isWithinAllowedWindow`**

In `backend/src/health/scheduler.ts`, change:

```ts
function isWithinAllowedWindow(hour: number, startHour: number, endHour: number): boolean {
```

to:

```ts
export function isWithinAllowedWindow(hour: number, startHour: number, endHour: number): boolean {
```

- [ ] **Step 2: Export `DeviceForTick`**

In `backend/src/health/scheduler.ts`, change:

```ts
type DeviceForTick = Device & { plantProfile: PlantProfile | null; schedule: Schedule | null };
```

to:

```ts
export type DeviceForTick = Device & { plantProfile: PlantProfile | null; schedule: Schedule | null };
```

- [ ] **Step 3: Verify nothing else changed**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean — this step only widens visibility (`function` → `export function`, `type` →
`export type`), no behavior change, no other line in the file touched.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/health/scheduler.ts
git commit -m "health: export isWithinAllowedWindow and DeviceForTick from scheduler.ts (needed by Phase B shadow mode)"
```

---

### Task 4: `inferenceShadowMapping.ts` — the two pure functions, with real tests

**Files:**

- Create: `backend/src/health/inferenceShadowMapping.ts`
- Create: `backend/src/health/inferenceShadowMapping.test.ts`
- Modify: `backend/package.json`

**Interfaces:**

- Consumes: `DiagnosisFinding`, `InferenceResult`, `FactDefinition`, `SymptomRule` from
  `backend/src/inference/types.ts` (unchanged by this task); `DeviceHealth`,
  `DeviceHealthStatus` from `backend/src/health/scoring.ts` (unchanged).
- Produces: `toLegacyDeviceHealth(inferenceResult: InferenceResult): Pick<DeviceHealth, 'status'>`
  and `collectMainDifferences(diagnoses: DiagnosisFinding[], factDefinitions: FactDefinition[],
  symptomRules: SymptomRule[]): string[]` — both consumed by Task 5's `inferenceShadow.ts`.

- [ ] **Step 1: Widen the `pnpm test` glob**

In `backend/package.json`, change:

```json
    "test": "tsx --test 'src/inference/**/*.test.ts'"
```

to:

```json
    "test": "tsx --test 'src/inference/**/*.test.ts' 'src/health/**/*.test.ts'"
```

- [ ] **Step 2: Write the failing tests**

Create `backend/src/health/inferenceShadowMapping.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiagnosisFinding, EvidenceBreakdown, FactDefinition, InferenceResult, SymptomRule } from '../inference/types.js';
import { collectMainDifferences, toLegacyDeviceHealth } from './inferenceShadowMapping.js';

function emptyBreakdown(): EvidenceBreakdown {
  return { formula: 'weightedAverage', items: [], missing: [] };
}

function diagnosis(overrides: Partial<DiagnosisFinding> = {}): DiagnosisFinding {
  return {
    id: 'chronic_underwatering',
    severity: 0.8,
    confidence: 0.8,
    coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
    tier: 'dominant',
    severityBreakdown: emptyBreakdown(),
    confidenceBreakdown: emptyBreakdown(),
    ...overrides,
  };
}

function result(diagnoses: DiagnosisFinding[]): InferenceResult {
  return { indicators: new Map(), facts: new Map(), symptoms: new Map(), diagnoses, recommendations: [] };
}

describe('toLegacyDeviceHealth', () => {
  it('maps no diagnoses to "ok"', () => {
    assert.equal(toLegacyDeviceHealth(result([])).status, 'ok');
  });

  it('maps a weak_hypothesis-only diagnosis to "ok" (not a real disagreement)', () => {
    assert.equal(toLegacyDeviceHealth(result([diagnosis({ tier: 'weak_hypothesis' })])).status, 'ok');
  });

  it('maps a dominant diagnosis to "warning"', () => {
    assert.equal(toLegacyDeviceHealth(result([diagnosis({ tier: 'dominant' })])).status, 'warning');
  });

  it('maps a secondary diagnosis to "warning"', () => {
    assert.equal(toLegacyDeviceHealth(result([diagnosis({ tier: 'secondary' })])).status, 'warning');
  });
});

describe('collectMainDifferences', () => {
  const facts: FactDefinition[] = [
    { id: 'fact_with_note', needsProfile: false, requiredIndicators: [], migrationNote: 'Fact note.', evaluate: () => null },
    { id: 'fact_without_note', needsProfile: false, requiredIndicators: [], evaluate: () => null },
  ];
  const symptoms: SymptomRule[] = [
    {
      id: 'symptom_with_note',
      consumes: { facts: [], indicators: [] },
      migrationNote: 'Symptom note.',
      evaluate: () => null,
    },
  ];

  it('collects the migrationNote of a fact-sourced item above the contribution threshold', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [{ source: { kind: 'fact', id: 'fact_with_note' }, weight: 1, strength: 1, confidence: 1, polarity: 'supports', contribution: 0.5 }],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], facts, symptoms), ['Fact note.']);
  });

  it('collects the migrationNote of a symptom-sourced item above the threshold', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [{ source: { kind: 'symptom', id: 'symptom_with_note' }, weight: 1, strength: 1, confidence: 1, polarity: 'supports', contribution: 0.5 }],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], facts, symptoms), ['Symptom note.']);
  });

  it('ignores an item whose contribution is at or below the threshold (0.05)', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [{ source: { kind: 'fact', id: 'fact_with_note' }, weight: 1, strength: 1, confidence: 1, polarity: 'supports', contribution: 0.05 }],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], facts, symptoms), []);
  });

  it('ignores a fact/symptom with no migrationNote set', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [{ source: { kind: 'fact', id: 'fact_without_note' }, weight: 1, strength: 1, confidence: 1, polarity: 'supports', contribution: 0.5 }],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], facts, symptoms), []);
  });

  it('ignores an indicator-sourced item (indicators have no migrationNote slot)', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [{ source: { kind: 'indicator', id: 'soilMoistureRollingAvg1h' }, weight: 1, strength: 1, confidence: 1, polarity: 'supports', contribution: 0.5 }],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], facts, symptoms), []);
  });

  it('deduplicates the same note appearing from two contributing diagnoses', () => {
    const item = { source: { kind: 'fact' as const, id: 'fact_with_note' }, weight: 1, strength: 1, confidence: 1, polarity: 'supports' as const, contribution: 0.5 };
    const d1 = diagnosis({ id: 'a', severityBreakdown: { formula: 'weightedAverage', items: [item], missing: [] } });
    const d2 = diagnosis({ id: 'b', severityBreakdown: { formula: 'weightedAverage', items: [item], missing: [] } });
    assert.deepEqual(collectMainDifferences([d1, d2], facts, symptoms), ['Fact note.']);
  });

  it('returns an empty array for no diagnoses', () => {
    assert.deepEqual(collectMainDifferences([], facts, symptoms), []);
  });
});
```

- [ ] **Step 3: Run the tests, verify they fail**

Run: `cd backend && pnpm test`
Expected: FAIL — `inferenceShadowMapping.ts` doesn't exist yet, so the import fails.

- [ ] **Step 4: Implement `inferenceShadowMapping.ts`**

Create `backend/src/health/inferenceShadowMapping.ts`:

```ts
import type { DeviceHealth } from './scoring.js';
import type { DiagnosisFinding, FactDefinition, InferenceResult, SymptomRule } from '../inference/types.js';

const WARNING_TIERS = new Set<DiagnosisFinding['tier']>(['dominant', 'secondary']);

// The RFC's migration adapter (Phase B), scoped to the one field the shadow comparison actually
// needs — DeviceHealth.status. A weak_hypothesis-tier diagnosis doesn't count as a real
// disagreement (the engine itself doesn't treat it as a confident finding), matching how the
// dashboard would eventually treat tiers once Phase C wires a real consumer.
export function toLegacyDeviceHealth(inferenceResult: InferenceResult): Pick<DeviceHealth, 'status'> {
  const hasWarningDiagnosis = inferenceResult.diagnoses.some((diagnosis) => WARNING_TIERS.has(diagnosis.tier));
  return { status: hasWarningDiagnosis ? 'warning' : 'ok' };
}

// An initial engineering estimate (not derived from real data) — an evidence item contributing
// less than this to a diagnosis's severity is not "meaningfully" explaining a divergence. Same
// convention as this codebase's other initial-estimate constants (e.g.
// MINIMUM_REPORTABLE_IMPORTANCE in inference/engine.ts).
const MIGRATION_NOTE_CONTRIBUTION_THRESHOLD = 0.05;

// Walks every diagnosis's severityBreakdown for evidence items that meaningfully contributed
// (contribution above the threshold) and are sourced from a Fact or Symptom carrying a
// migrationNote — collecting those notes to explain, in human terms, what the new engine
// considered that the legacy one didn't. Only fact/symptom-sourced items are considered:
// indicators have no migrationNote slot (they're raw measurements, not horticultural reasoning).
export function collectMainDifferences(diagnoses: DiagnosisFinding[], factDefinitions: FactDefinition[], symptomRules: SymptomRule[]): string[] {
  const notes = new Set<string>();

  for (const diagnosis of diagnoses) {
    for (const item of diagnosis.severityBreakdown.items) {
      if (item.contribution <= MIGRATION_NOTE_CONTRIBUTION_THRESHOLD) continue;

      const note =
        item.source.kind === 'fact'
          ? factDefinitions.find((fact) => fact.id === item.source.id)?.migrationNote
          : item.source.kind === 'symptom'
            ? symptomRules.find((symptom) => symptom.id === item.source.id)?.migrationNote
            : undefined;

      if (note) notes.add(note);
    }
  }

  return [...notes];
}
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `cd backend && pnpm test`
Expected: all tests pass, including the new `inferenceShadowMapping` suite.

- [ ] **Step 6: Typecheck and lint**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/package.json backend/src/health/inferenceShadowMapping.ts backend/src/health/inferenceShadowMapping.test.ts
git commit -m "health: add inferenceShadowMapping.ts (toLegacyDeviceHealth, collectMainDifferences) with tests (Phase B, shadow mode)"
```

---

### Task 5: `inferenceShadow.ts` — the `evaluateShadow()` orchestration

**Files:**

- Create: `backend/src/health/inferenceShadow.ts`

**Interfaces:**

- Consumes: `toLegacyDeviceHealth`/`collectMainDifferences` (Task 4); `isWithinAllowedWindow`/
  `DeviceForTick`/`resolveEffectiveSchedule` (Task 3, `resolveEffectiveSchedule` was already
  exported before this plan); `HealthSettingsValues` (Task 1); `migrationNote`-bearing
  `factDefinitions`/`symptomRules` (Task 2, values unchanged — same exports as before, `../inference/facts/index.js` and `../inference/symptoms/index.js`).
- Produces: `evaluateShadow(device: DeviceForTick, healthSettings: HealthSettingsValues):
  Promise<void>` — consumed by Task 6's `scheduler.ts` wiring.

- [ ] **Step 1: Implement `inferenceShadow.ts`**

Create `backend/src/health/inferenceShadow.ts`:

```ts
import { prisma } from '../db/client.js';
import { factDefinitions } from '../inference/facts/index.js';
import { resolveReferenceProfile } from '../inference/referenceProfile.js';
import { inferenceEngine } from '../inference/registry.js';
import { symptomRules } from '../inference/symptoms/index.js';
import type { DeviceCapabilities, EnvironmentContext, OperationalConstraints } from '../inference/types.js';
import { log } from '../logger.js';
import { collectMainDifferences, toLegacyDeviceHealth } from './inferenceShadowMapping.js';
import { computeDeviceHealth } from './scoring.js';
import type { DeviceForTick } from './scheduler.js';
import { isWithinAllowedWindow, resolveEffectiveSchedule } from './scheduler.js';
import type { HealthSettingsValues } from './settings.js';
import { getCalibration } from './soilConductivityCalibration.js';

// This phase never runs for anything but a named Parrot Pot with a species assigned — the same
// device set scheduler.ts's tick() already queries (see backend/src/health/scheduler.ts's `tick`).
// Hardcoded rather than derived from device.kind since the only Diagnosis that exists today
// (chronic_underwatering) only ever consumes soil-moisture-related fields, which Xiaomi devices
// don't report at all.
const PARROT_POT_CAPABILITIES: DeviceCapabilities = ['soilMoisture', 'temperature', 'luminosity', 'conductivity'];

// Runs the new inference engine alongside the legacy Health Engine for one device, and — if their
// resulting status disagrees — writes a ShadowDivergence row plus a structured log line. Never
// throws in a way that should be allowed to affect the caller's own watering-trigger logic: any
// error here is the caller's responsibility to catch (see scheduler.ts's tick(), which wraps this
// call in its own try/catch, separate from evaluateDevice's).
//
// Deliberately re-fetches readings/wateringEvents and calls computeDeviceHealth() a second time
// rather than threading evaluateDevice's already-computed state out to the caller —
// evaluateDevice's early returns (schedule inactive, outside allowed hours, cooldown active) exit
// before computing health, and refactoring that safety-critical function to expose state on every
// path isn't worth the risk for a handful of devices evaluated once every ~5 minutes. Isolation
// over micro-optimization.
export async function evaluateShadow(device: DeviceForTick, healthSettings: HealthSettingsValues): Promise<void> {
  const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
  const readings = await prisma.reading.findMany({
    where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
    orderBy: { timestamp: 'asc' },
    include: { rawSensorLog: true },
  });
  const conductivityCalibration = await getCalibration(device.id);
  const legacyHealth = computeDeviceHealth(
    device,
    readings,
    device.plantProfile,
    healthSettings.warmupMinDays,
    conductivityCalibration,
    healthSettings.timezone,
  );

  // Neither engine's status is meaningful yet during warm-up, and 'no_profile' can't be a genuine
  // divergence either (tick()'s own query already filters to plantProfileId != null — this only
  // guards the type-level possibility, not a real runtime case).
  if (legacyHealth.status === 'warming_up' || legacyHealth.status === 'no_profile') return;

  const wateringEvents = await prisma.wateringEvent.findMany({ where: { deviceId: device.id }, orderBy: { timestamp: 'asc' } });

  const environment: EnvironmentContext = {
    deviceKind: device.kind,
    environment: device.environment,
    capabilities: PARROT_POT_CAPABILITIES,
    observationsAvailability: {},
    timezone: healthSettings.timezone,
  };
  const profile = device.plantProfile ? resolveReferenceProfile(device.plantProfile, device.environment) : null;

  const effective = resolveEffectiveSchedule(device, device.schedule);
  const lastSuccessfulWatering = wateringEvents.filter((event) => event.success).at(-1) ?? null;
  const cooldownActive =
    lastSuccessfulWatering != null && Date.now() - lastSuccessfulWatering.timestamp.getTime() < effective.cooldownHours * 3600_000;
  const operational: OperationalConstraints = {
    autoWateringEnabled: effective.active,
    withinAllowedWindow: isWithinAllowedWindow(new Date().getHours(), effective.allowedStartHour, effective.allowedEndHour),
    cooldownActive,
  };

  const inferenceResult = inferenceEngine.run({ readings, wateringEvents }, profile, environment, operational, new Date());
  const mappedInference = toLegacyDeviceHealth(inferenceResult);

  if (mappedInference.status === legacyHealth.status) return;

  const primaryDiagnosis = inferenceResult.diagnoses[0] ?? null;
  const primaryRecommendation = inferenceResult.recommendations[0] ?? null;
  const mainDifferences = collectMainDifferences(inferenceResult.diagnoses, factDefinitions, symptomRules);

  await prisma.shadowDivergence.create({
    data: {
      deviceId: device.id,
      legacyStatus: legacyHealth.status,
      inferenceDiagnosisId: primaryDiagnosis?.id ?? null,
      inferenceTier: primaryDiagnosis?.tier ?? null,
      inferenceSeverity: primaryDiagnosis?.severity ?? null,
      inferenceConfidence: primaryDiagnosis?.confidence ?? null,
      recommendationAction: primaryRecommendation?.action ?? null,
      mainDifferences,
    },
  });

  log({
    direction: 'INFO',
    label: 'Shadow mode: inference engine disagrees with legacy Health Engine',
    deviceId: device.id,
    result: 'OK',
    detail: `legacy=${legacyHealth.status} inference=${mappedInference.status} diagnosis=${primaryDiagnosis?.id ?? 'none'}`,
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean. If `log()`'s parameter type doesn't accept this exact shape, read
`backend/src/logger.ts`'s `log()` signature and adjust the call to match — every other call site
in `scheduler.ts` uses the same `{ direction, label, deviceId, result, detail? }` shape, so this
should already match without changes.

- [ ] **Step 3: Manually verify against a scratch copy of `dev.db`**

This function is impure (Prisma-backed) and this codebase has no automated-test convention for
that (see Global Constraints) — verify manually, the same way every other Prisma-touching feature
in this project's history has been verified. From the repo root:

```bash
cp backend/dev.db /tmp/shadow-mode-scratch.db
cd backend
DATABASE_URL="file:/tmp/shadow-mode-scratch.db" pnpm exec prisma migrate deploy
```

Then run this one-off script (still with `DATABASE_URL` pointed at the scratch copy) to exercise
`evaluateShadow` against one real named device already in `dev.db` (replace `'PARROT-A073'` with
an actual device id from your `dev.db` if different — check with `sqlite3
/tmp/shadow-mode-scratch.db "select id, kind, plantProfileId from Device where plantProfileId is
not null;"` first):

```bash
DATABASE_URL="file:/tmp/shadow-mode-scratch.db" cat <<'EOF' | pnpm exec tsx
import { prisma } from './src/db/client.js';
import { evaluateShadow } from './src/health/inferenceShadow.js';
import { getHealthSettings } from './src/health/settings.js';

const device = await prisma.device.findFirst({
  where: { kind: 'PARROT_POT', plantProfileId: { not: null } },
  include: { plantProfile: true, schedule: true },
});
if (!device) throw new Error('No Parrot Pot with a species assigned found in this DB — pick a different device id manually.');

const healthSettings = await getHealthSettings();
console.log('Running evaluateShadow for', device.id, '...');
await evaluateShadow(device, healthSettings);

const divergences = await prisma.shadowDivergence.findMany({ where: { deviceId: device.id } });
console.log(`ShadowDivergence rows for ${device.id}:`, divergences);
EOF
```

Expected: no thrown error. If the device's legacy and new-engine statuses genuinely agree (the
common case for a healthy device), `divergences` is an empty array and no log line appears. If
they disagree, exactly one `ShadowDivergence` row appears with a real `legacyStatus`,
`inferenceDiagnosisId`/`tier`/`severity`/`confidence` (or all `null` if the new engine produced no
diagnosis at all — also a valid divergence), and a `mainDifferences` array. Either outcome is
correct — the point of this check is "it runs without throwing and produces a sane row when it
does write one," not a specific expected status for this particular device's real data.

Clean up afterward: `rm /tmp/shadow-mode-scratch.db*` (SQLite may leave `-journal`/`-wal`
sidecar files).

- [ ] **Step 4: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/health/inferenceShadow.ts
git commit -m "health: add inferenceShadow.ts's evaluateShadow() orchestration (Phase B, shadow mode)"
```

---

### Task 6: Wire `evaluateShadow` into `scheduler.ts`'s `tick()`

**Files:**

- Modify: `backend/src/health/scheduler.ts`

**Interfaces:**

- Consumes: `evaluateShadow` (Task 5).
- Produces: nothing new — this is the final integration point, nothing later depends on it.

- [ ] **Step 1: Import `evaluateShadow` and `getHealthSettings`**

In `backend/src/health/scheduler.ts`, the import block already has:

```ts
import { computeDeviceHealth } from './scoring.js';
import { getHealthSettings } from './settings.js';
```

Add one new import line directly above them (alphabetical order among this file's local imports —
`inferenceShadow` sorts before `scoring`):

```ts
import { evaluateShadow } from './inferenceShadow.js';
import { computeDeviceHealth } from './scoring.js';
import { getHealthSettings } from './settings.js';
```

- [ ] **Step 2: Fetch `HealthSettings` once per tick and call `evaluateShadow` per device**

In `backend/src/health/scheduler.ts`, change:

```ts
async function tick(provider: DeviceProvider, connectionQueue: ConnectionQueue): Promise<void> {
  // Only Parrot Pots have a pump; only devices with a species assigned can ever produce a
  // `soilMoisturePercent` status to act on (computeDeviceHealth returns `no_profile` otherwise).
  const devices = await prisma.device.findMany({
    where: { kind: 'PARROT_POT', plantProfileId: { not: null } },
    include: { plantProfile: true, schedule: true },
  });

  for (const device of devices) {
    try {
      await evaluateDevice(device, provider, connectionQueue);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Scheduler tick failed for device',
        deviceId: device.id,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
```

to:

```ts
async function tick(provider: DeviceProvider, connectionQueue: ConnectionQueue): Promise<void> {
  // Only Parrot Pots have a pump; only devices with a species assigned can ever produce a
  // `soilMoisturePercent` status to act on (computeDeviceHealth returns `no_profile` otherwise).
  const devices = await prisma.device.findMany({
    where: { kind: 'PARROT_POT', plantProfileId: { not: null } },
    include: { plantProfile: true, schedule: true },
  });
  // Fetched once here for the shadow-mode gate below — evaluateDevice() also fetches its own copy
  // internally for the baseline window it needs; a second cheap read once per tick is preferable
  // to threading this through evaluateDevice's own signature for an unrelated concern.
  const healthSettings = await getHealthSettings();

  for (const device of devices) {
    try {
      await evaluateDevice(device, provider, connectionQueue);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Scheduler tick failed for device',
        deviceId: device.id,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // Phase B, shadow mode (docs/superpowers/specs/2026-08-11-inference-engine-phase-b-shadow-
    // mode-design.md) — deliberately its own try/catch, never sharing one with evaluateDevice
    // above: a shadow-evaluation failure must never affect (or be masked by) the real
    // watering-decision path for the same device on the same tick.
    if (healthSettings.shadowModeEnabled) {
      try {
        await evaluateShadow(device, healthSettings);
      } catch (error) {
        log({
          direction: 'INFO',
          label: 'Shadow evaluation failed for device',
          deviceId: device.id,
          result: 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 3: Manually verify with shadow mode on, against the scratch DB**

Reuse the scratch copy approach from Task 5 Step 3 (or make a fresh one — `cp backend/dev.db
/tmp/shadow-mode-scratch.db` then `DATABASE_URL="file:/tmp/shadow-mode-scratch.db" pnpm exec
prisma migrate deploy` from `backend`). Enable shadow mode and run one full tick end-to-end:

```bash
cd backend
DATABASE_URL="file:/tmp/shadow-mode-scratch.db" cat <<'EOF' | pnpm exec tsx
import { getHealthSettings, upsertHealthSettings } from './src/health/settings.js';

const before = await getHealthSettings();
await upsertHealthSettings({ ...before, shadowModeEnabled: true });
console.log('shadowModeEnabled set to true');
EOF
```

Then, still with `DATABASE_URL` pointed at the scratch copy, start the backend against the mock
provider (never the real BLE providers on this Mac — matching this project's non-negotiable dev
rule) and let one scheduler tick run:

```bash
DATABASE_URL="file:/tmp/shadow-mode-scratch.db" BLE_PROVIDER=mock pnpm dev
```

Watch the console log for a `[INFO] Shadow mode: inference engine disagrees...` line (only
appears if a real divergence occurs for a device in this scratch DB — absence of the line, with
no crash and the process staying up through at least one tick interval, is equally valid evidence
the wiring works when the two engines happen to agree). Stop the process (Ctrl-C) once at least
one tick has had time to run (check `env.schedulerTickIntervalMs`'s default, or just wait a
comfortable margin past 5 minutes if unchanged). Confirm no error crashed the process.

Clean up: `rm /tmp/shadow-mode-scratch.db*`.

- [ ] **Step 4: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/health/scheduler.ts
git commit -m "health: wire evaluateShadow into scheduler.ts's tick(), gated by shadowModeEnabled (Phase B, shadow mode)"
```

---

### Task 7: Frontend toggle for `shadowModeEnabled`

**Files:**

- Modify: `backend/src/api/trpc/routers/health.ts`
- Modify: `frontend/src/components/health-engine-settings-section.tsx`

**Interfaces:**

- Consumes: `HealthSettingsValues.shadowModeEnabled` (Task 1), already flowing through
  `health.getSettings`'s existing query (no router change needed there — it just calls
  `getHealthSettings()` directly, which now includes the field).
- Produces: nothing consumed by a later task — this is the final task of this plan.

- [ ] **Step 1: Add `shadowModeEnabled` to `upsertSettings`'s zod input**

In `backend/src/api/trpc/routers/health.ts`, change:

```ts
  upsertSettings: protectedProcedure
    .input(
      z.object({
        baselineWindowDays: z.number().int().min(1).max(365),
        warmupMinDays: z.number().int().min(0).max(365),
        timezone: z.string().min(1),
      }),
    )
    .mutation(({ input }) => upsertHealthSettings(input)),
```

to:

```ts
  upsertSettings: protectedProcedure
    .input(
      z.object({
        baselineWindowDays: z.number().int().min(1).max(365),
        warmupMinDays: z.number().int().min(0).max(365),
        timezone: z.string().min(1),
        shadowModeEnabled: z.boolean(),
      }),
    )
    .mutation(({ input }) => upsertHealthSettings(input)),
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit -p tsconfig.json`
Expected: clean.

- [ ] **Step 3: Add the toggle to `HealthEngineSettingsSection`**

Replace the entire file `frontend/src/components/health-engine-settings-section.tsx` with:

```tsx
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';

// Rolling baseline window, warm-up period, and shadow mode (docs/superpowers/specs/2026-08-11-
// inference-engine-phase-b-shadow-mode-design.md) — configured here instead of env vars, same
// move as MqttSettingsSection and for the same reason (a single source of truth, editable without
// a redeploy).
export function HealthEngineSettingsSection() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(trpc.health.getSettings.queryOptions());

  const [baselineWindowDays, setBaselineWindowDays] = useState(14);
  const [warmupMinDays, setWarmupMinDays] = useState(3);
  const [timezone, setTimezone] = useState('UTC');
  const [shadowModeEnabled, setShadowModeEnabled] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setBaselineWindowDays(settings.baselineWindowDays);
    setWarmupMinDays(settings.warmupMinDays);
    setTimezone(settings.timezone);
    setShadowModeEnabled(settings.shadowModeEnabled);
  }, [settings]);

  const upsertMutation = useMutation(
    trpc.health.upsertSettings.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.health.getSettings.queryKey() });
        toast.success('Réglages du moteur de santé enregistrés');
      },
      onError: (error) => {
        toast.error("Échec de l'enregistrement", { description: error.message });
      },
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Moteur de santé</CardTitle>
        <CardDescription>
          Fenêtre glissante utilisée pour la baseline personnelle de chaque appareil, sa période de chauffe, et le fuseau horaire utilisé
          pour calculer la lumière reçue par jour (heure locale, minuit à minuit).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="health-baseline-window">Fenêtre de baseline (jours)</Label>
          <Input
            id="health-baseline-window"
            type="number"
            min={1}
            max={365}
            value={baselineWindowDays}
            onChange={(event) => setBaselineWindowDays(Number(event.target.value))}
            className="w-24"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="health-warmup-min">Chauffe minimum (jours)</Label>
          <Input
            id="health-warmup-min"
            type="number"
            min={0}
            max={365}
            value={warmupMinDays}
            onChange={(event) => setWarmupMinDays(Number(event.target.value))}
            className="w-24"
          />
        </div>
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
        <div className="flex flex-col gap-1">
          <Label htmlFor="health-shadow-mode">Mode observation (moteur d'inférence)</Label>
          <div className="flex h-9 items-center">
            <Switch id="health-shadow-mode" checked={shadowModeEnabled} onCheckedChange={setShadowModeEnabled} />
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={upsertMutation.isPending}
          onClick={() => upsertMutation.mutate({ baselineWindowDays, warmupMinDays, timezone, shadowModeEnabled })}
        >
          Enregistrer
        </Button>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 4: Typecheck the frontend**

Run: `cd frontend && pnpm typecheck` (the project's existing `tsc -b --noEmit` script).
Expected: clean.

- [ ] **Step 5: Manually verify in the browser**

Per this project's established preference (Playwright reserved for real visual checks, not
routine verification of a single toggle matching an already-existing pattern — see the
`AutoWateringSection` toggle this mirrors): start the dev servers
(`pnpm dev` at the repo root or per-package, matching how you'd normally run this project locally
with the mock provider), sign in with the local dev admin account (`admin@admin.com` / `admin`),
open `/settings`, confirm the "Mode observation (moteur d'inférence)" switch appears in the
"Moteur de santé" card, toggle it on, click "Enregistrer", reload the page, and confirm the
switch is still on (proving the round trip through `upsertSettings`/`getSettings` works). Toggle
it back off and save again before finishing, so shadow mode doesn't stay enabled in your local
`dev.db` from this manual check.

- [ ] **Step 6: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/api/trpc/routers/health.ts frontend/src/components/health-engine-settings-section.tsx
git commit -m "frontend: add shadow mode toggle to the health engine settings card (Phase B, shadow mode)"
```
