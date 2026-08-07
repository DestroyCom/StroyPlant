# Horticultural inference engine — design spec

Date: 2026-08-07
Status: approved by DestCom, ready for implementation planning

## Purpose

The current Health Engine (`backend/src/health/`, Batch 4 onward) compares sensor readings against
a species' reference range and produces a flat per-parameter status (`ok`/`too_low`/`too_high`).
This has served the project well, but it has structural limits that block the next step DestCom
wants: a system that reasons about *why* a plant might be struggling, combining multiple signals
into named, graded, explainable conclusions — not just flagging individual out-of-range numbers.

This spec defines a **horticultural inference engine** that replaces `computeDeviceHealth` with a
layered pipeline: `Measurements → Indicators → Facts → Symptoms → Diagnosis → Recommendations →
Narrative`. It was produced through an extended design dialogue (superpowers:brainstorming) — this
document consolidates the validated decisions, it does not re-derive them.

## What's wrong with the current Health Engine (baseline for this redesign)

Read in full before this spec: `backend/src/health/scoring.ts`, `dailyLightIntegral.ts`,
`soilConductivityCalibration.ts`, `scheduler.ts`. Concrete findings that motivate this redesign:

1. **Everything happens in one flat loop.** `computeDeviceHealth` computes rolling averages, unit
   conversion, species comparison, personal deviation, trend, DLI integration, and conductivity
   calibration all inline, then reduces to a single `ok`/`warning` via OR. There is no layer where
   an "indicator" exists independently of its comparison to a range.
2. **No cross-parameter correlation.** Status is per-parameter, OR'd together. "High temperature +
   high light + low moisture, sustained over days → water stress" is structurally inexpressible
   today — nothing combines multiple signals into a named conclusion with a confidence.
3. **The auto-watering scheduler reads a raw parameter status directly**
   (`scheduler.ts:77`, `health.parameters.soilMoisturePercent?.status !== 'too_low'`) — the
   watering decision is coupled to a low-level field inside the scoring function, not to a
   decoupled, independently testable recommendation.
4. **Botanical knowledge already leaks into the "engine".** `INDOOR_LIGHT_FLOOR_MMOL` and
   `classifyLightCategory()` (published DLI light categories) are hardcoded in `scoring.ts` — this
   is exactly the kind of generic-but-still-botanical rule that, with no proper home, keeps leaking
   into scoring logic every time a new edge case appears.
5. **Every derived signal was built as an isolated one-off module** — `dailyLightIntegral.ts`
   (trapezoidal integration + confidence gate), `soilConductivityCalibration.ts` (percentile +
   cache + confidence gate), inline trend detection in `scoring.ts` — three different hand-rolled
   implementations of "a derived indicator with a confidence gate." Continuing to hand-roll this
   per new sensor (Batch 10: Flower Power, Flower Care) is exactly the unmaintainable-accretion
   path this redesign avoids.
6. **7 call sites already consume `computeDeviceHealth`/`DeviceHealth`**: `scheduler.ts`,
   `api/trpc/routers/health.ts`, `mqtt/discovery.ts`, `mqtt/publisher.ts`,
   `frontend/src/lib/types.ts`, `frontend/src/lib/format.ts`. Any replacement is a 7-point
   migration, not an isolated rewrite — see the Migration Plan section.
7. **No confidence, no explanation trace anywhere.** Status is a flat enum. There is no support
   today for "why does the engine think this," a hard requirement for this redesign.

What's worth *keeping*: `computeDeviceHealth` is a pure function (no I/O) — that discipline carries
forward into every layer below. `PlantProfile` is already a generic min/max reference table, not a
per-species `if` — the species-blindness constraint below builds on, rather than fights, the
existing data model.

## Positioning

**The V1 engine is a rule-based horticultural expert system, with graded and explainable
reasoning.** It is explicitly *not* presented, internally or in any user-facing copy, as an
autonomous AI that "understands" plants. Its value comes from:

- the quality of the horticultural knowledge encoded into its reference data and rules;
- the structuring of raw observations into meaningful, reusable signals;
- the coherent combination of multiple signals into named conclusions;
- the complete explainability of every decision it produces.

The goal is not to replace an agronomist — it's an assistant that correctly exploits the data
StroyPlant already collects.

## Non-negotiable principles

### 1. Explainability before complexity

Every conclusion must be able to answer "why this decision?". An accuracy improvement that makes
the reasoning opaque is rejected, full stop — even if it would technically score better on some
metric.

### 2. The engine never invents information

Absence of a sensor ≠ a low value. Absence of history ≠ normal behavior. Unknown stays Unknown —
enforced structurally throughout this spec via `null` (unavailable) vs. `0` (checked, and
negative) evidence, never conflated (see Evidence Combination below).

### 3. Physical decisions must be conservative

A watering mistake can damage a plant. Faced with insufficient information, the engine must prefer
"I'm not sure enough" over "I'll act on incomplete information." This is why Recommendation
(horticultural reasoning) and physical Execution (the actual `triggerWatering()` call) remain two
separate layers with independent, non-overridable safety gating — see "Recommendation vs.
Execution" below.

### 4. Layers stay strictly separated

| Layer | Answers |
|---|---|
| Measurement | What was observed |
| Indicator | What was computed from observations |
| Fact | What is objectively true |
| Symptom | What appears to be physiologically affecting the plant |
| Diagnosis | The probable explanation |
| Recommendation | The proposed action |
| Narrative | The message shown to the user |

No layer absorbs another's responsibility. A Fact never grades severity. A Symptom never touches a
`PlantProfile`. A Recommendation never reads raw Measurements.

## Species-blindness — the one botanical boundary

**Constraint**: the inference engine must never know about plant species. Species only ever supply
reference data (optimal ranges, tolerances, light/water/nutrient needs) through a generic port.

```ts
interface Range { min: number | null; max: number | null; }

interface ReferenceProfile {
  soilMoisturePercent?: Range;
  temperatureC?: Range;
  humidityPercent?: Range;
  luminosityMmolPerDay?: Range;
  soilConductivityUsCm?: Range;
}
```

`resolveReferenceProfile(plantProfile: PlantProfile, environment: Device['environment']):
ReferenceProfile` is the **only** function in the whole project allowed to import `PlantProfile`
from `@prisma/client` and to encode generic-but-botanical adjustment knowledge (this is where
`classifyLightCategory()`/`INDOOR_LIGHT_FLOOR_MMOL` move to, out of `scoring.ts` — finding #4
above). It is also the only place a future community/user-authored profile source would plug in,
producing the same `ReferenceProfile` shape from a different origin, with zero change downstream.

**Enforcement is an architecture boundary, not any single tool** — a lint rule alone is not the
protection (a disabled rule, a bypassed local Biome config, or a future linter migration could
silently drop it). Three independent, complementary layers, deliberately without adding heavy new
infrastructure (no dependency-graph library, no custom ESLint plugin):

1. **Folder convention**: all inference code (Indicators, Facts, Symptoms, Diagnosis,
   Recommendations) lives under `backend/src/inference/`, with exactly one exempted file,
   `inference/referenceProfile.ts`.
2. **A CI-enforced import scan** — a small, dependency-free script (a few lines: read every `.ts`
   file under `backend/src/inference/` except `referenceProfile.ts`, grep/regex-match for
   `from '@prisma/client'` combined with `PlantProfile`, fail with a non-zero exit code on any
   match), wired into the existing GitHub Actions workflow. This is the actual guarantee: it runs on
   every PR regardless of any individual contributor's local Biome config, and fails the build
   loudly rather than silently passing review.
3. **Biome lint locally**, as a fast, same-keystroke IDE signal — genuinely useful for immediate
   feedback while writing a rule, but explicitly the convenience layer, not the enforcement
   mechanism; layer 2 is what a broken/bypassed layer 3 can't defeat.
4. **Documentation** (this spec + `CLAUDE.md`) stating the constraint explicitly, so a future
   contributor understands *why* the CI check exists rather than treating a failure as a mysterious
   build gate to route around.

A `PlantProfile`, a `plantProfileId`, or a species name cannot be referenced from a
Fact/Symptom/Diagnosis/Recommendation rule and reach `main` — a CI failure, not a hoped-for code
review catch.

## Pipeline architecture

```text
Measurements
    │  (Reading[], WateringEvent[] — already persisted, unchanged)
    ▼
Indicators           — derived, generic, zero botany, carries temporality (windows, trend, sample size)
    ▼
Facts                — atomic objective booleans, with confidence, optionally profile-relative
    ▼
Symptoms             — graded physiological interpretation (severity + confidence + coverage)
    ▼
Diagnosis             — causal hypotheses, graded, tiered, possibly several in parallel
    ▼
Recommendations       — candidate actions, reconciled, prioritized (advisory only, see Execution)
    ▼
Narrative (optional, UI-owned) — engine emits structured tokens; rendering/LLM reformulation happens outside the engine
```

`InferenceEngine` orchestrates these steps and contains **zero** domain knowledge itself — it
reduces four arrays of pluggable rules over a context object:

```ts
class InferenceEngine {
  constructor(
    private indicatorDefs: IndicatorDefinition[],
    private factDefs: FactDefinition[],
    private symptomRules: SymptomRule[],
    private diagnosisRules: DiagnosisRule[],
    private recommendationRules: RecommendationRule[],
  ) {}

  run(
    observations: DeviceObservations,
    profile: ReferenceProfile | null,
    environment: EnvironmentContext,
    operational: OperationalConstraints,
  ): InferenceResult {
    const indicators = computeIndicators(this.indicatorDefs, observations, environment);
    const facts = computeFacts(this.factDefs, indicators, profile);
    const ctx: InferenceContext = { indicators, facts, plantState: null, environment };
    const symptoms = computeSymptoms(this.symptomRules, ctx);
    const diagnoses = classifyTiers(computeDiagnoses(this.diagnosisRules, { ...ctx, symptoms }));
    const recommendations = reconcileRecommendations(
      computeRecommendationCandidates(this.recommendationRules, diagnoses, { ...ctx, operationalConstraints: operational }),
      diagnoses,
    );
    return { indicators, facts, symptoms, diagnoses, recommendations };
  }
}
```

Adding a new Diagnosis (or Symptom, Fact, Indicator, Recommendation) means writing a new file that
implements the relevant interface and adding it to the array constructed in one `registry.ts` file.
`InferenceEngine` itself is never touched.

**The DSL escape hatch**: because every rule type is a plain interface with an `evaluate()` method,
a future declarative rule language is just one more implementation of the same interfaces —
`class DeclarativeDiagnosisRule implements DiagnosisRule { constructor(def: RuleJson) {}
evaluate(ctx) { return interpretRule(this.def, ctx); } }` — wrapping any number of JSON rule
definitions and pushing them into the same registry array alongside hand-written TS rules. V1 does
**not** build this DSL (see Alternatives Considered) — it builds the architecture so a DSL can
arrive later without touching the engine or any existing rule.

### Shared types

Referenced throughout the rest of this spec — declared once here rather than left implicit:

```ts
type AvailabilityReason = 'sensor_absent' | 'no_recent_data' | 'insufficient_history';
type DeviceCapabilities = ('soilMoisture' | 'temperature' | 'luminosity' | 'conductivity' | 'humidity')[];

interface EnvironmentContext {
  deviceKind: Device['kind'];
  environment: Device['environment'];
  capabilities: DeviceCapabilities;                                            // what the hardware can measure
  observationsAvailability: Record<string, AvailabilityReason | 'available'>;   // what actually exists in current data, per capability
}

type IndicatorIndex = Map<IndicatorId, IndicatorValue>;   // in-memory, O(1)-lookup form used inside a run() call
type FactSnapshot = Map<FactId, FactResult>;
type SymptomSnapshot = Map<SymptomId, SymptomResult>;
type DiagnosisSnapshot = Map<DiagnosisId, DiagnosisFinding>;

interface InferenceContext {
  indicators: IndicatorIndex;
  facts: FactSnapshot;
  plantState?: PlantState | null;   // reserved for V2, see Roadmap — V1: type PlantState = unknown
  environment: EnvironmentContext;
}

interface InferenceResult {
  indicators: IndicatorIndex;
  facts: FactSnapshot;
  symptoms: SymptomSnapshot;
  diagnoses: DiagnosisFinding[];       // tiered, ranked
  recommendations: Recommendation[];   // reconciled, prioritized
}
```

**`FactId`/`IndicatorId`/`SymptomId`/`DiagnosisId` are plain string types, deliberately not a
central string-literal union.** A central union would have to be edited every time any file adds a
new rule — exactly the kind of shared choke point the registry/plugin model exists to avoid (see
Extensibility below). The cost of that choice is that TypeScript alone cannot catch a typo'd
reference at compile time; `validateRegistry()` is what catches it instead, at backend startup
rather than at `tsc` time. This is a deliberate trade, not an oversight.

`factEvidence()`/`indicatorEvidence()`/`symptomEvidence()`/`operationalEvidence()`, used in the
worked examples below, are thin adapter helpers that look up a value in a Snapshot/context and
produce an `EvidenceItem` (with `strength: null` when the referenced id isn't present) — sugar over
the `EvidenceItem` contract, not additional contract surface of their own.

A separate, serializable `IndicatorSnapshot` shape (`{ deviceId, computedAt, indicators:
IndicatorValue[] }`) is used for the Indicator *cache* — see "Indicator computation and caching"
below — and converted to an `IndicatorIndex` at the point a `run()` call needs it. The two are not
the same type: `IndicatorIndex` is the live in-memory lookup structure, `IndicatorSnapshot` is the
at-rest/transport form.

## Layer contracts

### Measurements

```ts
interface DeviceObservations {
  readings: Reading[];        // includes RawSensorLog join where needed
  wateringEvents: WateringEvent[];
}
```

Unchanged — this is what's already persisted today.

### Indicators — derived data, zero botany, carries temporality

```ts
type AvailabilityReason = 'sensor_absent' | 'no_recent_data' | 'insufficient_history';

interface IndicatorValue<T = number> {
  id: IndicatorId;
  value: T | null;             // null = not computable yet, never a fabricated value
  confidence: number;          // 0..1
  meta?: { windowHours?: number; sampleSize?: number; trend?: 'improving' | 'stable' | 'degrading'; [k: string]: unknown };
}

interface IndicatorDefinition {
  id: IndicatorId;
  requiredFields: (keyof Reading)[];   // drives capability-based activation, see Extensibility
  compute(observations: DeviceObservations, environment: EnvironmentContext): IndicatorValue;
}
```

Indicators receive **only** `DeviceObservations` (+ device-shape context, never a profile). This is
where `computeDailyTotals` (DLI integration), the personal-baseline mean/stddev, and the
conductivity percentile calibration move to — three existing one-off modules become three
`IndicatorDefinition`s of the same shape. Examples: `soilMoistureRollingAvg1h`,
`dryingRatePercentPerDay`, `dliDailyTotal`, `daysSinceLastWatering`, `wateringIntervalMean7d`,
`recoverySpeedAfterWatering`, `conductivityCalibratedValue`.

### Indicator computation and caching

Several candidate Indicators are genuinely expensive: `dliDailyTotal` re-integrates a device's whole
recent reading history trapezoidally, the personal-baseline mean/stddev and the conductivity
percentile calibration both scan a device's all-time history. None of these should be recomputed on
every HTTP request (`health.deviceHealth`, MQTT publish, MCP tool call) — the same concern that
already motivated `soilConductivityCalibration.ts`'s existing 60-second in-memory cache today.

The pipeline splits cleanly at exactly this point:

```text
RawSensorLog / Reading
        ▼
IndicatorSnapshot (cached)
        ▼
Facts → Symptoms → Diagnosis → Recommendations   (always computed on demand — cheap, pure, no I/O)
```

```ts
interface IndicatorSnapshot {
  deviceId: string;
  computedAt: Date;
  indicators: IndicatorValue[];
}

function toIndicatorIndex(snapshot: IndicatorSnapshot): IndicatorIndex {
  return new Map(snapshot.indicators.map(i => [i.id, i]));
}
```

**Recommendation: in-memory, TTL-based, following the pattern this codebase already uses** —
`soilConductivityCalibration.ts`'s `calibrationCache = new Map<string, { value, expiresAt }>()` is
the direct precedent, not a new pattern being introduced. A module-level
`Map<deviceId, { snapshot: IndicatorSnapshot; expiresAt: number }>`, recomputed either lazily (TTL
expiry hit on read) or proactively by the existing ~5-minute scheduler tick
(`namedDevicePoller.ts`) right after a poll persists new readings — either is a legitimate choice
for the implementation plan, but no *new* infrastructure (cron, queue, DB table) is needed either
way. Facts/Symptoms/Diagnosis/Recommendations stay computed on demand, uncached — they're pure
reductions over an already-computed `IndicatorIndex`, cheap enough that caching them would add
complexity (cache invalidation on every input layer) for no measurable benefit.

**Not proposed**: persisting `IndicatorSnapshot` to the database. A single-process deployment (this
project's actual shape, spec section 6) has no cross-process cache-sharing need — an in-memory
cache is simpler and sufficient. Revisit only if the deployment ever becomes genuinely
multi-instance, which nothing in this project's roadmap currently calls for.

### Facts — atomic objective booleans, no severity

```ts
interface FactResult {
  id: FactId;
  holds: boolean;
  confidence: number;
  supportingIndicators: IndicatorId[];
  evidence?: Record<string, unknown>;   // e.g. { currentValue: 18, minimumExpected: 35, deviationPercent: 48 }
}

interface FactDefinition {
  id: FactId;
  needsProfile: boolean;
  requiredIndicators: IndicatorId[];    // static manifest, used by validateRegistry()
  evaluate(indicators: IndicatorIndex, profile: ReferenceProfile | null): FactResult | null;
}
```

**Facts deliberately carry no severity.** A Fact answers "is this objectively true?" — magnitude
interpretation belongs to Symptoms. `soil_moisture_below_profile_min` reports `holds: true` with
`evidence` giving the raw numbers; it does not grade how bad that is. This keeps the boundary
between *observation* (Fact) and *interpretation* (Symptom) unambiguous, and avoids Facts becoming
pseudo-Symptoms.

**Temporality is explicit in the Fact's identity, not a hidden parameter**: prefer
`soil_dry_transient` / `soil_dry_prolonged` as two distinct Facts over a single
`soil_dry { duration }` parameterized Fact — the duration is part of what defines the Fact, kept
out of Facts' data shape entirely so no Fact carries hidden parameters a Symptom rule has to know
about.

Facts split into two families depending on `needsProfile`:
- **Self-relative** (profile-independent): `wet_for_5_days`, `drying_rate_unusually_slow`,
  `watering_interval_unusually_short`, `recovery_after_watering_unusually_slow` — computed purely
  from this device's own Indicators.
- **Profile-relative**: `soil_moisture_below_profile_min`, `dli_below_target_7_days` — need both
  Indicators and `ReferenceProfile`.

### Symptoms — graded physiological interpretation

```ts
interface EvidenceCoverage { availableWeight: number; totalWeight: number; ratio: number; }

interface SymptomResult {
  id: SymptomId;
  severity: number;             // 0..1 — magnitude, "how bad if it's happening"
  confidence: number;           // 0..1 — corroboration, "how sure are we"
  coverage: EvidenceCoverage;   // "how much of the intended evidence was actually available"
  supportingFacts: FactId[];
  evidenceBreakdown: EvidenceBreakdown;
}

interface SymptomRule {
  id: SymptomId;
  requiredFacts?: FactId[];                              // optional hard gate
  consumes: { facts: FactId[]; indicators: IndicatorId[] };  // static manifest, validateRegistry()
  evaluate(ctx: InferenceContext): SymptomResult | null;    // null = no evidence available at all
}
```

A Symptom reads both Facts and Indicators directly, and defines its own evidence composition
(linear, sigmoid, weighted — whatever the physiology calls for) — but composes it from the **same
two canonical combination functions** every other layer uses (see Evidence Combination below),
never a bespoke formula. `severity` and `confidence` are computed from the *same* declared evidence
list, via two different reductions — not two independently hand-tuned numbers.

### Diagnosis — causal hypotheses, tiered

```ts
interface DiagnosisFinding {
  id: DiagnosisId;
  severity: number;
  confidence: number;
  coverage: EvidenceCoverage;
  tier: 'dominant' | 'secondary' | 'weak_hypothesis';   // set by the engine's post-processing, never by the rule
  evidenceBreakdown: EvidenceBreakdown;
}

interface DiagnosisRule {
  id: DiagnosisId;
  consumes: { symptoms: SymptomId[] };
  evaluate(ctx: InferenceContext & { symptoms: SymptomSnapshot }): Omit<DiagnosisFinding, 'tier'> | null;
}
```

A Diagnosis is a causal hypothesis, not an alias of one Symptom — `water_stress: 0.8` (Symptom) →
`chronic_underwatering: 0.75` (Diagnosis) is expected to differ; the Diagnosis rule adds
interpretation (e.g. corroborating with `irregular_watering`, discounting for
`waterlogged_substrate` as contradicting evidence), not just relabel the Symptom.

Multiple diagnoses run in parallel by construction — `InferenceEngine.run()` always returns
`DiagnosisFinding[]`, never picks one winner internally.

### Recommendations — advisory candidate actions

```ts
type RecommendationAction = 'TRIGGER_WATERING' | 'DELAY_WATERING' | 'INCREASE_LIGHT_GRADUALLY' | 'REDUCE_FERTILIZER' | /* ... */ string;

interface OperationalConstraints {
  autoWateringEnabled: boolean;
  withinAllowedWindow: boolean;
  cooldownActive: boolean;
}

interface RecommendationResult {
  action: RecommendationAction;
  urgency: 'info' | 'advisory' | 'action_needed';
  confidence: number;
  triggeredBy: DiagnosisId;      // singular at the candidate level
  evidenceBreakdown: EvidenceBreakdown;
}

interface RecommendationRule {
  id: string;
  triggers: DiagnosisId[];       // a rule may fire from several distinct diagnoses
  evaluate(diagnosis: DiagnosisFinding, ctx: InferenceContext & { operationalConstraints: OperationalConstraints }): RecommendationResult | null;
}

interface Recommendation {
  action: RecommendationAction;
  urgency: 'info' | 'advisory' | 'action_needed';
  confidence: number;
  triggeredBy: DiagnosisId[];    // merged across every diagnosis that independently recommended this action
  importance: number;            // internal-only ranking score, see Priority Score
}
```

The engine evaluates a `RecommendationRule` once per matching diagnosis present in
`diagnoses` (per its `triggers` list) — producing candidates, which a separate reconciliation step
(not the rules themselves) dedupes and resolves conflicts on. A `RecommendationRule` never sees the
full candidate list or other rules — it stays independently testable.

A Recommendation's `confidence` is **not** a blind copy of `diagnosis.confidence` — it's a decision
that can be discounted by operational constraints (tank already full, auto-watering disabled by the
user). Rather than invent a third ad hoc formula, the diagnosis itself becomes one more
`EvidenceItem` (`{ kind: 'diagnosis'; id }`), combined with operational-constraint evidence items
via the same `combineNoisyOr` used everywhere else:

```ts
const triggerWatering: RecommendationRule = {
  id: 'trigger_watering',
  triggers: ['chronic_underwatering'],
  evaluate(diagnosis, ctx) {
    const items: EvidenceItem[] = [
      { source: { kind: 'diagnosis', id: diagnosis.id }, weight: 1, strength: diagnosis.confidence, confidence: diagnosis.confidence, polarity: 'supports' },
      { source: { kind: 'operational', id: 'cooldown_active' }, weight: 1, strength: ctx.operationalConstraints.cooldownActive ? 1 : 0, confidence: 1, polarity: 'contradicts' },
    ];
    const { confidence, breakdown } = combineNoisyOr(items);
    return { action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence, triggeredBy: diagnosis.id, evidenceBreakdown: breakdown };
  },
};
```

Operational constraints (`OperationalConstraints`) are supplied only to Recommendation evaluation —
never leaked into `InferenceContext` for Indicators/Facts/Symptoms/Diagnosis, which stay free of
business/operational concerns.

### Recommendation reconciliation — redundancy and conflict

Two distinct problems, handled separately, after all candidates are collected:

**Redundant candidates** (several diagnoses recommend the same action) — merged: group by
`action`, union `triggeredBy`, keep the max `confidence`. This is preserved as a positive signal
("3 independent diagnoses converge on this action"), not discarded.

**Genuinely incompatible actions** — a small explicit exclusion table:

```ts
const MUTUALLY_EXCLUSIVE_ACTIONS: [RecommendationAction, RecommendationAction][] = [
  ['TRIGGER_WATERING', 'DELAY_WATERING'],
];
```

On collision, keep the action whose triggering diagnosis has the higher **Priority Score**
(defined below) — the same score used for Diagnosis tiering, not a second ranking philosophy.

**Display priority** for the final, non-conflicting list: sort by `urgency`
(`action_needed` > `advisory` > `info`), then by `confidence` descending.

### Recommendation vs. Execution — the physical safety boundary

**A Recommendation is advisory input, never a sufficient condition for a physical action.** This is
principle #3 above, made concrete: the actual `triggerWatering()` call
(`backend/src/watering.ts`, shared today by the manual mutation and the CRON scheduler, and already
subject to the project's "never fire-and-forget" rule, spec section 7.1) is **not** part of the
inference engine and does not trust a Recommendation's confidence by itself.

`scheduler.ts`'s existing structure already embodies this separation and does not change in kind:
`resolveEffectiveSchedule` / `isWithinAllowedWindow` / cooldown checks run **before** any health
evaluation happens at all, independently of what the engine concludes. After migration (see
Migration Plan), the scheduler's gate becomes: `recommendations.some(r => r.action ===
'TRIGGER_WATERING')` **as one necessary condition among several**, re-verified independently
(cooldown, allowed hours, tank state via `STATUS_FLAGS.isEmptyTank`) — the engine's confidence
score is never treated as already having accounted for physical safety, even though
`OperationalConstraints` feeds into it. Redundant gating here is intentional, not an oversight: the
inference engine's job is horticultural reasoning; the scheduler's job is safe execution — two
independent authorities is safer than one that's assumed to have covered everything.

### Narrative — a product/UI responsibility, not the engine's

**Narrative is repositioned relative to earlier drafts of this spec**: the engine's own
responsibility stops at producing a structured, translatable summary — never final rendered prose.
Owning the actual wording (language, tone, phrasing) is a product/UI concern, kept out of
`backend/src/inference/` for the same reason Facts don't grade severity and Symptoms don't touch
`PlantProfile` (principle #4 — no layer absorbs another's responsibility).

```ts
interface ExplanationToken {
  token: string;                          // e.g. 'fact_below_min', 'symptom_contributor', 'diagnosis_summary'
  params: Record<string, string | number>;
}

function toExplanationTokens(breakdown: EvidenceBreakdown): ExplanationToken[];   // engine-owned, pure, structured — not prose
```

The engine emits `DiagnosisFinding[]`/`Recommendation[]` (via `PlantHealthStatusDTO` above for the
minimal case) plus these `ExplanationToken[]` for a richer, future detailed view. Turning tokens
into actual text is the frontend's job: a deterministic template renderer (mapping each token to a
phrase, per locale) is a legitimate, still-LLM-free way to do it — it's simply frontend/presentation
code, not engine code. This is scope V1 does not build (see V1 Scope below) — the engine is left
*capable* of producing tokens; the detailed-explanation UI that consumes them is not part of this
spec's first slice.

An optional future `NarrativeProvider` (user-configured, no vendor lock-in, Lot 2) is one more
consumer of this same structured output — `DiagnosisFinding[]`/`Recommendation[]` and
`ExplanationToken[]`, **never** raw Measurements, the full reading history, or the internal
`EvidenceBreakdown` tree (consistent with External Representations above: an LLM provider is an
external consumer like any other, it doesn't get backend-only internals just because a user
configured it). Its role is reformulation only; it cannot alter, weight, or override any confidence/
severity value it's given. It may narrate, never diagnose.

## Evidence combination — exactly two canonical functions

To avoid N ad hoc, subtly-inconsistent formulas across dozens of future rules, **the entire system
uses exactly two combination functions**, defined once, unit-tested once, and composed (never
reimplemented) by every Symptom/Diagnosis/Recommendation rule:

```ts
type EvidenceSource =
  | { kind: 'fact'; id: FactId }
  | { kind: 'indicator'; id: IndicatorId }
  | { kind: 'symptom'; id: SymptomId }
  | { kind: 'diagnosis'; id: DiagnosisId }
  | { kind: 'operational'; id: string };

interface EvidenceItem {
  source: EvidenceSource;
  weight: number;               // hand-chosen by the rule author — domain judgment, not derived
  strength: number | null;      // 0..1, or null if unavailable — NEVER defaulted to 0
  confidence: number | null;    // confidence of this specific piece of evidence
  polarity: 'supports' | 'contradicts';
}

interface EvidenceContribution extends EvidenceItem { contribution: number; }  // this item's actual numeric effect, post-weighting

interface EvidenceBreakdown {
  formula: 'weightedAverage' | 'noisyOr';
  items: EvidenceContribution[];
  missing: Array<{ source: EvidenceSource; reason: AvailabilityReason }>;
}

function computeCoverage(items: EvidenceItem[]): EvidenceCoverage;
// availableWeight = Σ weight for items with strength != null
// totalWeight = Σ weight for all declared items
// ratio = availableWeight / totalWeight

function combineWeightedEvidence(items: EvidenceItem[]): { value: number | null; breakdown: EvidenceBreakdown };
// weighted mean over non-null items, renormalized over available weight; null if none available

function combineNoisyOr(items: EvidenceItem[]): { confidence: number; breakdown: EvidenceBreakdown };
// positive = 1 − Π(1 − weight·strength·confidence) over polarity='supports'
// negative = 1 − Π(1 − weight·strength·confidence) over polarity='contradicts'
// confidence = positive × (1 − negative)
```

**Why two, not one**: `severity` answers "how big is the effect" — an arithmetic blend fits (mild
dryness + mild heat = a moderate symptom). `confidence` answers "how much do independent clues
corroborate this hypothesis" — a probabilistic saturation fits (a third converging clue should
reinforce confidence without ever pushing it past 1; a strong contradicting clue should be able to
suppress it). These are different questions; forcing one formula to answer both would produce worse
results. The count stays at exactly two, both centrally defined — reviewing any of the dozens of
future rules only ever requires understanding these two functions, never a bespoke one.

**`null` vs. `0` — never conflated.** `strength: null` means "this evidence is unavailable" (sensor
absent, no recent data, insufficient history) — it lowers `coverage` and is excluded from the
weighted/noisy-OR reduction. `strength: 0` means "this evidence was checked and found to be
negative/absent" — a real, present data point. Confusing the two would make a device missing a
sensor look artificially healthy on that axis instead of "impossible to evaluate." This is the
concrete mechanism behind principle #2 ("the engine never invents information").

**Honesty about weights**: `weight` remains hand-chosen by each rule's author — this architecture
does not remove that human judgment (no training data exists to derive it statistically, by
design — see Alternatives Considered). What it prevents is that judgment being expressed through N
inconsistent formulas; it constrains *where* subjectivity can live, not whether it exists.

## Priority score — diagnosis tiering and recommendation conflicts

A single internal score, reused everywhere ranking is needed (never re-derived per use site):

```ts
const importance = severity * confidence * coverage.ratio;
```

Multiplicative, not additive — a high confidence with low coverage should be strongly discounted,
not merely averaged down. Verified against the motivating example: `severity=0.9, confidence=0.65,
coverage=0.95 → importance=0.556` clearly outranks `severity=0.3, confidence=0.75, coverage=0.20 →
importance=0.045`, as intended — a severe, well-evidenced finding beats a mild, thinly-evidenced
one even though its raw confidence is lower.

```ts
const DOMINANT_IMPORTANCE_THRESHOLD = 0.5;    // to recalibrate empirically once real data exists
const WEAK_HYPOTHESIS_IMPORTANCE_THRESHOLD = 0.15;

function classifyTiers(findings: Array<Omit<DiagnosisFinding, 'tier'>>): DiagnosisFinding[] {
  const maxImportance = Math.max(...findings.map(f => f.severity * f.confidence * f.coverage.ratio));
  return findings.map(f => {
    const importance = f.severity * f.confidence * f.coverage.ratio;
    const tier = importance < WEAK_HYPOTHESIS_IMPORTANCE_THRESHOLD ? 'weak_hypothesis'
      : importance >= DOMINANT_IMPORTANCE_THRESHOLD && importance === maxImportance ? 'dominant'
      : 'secondary';
    return { ...f, tier };
  });
}
```

`importance` (and by extension `tier`) is a **decision/prioritization score only** — never a
"health score," never surfaced to end users as if it summarized well-being, never used to rank
anything other than internal ordering. `severity`, `confidence`, `coverage` stay independently
visible wherever a finding is shown, for honesty.

`Recommendation.importance` (reconciliation) is the max `importance` among the diagnoses that
triggered it — not a separately invented recommendation-level score.

## Calibration layer — adapting parameters, never reasoning

The blanket rejection of ML (Alternatives Considered) is too absolute for one specific, narrow
need: the hand-chosen `weight`/threshold constants scattered across every rule (Evidence
Combination's honesty note above) will need periodic adjustment as real production data comes in —
this project has already lived that twice (soil conductivity's formula, luminosity's unit). Without
a designated place for that adjustment to live, it either doesn't happen (constants silently rot)
or happens by editing rule source directly (untracked, unversioned, indistinguishable from a
genuine logic change in `git blame`).

**The rule stays absolute: the system adapts reasoning *parameters*, never reasoning *itself*.**
No calibration mechanism may ever change which rules fire, add or remove a Diagnosis, flip a
`polarity`, or bypass `validateRegistry()`.

```ts
interface RuleCalibration {
  ruleId: string;                 // the Fact/Symptom/Diagnosis/Recommendation id being adjusted
  deviceId: string | null;        // null = global default; set = per-device personalization
  weightMultiplier: number;       // default 1.0 — scales an EvidenceItem's weight before combination
  thresholdOffset: number;        // default 0 — added to whatever threshold the rule's own composition uses
  confidenceAdjustment: number;   // default 1.0 — final multiplicative clamp on the combined confidence
  source: 'manual_feedback' | 'historical_observation' | 'operator_adjustment';
  version: number;
  enabled: boolean;
  createdAt: Date;
}
```

**Where it applies** — three fixed, narrow injection points, not a generic hook a rule can abuse
arbitrarily:

```ts
function applyCalibration(items: EvidenceItem[], calibration: RuleCalibration | null): EvidenceItem[] {
  if (!calibration?.enabled) return items;   // absent or disabled = true no-op, byte-identical output
  return items.map(item => ({ ...item, weight: item.weight * calibration.weightMultiplier }));
}
```

`weightMultiplier` is applied generically (above) before either canonical combination function runs.
`thresholdOffset` has no fixed meaning outside a specific rule's own composition (a sigmoid
midpoint, a linear-map bound) — the rule author reads it explicitly at the point it builds a
threshold-dependent evidence item, e.g. `sigmoid(value, 30 + (calibration?.thresholdOffset ?? 0),
0.3)`. `confidenceAdjustment` applies once, after `combineNoisyOr`:
`Math.min(1, Math.max(0, raw.confidence * (calibration?.confidenceAdjustment ?? 1)))`.

**Persistence** — a new lightweight table, versioned (never overwritten, a new row per change) so
every past calibration state is reconstructable:

```prisma
model RuleCalibration {
  id                   Int      @id @default(autoincrement())
  ruleId               String
  deviceId             String?
  device               Device?  @relation(fields: [deviceId], references: [id])
  weightMultiplier     Float    @default(1)
  thresholdOffset      Float    @default(0)
  confidenceAdjustment Float    @default(1)
  source               String   // 'manual_feedback' | 'historical_observation' | 'operator_adjustment'
  version              Int      @default(1)
  enabled              Boolean  @default(true)
  createdAt            DateTime @default(now())

  @@unique([ruleId, deviceId, version])
}
```

**V1 scope, deliberately narrow**: only `manual_feedback`/`operator_adjustment` sources are
realistic in V1 — a person decides the values (e.g. DestCom noticing a rule fires too eagerly and
lowering its weight), never a statistical process. `historical_observation` — a small statistical
routine that observes a device's own history and *proposes* a calibration adjustment (the same
percentile-based spirit already used by `soilConductivityCalibration.ts`, never a trained model) —
is explicitly V2 scope (see Roadmap), not built now. The contract and storage exist from V1 so V2
has a place to write into; the derivation logic doesn't.

## Contradictory diagnoses

`polarity: 'contradicts'` in a `DiagnosisRule`'s declared evidence list is how a diagnosis states
what would disconfirm it — e.g.:

```ts
const chronicUnderwatering: DiagnosisRule = {
  id: 'chronic_underwatering',
  consumes: { symptoms: ['water_stress', 'irregular_watering', 'waterlogged_substrate'] },
  evaluate(ctx) {
    const items: EvidenceItem[] = [
      symptomEvidence(ctx.symptoms, 'water_stress', 0.6, 'supports'),
      symptomEvidence(ctx.symptoms, 'irregular_watering', 0.4, 'supports'),
      symptomEvidence(ctx.symptoms, 'waterlogged_substrate', 0.5, 'contradicts'),
    ];
    const { value: severity } = combineWeightedEvidence(items.filter(i => i.polarity === 'supports'));
    const { confidence, breakdown } = combineNoisyOr(items);
    const coverage = computeCoverage(items);
    if (severity == null) return null;
    return { id: 'chronic_underwatering', severity, confidence, coverage, evidenceBreakdown: breakdown };
  },
};
```

If `waterlogged_substrate` fires with high severity, `combineNoisyOr`'s `negative` term suppresses
`chronic_underwatering`'s confidence multiplicatively — bounded in `[0,1]` by construction, no
clamping needed. Each `DiagnosisRule` explicitly encodes what would disconfirm it; the architecture
does not hope two incompatible symptoms never co-occur.

## Explainability — a structured trace, not hand-written strings

Every `SymptomResult` and `DiagnosisFinding` carries an `EvidenceBreakdown`. Because a Diagnosis
references Symptoms which carry their own `EvidenceBreakdown` (referencing Facts/Indicators), the
full reasoning chain is walkable end to end without recomputation — "why 0.72 and not 0.35" is
answerable by descending the tree.

**Runtime vs. persisted**: the full `EvidenceBreakdown` tree exists only during a `run()` call and
in the in-memory `InferenceResult` returned to orchestration (tRPC query, scheduler tick, MQTT
publish). It is intentionally **not** persisted wholesale — see `DiagnosisEvent` below, which stores
a deliberately smaller summary. The full tree is always reproducible on demand from `Reading`/
`RawSensorLog` (never purged, per this project's existing retention stance) since the pipeline is
pure and deterministic — nothing is lost by not archiving it, only recomputation cost is incurred if
ever needed.

## External representations

`InferenceResult` (and any `EvidenceBreakdown` it contains) is an internal shape — never serialized
directly into a tRPC response, an MQTT payload, or an MCP tool result. Every external boundary goes
through an explicit, deliberately minimal DTO:

```ts
interface PlantHealthStatusDTO {
  diagnoses: Array<{ id: string; severity: number; confidence: number; tier: string }>;
  recommendations: Array<{ action: string; confidence: number }>;
}

function toPlantHealthStatusDTO(result: InferenceResult): PlantHealthStatusDTO;
```

`EvidenceBreakdown` stays backend-only — used for debugging, and reserved for a future detailed
explanation view (see Narrative below) — never present in `PlantHealthStatusDTO`. Nothing about the
internal `DiagnosisFinding`/`Recommendation` shapes (coverage details, evidence contribution
weights, internal `importance` scores) crosses this boundary either — only what a consumer
genuinely needs to display or act on.

**Relationship to the migration adapter** (`toLegacyDeviceHealth`, Migration Plan below) —
these are not two competing mechanisms: `toLegacyDeviceHealth` exists *only* for Phase B's
shadow-mode diff, which inherently needs the new result reshaped into the *old* `DeviceHealth` form
to compare like-for-like against the legacy engine's actual output. Real consumers migrating in
Phase C go straight to `PlantHealthStatusDTO`, the permanent go-forward contract — not to the
legacy shape. `toLegacyDeviceHealth`, the legacy `DeviceHealth` type, and this distinction all
disappear together in Phase E once every consumer speaks `PlantHealthStatusDTO` natively.

## Extensibility for new sensors

**Rule**: new device compatible with existing concepts → automatic reuse. New, genuinely unknown
data → new `IndicatorDefinition`, purely additive.

- `IndicatorDefinition.requiredFields` (`(keyof Reading)[]`) plus `EnvironmentContext.capabilities`
  gate which Indicators are even computed per device — an Indicator whose required fields aren't
  present for a device kind is simply never computed (absent from the snapshot, not `null`).
- Facts/Symptoms/Diagnoses reference `IndicatorId`/`FactId`/`SymptomId` **by name only**, never by
  device kind. A Flower Power device measuring the same conceptual soil moisture/light/temperature
  as a Parrot Pot automatically activates every existing Fact/Symptom/Diagnosis that already
  references those Indicator ids — zero rule code touched.
- A genuinely new measurement (e.g. ambient CO2) is a new `IndicatorDefinition` (+ optional new
  Facts/Symptoms consuming it) — strictly additive; a rule that doesn't declare a dependency on the
  new id cannot, by construction, be affected by its existence.

`EnvironmentContext.capabilities`/`observationsAvailability` (declared in Shared Types above) is
what actually drives this gating. This distinguishes "this device has no such sensor" from "the
sensor exists but seems to have gone silent" — both propagate as `strength: null` (never `0`)
through Facts/Symptoms, but with a different `reason`, preserved into `EvidenceBreakdown.missing`
for the user-facing explanation.

**Guard against silent breakage**: `validateRegistry(engine)`, run once at backend startup,
statically checks — without executing any rule — that every `FactDefinition.requiredIndicators`,
`SymptomRule.consumes`, `DiagnosisRule.consumes`, and `RecommendationRule.triggers` reference an id
actually present in the corresponding registry, and that every `RecommendationAction` referenced in
`MUTUALLY_EXCLUSIVE_ACTIONS` or produced by a `RecommendationRule` is a recognized action value —
this is the concrete form of what DestCom's review referred to as validating "RecommendationId":
there's no separate id space for Recommendations, `RecommendationRule.id` (rule identity) and
`RecommendationAction` (the enum of possible actions) together cover that ground. Fails loudly
(startup error) on any dangling reference instead of letting a typo silently produce a symptom
that's permanently "no evidence available." This is why every rule interface carries a
static dependency manifest (`requiredIndicators`/`consumes`/`triggers`) alongside its imperative
`evaluate()` — the manifest is what makes validation possible without running the engine.

## Persistence — `DiagnosisEvent`

Together with `RuleCalibration` (Calibration Layer above), the only new persisted state this spec
introduces — the full `EvidenceBreakdown` tree is never persisted (see below), matching this
project's existing "no persistence before a concrete need" stance (already the explicit rationale
for `computeDeviceHealth` computing everything on the fly today).

**Relational, not opaque JSON blobs.** An earlier draft of this spec stored `topContributors`/
`recommendations` as `Json` columns — too limited for what Success Metrics (below) actually needs:
answering "which symptoms most often drive `chronic_overwatering` across every device," "how often
does `TRIGGER_WATERING` get recommended but not confirmed," or any other cross-device aggregate
requires filtering/joining/grouping on contributor and recommendation rows — a query SQLite/Prisma
can express directly against real columns, and cannot express (or can only express by loading every
row into application code and parsing JSON by hand) against an opaque blob column. The queryable
data stays relational; `Json` is reserved for genuinely unstructured debug material only.

```prisma
model DiagnosisEvent {
  id              Int       @id @default(autoincrement())
  deviceId        String
  device          Device    @relation(fields: [deviceId], references: [id])
  diagnosisId     String
  tier            String
  severity        Float
  confidence      Float
  coverageRatio   Float
  firstSeenAt     DateTime
  lastSeenAt      DateTime
  resolvedAt      DateTime?
  debugSnapshot   Json?     // optional, unstructured — a future archived EvidenceBreakdown or ad hoc debug capture, never queried on

  contributors    DiagnosisEventContributor[]
  recommendations DiagnosisEventRecommendation[]

  @@index([deviceId, diagnosisId, resolvedAt])
}

model DiagnosisEventContributor {
  id           Int            @id @default(autoincrement())
  eventId      Int
  event        DiagnosisEvent @relation(fields: [eventId], references: [id])
  symptomId    String
  contribution Float

  @@index([symptomId])
}

model DiagnosisEventRecommendation {
  id         Int            @id @default(autoincrement())
  eventId    Int
  event      DiagnosisEvent @relation(fields: [eventId], references: [id])
  action     String
  confidence Float

  @@index([action])
}
```

Written by an orchestration step (not the pure engine) piggybacking on the existing ~5min scheduler
tick: upsert the open (`resolvedAt: null`) row for a still-active diagnosis (replacing its
`contributors`/`recommendations` child rows with the current set), create one for a newly appearing
diagnosis, set `resolvedAt = now` on any open row whose diagnosis no longer appears in the current
result. No retention/pruning policy decided here — consistent with the open, deferred stance
already taken for `SyncEvent`/`RawSensorLog`.

This table set is scoped as a **later increment** of the rollout — nothing in the engine itself,
nor its testing, depends on it existing. It becomes load-bearing once Success Metrics (below) is
implemented, not before.

## Success metrics

"The new engine is better" needs an objective answer, not an impression. Four categories, each tied
to data this spec already produces:

**Safety metrics** — computed from `WateringEvent` (existing) and `DiagnosisEventRecommendation`
(above): count of `TRIGGER_WATERING` recommendations, count of physical triggers that actually
executed, count of recommendations rejected by the Execution-layer safety gate (cooldown/window/
tank — a *conflict*, not a failure: the two-authority design in "Recommendation vs. Execution"
working as intended). **Honestly scoped**: an automatic "false trigger" rate (the engine
recommended watering and the plant didn't actually need it) has no ground truth to check against —
the same limitation that rejected ML in Alternatives Considered applies here too. What's
automatically measurable is *disagreement with the system's own safety gate*; whether a trigger was
horticulturally *correct* depends on the User Metrics feedback below, when it exists.

**Detection metrics** — computed during Phase B shadow mode: for each real divergence, the time
delta between when the new engine's diagnosis crosses into `secondary`/`dominant` tier and when the
legacy status would have flagged `warning` for the same underlying condition (if it ever would
have) — "detected N hours earlier" is a concrete, checkable number, not a claim.

**User metrics** — diagnoses ignored vs. confirmed by the user, corrections the user makes.
**Dependency, stated explicitly rather than assumed**: this requires a feedback affordance (e.g.
confirm/dismiss a diagnosis card) that does not exist anywhere in the app today. Until it's built,
this metrics category is aspirational, not populated — and it's the same missing piece the
Calibration Layer's `manual_feedback` source depends on. Building that affordance is out of this
spec's scope (see V1 Scope below); this category stays at zero until a later increment adds it.

**Migration metrics** (Phase B, shadow mode) — divergence rate between legacy and new (fraction of
evaluations where they disagree), divergence type (breakdown by which Fact/Symptom's
`migrationNote` explains it, per Phase B's existing diff logging), and expected impact
(would the divergence have changed a watering trigger, or only a displayed badge). **Shadow mode is
never considered finished by elapsed time alone — it ends when these numbers are reviewed and
judged acceptable**, not on a fixed calendar duration. This sharpens Phase B/D below, which
otherwise only said "a duration DestCom decides."

## V1 scope — one complete vertical slice, not a platform

Everything above describes the architecture in full because the architecture needs to be right for
years, per DestCom's stated goal — but the first *implementation* should not attempt to populate it
broadly. Explicitly **not** in V1:

- Dozens of Diagnoses/Symptoms/Facts covering every plausible plant problem.
- The rule DSL (Alternatives Considered — deferred, not needed to prove the architecture).
- Any LLM narration (Roadmap — Lot 2).
- Any ML/automatic `historical_observation` calibration derivation (Calibration Layer — the
  contract ships, the derivation logic doesn't).
- A full analytics dashboard over Success Metrics/`DiagnosisEvent` — the tables and queries this
  spec defines are what a future dashboard would read, not a dashboard itself.

**The first objective is exactly one complete vertical slice, end to end**: Indicators (soil
moisture rolling average, temperature, drying rate, watering interval/history) → Facts
(`soil_moisture_below_profile_min`, `drying_rate_unusually_fast`,
`watering_interval_unusually_long`, ...) → Symptom (`water_stress`) →
Diagnosis (`chronic_underwatering`) → Recommendation
(`TRIGGER_WATERING`) — the exact example threaded through every section of this spec, chosen
because it's also the one the safety-critical scheduler migration (Phase D) needs anyway. Every
mechanism (evidence combination, coverage, tiering, calibration, caching, DTO boundary,
explanation tokens) gets proven against this one slice before a second Diagnosis is even started.
Extension to more Diagnoses/Symptoms/sensors is explicitly progressive, one at a time, after this
slice is live and validated — not a batch of many built in parallel.

## Migration plan — zero regression on 7 existing consumers

Callers today: `scheduler.ts` (auto-watering, safety-critical), `api/trpc/routers/health.ts`,
`mqtt/discovery.ts`, `mqtt/publisher.ts`, `frontend/src/lib/types.ts`, `frontend/src/lib/format.ts`.

**Phase A — Build in isolation.** New `backend/src/inference/` module: types, `combineWeightedEvidence`/
`combineNoisyOr`/`computeCoverage`, `InferenceEngine`, `resolveReferenceProfile`, `validateRegistry`,
and exactly the one vertical slice defined in V1 Scope above (`chronic_underwatering` end to end) —
nothing broader. Unit tests per layer, pure, no DB — matching the existing style already used for
e.g. `computeDailyTotals`. Nothing in the app calls this yet; zero production risk.

**Phase B — Shadow mode.** A `toLegacyDeviceHealth(inferenceResult): DeviceHealth` adapter maps the
new result onto today's shape. Orchestration calls **both** engines on every
`health.deviceHealth` request; the old path stays sole authority, the new path only logs a
structured comparison when they disagree:

```json
{
  "legacy": { "health": "warning" },
  "inference": { "diagnosis": "chronic_overwatering", "confidence": 0.78 },
  "mainDifferences": ["soil drying speed now considered", "temperature influence added"]
}
```

`mainDifferences` is generated from an optional static `migrationNote?: string` annotation any
Fact/Symptom can carry (e.g. `"prend en compte la vitesse de séchage, absente de l'ancien calcul"`)
— the shadow logger collects the notes of Facts/Symptoms that meaningfully contributed
(`contribution` above a small threshold) whenever the two engines disagree. Deliberately simple —
no natural-language-generation machinery for what is temporary migration tooling. Runs against real
production devices until the Migration metrics (Success Metrics above) are reviewed and judged
acceptable — not for a fixed calendar duration.

**Phase C — Migrate read-only consumers, lowest-risk first**: `health.deviceHealth` tRPC query +
frontend gauges, then MQTT `publisher`/`discovery`, then the MCP `get_plant_status` tool. Each swap
is independently observable and reversible.

**Phase D — The auto-watering scheduler, last, with a non-negotiable gate**: migration is accepted
only once Phase B's shadow log shows **zero disagreements** between the legacy
`soilMoisturePercent.status === 'too_low'` condition and the new `TRIGGER_WATERING` recommendation
over the observed period — not "close enough." Any broadening of the trigger condition beyond this
1:1 replacement (e.g. triggering on a `chronic_underwatering` diagnosis being merely dominant) is a
separate, explicitly-approved product decision, never a side effect of this migration. The
Recommendation-vs-Execution boundary above still applies in full — the scheduler independently
re-verifies cooldown/window/tank state, it does not trust the Recommendation's confidence alone.

**Phase E — Cleanup.** Delete `computeDeviceHealth`, `scoring.ts`'s legacy types, and the adapter
once all 7 consumers are migrated and shadow logging has zero remaining callers.

### Rollback strategy

A required feature flag, live from the moment Phase C migrates the first real consumer through the
end of Phase D, at two independent granularities:

- **Global kill switch — `INFERENCE_ENGINE_ENABLED`, an environment variable, not a DB-backed
  Setting.** This is a deliberate exception to this project's own established pattern of moving
  tunables *out* of env vars and into the DB-backed Settings page (poll interval, MQTT, Health
  Engine baseline/warm-up — see project history) — that pattern fits routine, low-stakes tuning
  well, but an incident kill switch must not depend on the DB/app being in a healthy, queryable
  state to begin with. An env var, read once at boot, reverts with a container restart
  (`docker-entrypoint.sh` already restarts routinely) independent of whatever state the inference
  engine or the database is in. When unset or `false`: every one of the 7 consumers behaves exactly
  as if Phase A had never shipped — the legacy `computeDeviceHealth` path only, zero calls into
  `backend/src/inference/`.
- **Per-device override — a DB-backed `Device.inferenceEngineEnabled` boolean, default `true`.**
  This one *is* a routine tuning knob (not an incident switch), so it follows the project's normal
  per-device-configuration pattern (`Schedule`, `environment`, `location`) — lets one specific
  device fall back to legacy scoring while the global flag stays on for the rest of the fleet, e.g.
  while investigating a diagnosis that looks wrong for that device specifically.

**Remediation loop**, triggered by a concerning Migration or Safety metric (Success Metrics above):

1. Disable inference for the affected scope — that one device (`Device.inferenceEngineEnabled =
   false`) if isolated, or globally (`INFERENCE_ENGINE_ENABLED=false`) if systemic.
2. Identify the responsible rule(s) using the divergence's already-logged `migrationNote` trail
   (Phase B) or the `DiagnosisEventContributor` rows (Persistence above).
3. Fix it: a parameter issue goes through the Calibration Layer (a new `RuleCalibration` row,
   versioned, no deploy needed); a logic issue needs an actual rule code change and a deploy.
4. Re-enable in shadow mode only (inference computed and logged, not yet trusted) — never straight
   back to production trust.
5. Re-verify against Success Metrics before flipping the flag back on for real.

## Alternatives considered

**A full declarative DSL from day one** — deferred, not rejected. Designing a real rule language
(grammar, validation, schema versioning, a way to express sigmoids/weighted sums declaratively) is
a substantial project on its own, disproportionate for a single-maintainer OSS project with no
external contributors today, and it removes TypeScript's type-checking exactly where correctness
matters most. The chosen architecture (typed interfaces + registry) is explicitly designed so a DSL
can be added later as one more implementation of the same interfaces (see "The DSL escape hatch"
above) — this is sequencing, not rejection.

**An external rule engine (Drools, json-rules-engine, nools, ...)** — rejected. Drools is Java,
outside this project's non-negotiable TS-only stack. JS/TS rule engines are built around generic
condition/action matching, not the severity/confidence/coverage/noisy-OR semantics this engine
needs — using one would mean fighting its abstractions to bolt on custom math anyway, while adding
a dependency and its own execution model (often RETE-style) as an extra layer of "why did this
fire" to explain — working against the explainability principle rather than for it.

**A formal Bayesian network** — rejected as a full framework; its most useful idea is already
adopted directly. A real Bayesian network needs conditional probability tables, which would need
either real training data (none exists) or hand-guessed priors — relocating the same subjectivity
problem into a heavier, harder-to-explain formalism. `combineNoisyOr` is itself the standard
approximation Bayesian tooling uses when full CPTs aren't available — the useful part of this
approach is already in the design, without the formal machinery/tooling cost.

**Machine learning trained on device history** — rejected for the reasoning core, with one narrow,
already-designed-for exception. No labeled ground truth exists or could reasonably be produced
(nobody has ever recorded "this plant was actually stressed on this date" for any device); it would
break determinism and explainability outright (a non-negotiable requirement); and the available
data volume (a handful of devices, months of history) is insufficient for any model to outperform
hand-authored domain rules. The one accepted role, formalized as the **Calibration Layer** above
(`RuleCalibration`): adjusting a rule's *parameters* (weight, threshold, confidence), never
replacing its logic, never deciding a diagnosis, never triggering a physical action by itself. Not
acceptable at any point: an opaque model deciding "the plant lacks water," replacing a
`DiagnosisRule`'s code, or an automatic watering decision based solely on a model's output. The
primary reasoning path must always stay inspectable. Not to be confused with `PlantState` (see
Roadmap) — a statistical behavioral memory, not a trained model either.

**An LLM as the decision-making engine** — rejected categorically, per the non-negotiable
requirement stated at the outset of this design process. Non-deterministic, not reliably unit
testable, silently version/vendor-dependent (conflicts with this project's explicit refusal to
lock into any AI provider), and a hallucination here has a real physical consequence (a wrong
watering trigger), unlike a chatbot mistake. Confirmed role: narration only, over already-decided
structured output (see Narrative above).

## Known limitations of this V1 — stated honestly

1. **No machine learning in the reasoning core.** Every weight/threshold across every rule starts
   hand-chosen, not statistically optimized — the Calibration Layer (above) lets those specific
   parameters be adjusted post-launch without touching rule code, but V1 populates it manually
   (`manual_feedback`/`operator_adjustment`), not from an automatic statistical process. Displayed
   confidence reflects the rule model's conviction, not a statistically validated probability.
2. **Total dependence on `ReferenceProfile` quality.** An error or gap in the underlying species
   data (WatchFlower CSV today — the `0;0` = "not filled in, not literally zero" trap already
   handled is illustrative of the class of fragility here) propagates directly into every
   downstream Fact/Symptom/Diagnosis that depends on it. The engine has no way to detect that a
   reference range is itself wrong.
3. **Ongoing empirical calibration required.** As already experienced twice on this project (soil
   conductivity's WatchFlower formula invalid on real hardware, luminosity being instantaneous
   rather than a true daily total), expect several of this engine's constants (weights, tier
   thresholds, Fact thresholds) to prove miscalibrated once confronted with real production data.
   The Calibration Layer gives this a tracked, versioned home (a `RuleCalibration` row) instead of
   an untracked source edit — but someone still has to notice the miscalibration and decide the new
   value; V1 does not detect or propose corrections automatically. This is inherent to a rule-based
   system with no training data, not a design failure.
4. **Cannot diagnose beyond available sensors.** No current StroyPlant sensor can reveal fungal
   disease, pests, or a specific nutrient deficiency. The engine can at best say "substrate
   waterlogged for a prolonged period, rot risk" (a moisture-derived Fact/Symptom), never confirm
   actual rot.
5. **Reasons per device, not across a population.** No V1 support for "your 3 Monstera behave
   differently, this one is anomalous relative to the others" — a possible future extension, out of
   scope here.

## Roadmap V2/V3

- **`PlantState`** — space reserved in `InferenceContext` from the start of this design
  (`plantState?: PlantState | null`; `type PlantState = unknown` for V1, a genuine no-op). **Not a
  predictive model** — a local behavioral memory: "this plant usually dries out in 4 days, consumes
  ~8% moisture/day, slows down in winter, reacts poorly to closely-spaced waterings." Shifts the
  comparison from "does this plant match its species' theoretical profile?" to "is this plant
  behaving normally *relative to itself*?" — a natural extension of the personal-baseline concept
  already present in today's Health Engine.
- **`historical_observation`-sourced calibration** — a statistical routine (percentile-based, in the
  same spirit as `soilConductivityCalibration.ts`, never a trained model) that observes a device's
  own history and *proposes* `RuleCalibration` rows automatically, rather than requiring a person to
  notice and adjust manually. The storage/application contract ships in V1; this derivation logic is
  the deferred part.
- **Per-plant statistical personalization** — progressively refining weights/thresholds per device
  from its own history, carried by `PlantState` and the Calibration Layer together, still not a
  trained model in the ML sense.
- **Probabilistic refinement** — if `combineNoisyOr` shows real limits in production, migrating to
  richer CPTs is possible without touching Facts/Symptoms/Diagnosis, since the combination
  functions are already isolated behind a stable interface.
- **New sensors** (Batch 10 — Flower Power, Flower Care, beyond) — purely additive, per the
  Extensibility section above.
- **A rule DSL** — if community contributions of profiles/rules materialize, `DiagnosisRule`/
  `SymptomRule`/`FactDefinition` already support a declarative interpreter with no engine rewrite.
- **Optional LLM narration (Lot 2)** — richer phrasing generated from `EvidenceBreakdown`,
  user-configured provider, never a decision-making role.

## Open questions left to the implementation plan

Resolved by this revision, kept here only as a pointer to where: first-shipped scope (V1 Scope
above) and the Phase B shadow-mode "how long" question (Success Metrics above — ends on reviewed
numbers, not a calendar duration). Genuinely still open:

- Exact `DOMINANT_IMPORTANCE_THRESHOLD`/`WEAK_HYPOTHESIS_IMPORTANCE_THRESHOLD` starting values
  (placeholder values given above, explicitly flagged for empirical recalibration).
- Exact timing of `DiagnosisEvent`/`RuleCalibration` persistence relative to the V1 slice — both are
  scoped as "a later increment," but whether that increment lands alongside the first Diagnosis or
  strictly after depends on how soon Success Metrics needs real data to report on.
- `IndicatorSnapshot` cache refresh strategy — lazy (TTL expiry on read) vs. proactive (recomputed
  every scheduler tick) — both satisfy the architecture, the choice is a performance/simplicity
  trade-off for the implementation plan, not fixed here.
- When the User Metrics feedback affordance (confirm/dismiss a diagnosis) gets built — Success
  Metrics above depends on it but this spec does not schedule it.
- Exact location/form of the CI import-scan script (species-blindness enforcement above) within the
  existing `.github/workflows/` setup.
