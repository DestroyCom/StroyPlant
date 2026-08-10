# Inference engine — Phase A hardening (pre-Phase-C checklist)

Date: 2026-08-10
Status: approved by DestCom, ready for implementation planning.

## Purpose

The horticultural inference engine's V1 vertical slice (`chronic_underwatering` →
`TRIGGER_WATERING`) merged to `main` on 2026-08-10 — see
`docs/superpowers/specs/2026-08-07-horticultural-inference-engine-design.md` (RFC) and
`docs/superpowers/plans/2026-08-07-horticultural-inference-engine-v1-slice.md` (18-task
implementation plan). The final whole-branch review deferred 4 findings as a documented checklist
(comment atop `backend/src/inference/registry.ts`), all sharing one root cause — the engine's
boundary with real-world time and data availability was left thin because nothing consumed it yet
— and all judged zero-risk while the module stays unwired. DestCom has now asked for all 4 to be
fixed before any further work, rather than carried forward into Phase C wiring. This spec covers
exactly those 4 fixes. It does not touch anything outside `backend/src/inference/` and does not
wire any real consumer (tRPC/MQTT/MCP/scheduler) — that remains Phase C, unstarted.

## Non-negotiable constraints (inherited from the RFC, restated since this work touches them directly)

- Every file under `backend/src/inference/` stays a pure function: no Prisma queries, no I/O, no
  wall-clock reads baked in as a side effect.
- `backend/src/inference/` never imports `PlantProfile` except `referenceProfile.ts` (unaffected by
  this spec, restated for completeness — the species-blindness CI check must still pass unchanged).
- Every default must preserve today's exact observed behavior when the new parameters are omitted —
  this is a hardening pass, not a behavior change for existing callers (there are none yet besides
  the test suite, but the principle matters for the eventual Phase C caller too).

## Fix 1 — Clock injection

**Problem**: all 4 Indicators call `Date.now()`/`new Date()` directly, making the pipeline
non-replayable against historical readings — undermining the RFC's own stated justification for
not persisting the full evidence tree ("always reproducible on demand ... since the pipeline is
pure and deterministic").

**Design**: thread an explicit `now: Date` parameter through the pipeline, defaulting to real time
at the outermost entry point so nothing changes for a caller that doesn't pass one.

- `types.ts`: `IndicatorDefinition.compute(observations: DeviceObservations, environment:
  EnvironmentContext, now: Date): IndicatorValue` — third parameter added.
- `engine.ts`: `InferenceEngine.run(observations, profile, environment, operational, now: Date =
  new Date())` — new optional parameter on the public entry point, threaded down into the internal
  `computeIndicators(indicatorDefs, observations, environment, now)` helper, which passes it to
  every `IndicatorDefinition.compute(...)` call.
- All 4 indicators (`soilMoistureRollingAvg1h.ts`, `temperatureRollingAvg1h.ts`,
  `dryingRateDeviationSigma.ts`, `wateringIntervalDeviationSigma.ts`) replace every
  `Date.now()`/`new Date()` call with the injected `now`/`now.getTime()`.
- Test benefit (not the goal, but a real side effect): every indicator test can now construct
  fixtures relative to a fixed reference `Date` instead of real wall-clock time, removing the
  timing-flakiness class of bug already found once in `registry.test.ts` (Task 16's original
  fix for a reading landing right at a window boundary).

## Fix 2 — Staleness bound on the rolling-average fallback (24h)

**Problem**: `soilMoistureRollingAvg1h`/`temperatureRollingAvg1h` fall back to the last 5 readings
(at reduced confidence 0.5) whenever nothing is within the last hour, with no bound on how old
those 5 readings can be. A device offline for months can still produce a confident-enough value
that reaches `TRIGGER_WATERING`.

**Design**: a new constant, `MAX_STALE_FALLBACK_AGE_MS = 24 * 3_600_000` (24 hours), in both
`soilMoistureRollingAvg1h.ts` and `temperatureRollingAvg1h.ts`, documented as an initial estimate
(same convention as this codebase's other threshold constants, e.g.
`MIN_STDDEV_PERCENT_PER_DAY`). The fallback path only returns a value if the most recent of the
last-5 fallback readings is within `MAX_STALE_FALLBACK_AGE_MS` of `now`; otherwise the indicator
returns `{ value: null, confidence: 0, unavailableReason: 'no_recent_data' }` (see Fix 4, the field
lives at the top level of `IndicatorValue`, not nested under `meta`) instead of a
falsely-confident stale value.

## Fix 3 — Timezone-aware day bucketing

**Problem**: `dryingRateDeviationSigma` buckets readings into calendar days using hardcoded UTC
(`toISOString().slice(0, 10)`), diverging from this codebase's own established convention
(`health/dailyLightIntegral.ts`'s `HealthSettings.timezone`) and creating a ~2h/day blind spot
right after UTC midnight where the "today" bucket can't span the minimum 2-hour window.

**Design**:

- `types.ts`: `EnvironmentContext` gains `timezone: string` (an IANA timezone name, e.g.
  `'Europe/Paris'`), defaulting to `'UTC'` wherever a test or future caller doesn't set it —
  behavior is unchanged from today whenever `timezone` is omitted or set to `'UTC'`.
- `dryingRateDeviationSigma.ts` replaces its `dayKey(date: Date): string` helper's body with a
  timezone-aware version taking a second `timezone: string` parameter:
  `new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day:
  '2-digit' }).format(date)` — the exact same `Intl.DateTimeFormat`/`en-CA`-locale technique
  already used by `health/dailyLightIntegral.ts`'s own `dayKey` helper. **Deliberately duplicated,
  not imported**: `backend/src/inference/` must never depend on `backend/src/health/` or any other
  part of the app outside itself, mirroring the same isolation principle that already governs the
  species-blindness boundary. The duplicated function is ~2 lines; this is not meaningful
  DRY-violation territory.
- `dryingRateDeviationSigma`'s `compute(observations, environment, now)` (Fix 1's new signature)
  passes `environment.timezone` into every `dayKey(...)` call, including the "today" boundary
  calculation.

## Fix 4 — `AvailabilityReason` threading (Indicator level)

**Problem**: `AvailabilityReason` (`'sensor_absent' | 'no_recent_data' | 'insufficient_history'`)
is declared in `types.ts` but never actually set by any adapter — `EvidenceBreakdown.missing`
always reports the hardcoded default, `'sensor_absent'`, regardless of the real reason.

**Design, scoped to the Indicator layer only** (per DestCom's explicit choice — not threaded
further through Facts/Symptoms/Diagnoses in this pass, since nothing downstream consumes
`evidenceBreakdown.missing` yet and the marginal value of going further right now is low relative
to the file/test churn it would add):

- `IndicatorValue` (`types.ts`) gains an optional field: `unavailableReason?: AvailabilityReason`.
  Only meaningful when `value === null`; every Indicator that can return `value: null` now also
  sets this field to the most specific reason it can determine:
  - `'insufficient_history'` — there is *some* data, but below the indicator's own minimum
    (`dryingRateDeviationSigma`: fewer than `MIN_BASELINE_DAYS` baseline days;
    `wateringIntervalDeviationSigma`: fewer than `MIN_BASELINE_INTERVALS` historical intervals).
  - `'no_recent_data'` — there is historical data, but nothing recent enough (the existing
    no-readings-within-window case for all 4 indicators, and Fix 2's new staleness-bound case for
    the two rolling-average indicators).
  - An Indicator with truly zero data of the relevant kind ever also reports `'no_recent_data'` —
    `'sensor_absent'` is reserved for the case where the *capability itself* is absent, which is
    already handled one layer up (`engine.ts`'s existing `FIELD_TO_CAPABILITY`-based gating skips
    calling `compute()` at all for an unsupported indicator — by the time an Indicator's `compute()`
    runs, its capability is already known to be present).
- `evidence.ts`'s `indicatorEvidence` adapter reads `indicator?.unavailableReason` when
  constructing an `EvidenceItem` for a null-valued or absent indicator, and sets
  `EvidenceItem.missingReason` from it — falling back to the current default (`'sensor_absent'`,
  applied by `evidence.ts`'s existing `missingFrom()` helper) only when the indicator was never
  computed at all (the capability-gated-out case, where `'sensor_absent'` is exactly correct).
- **Explicitly out of scope for this fix**: `FactResult`/`SymptomResult`/`DiagnosisFinding` are
  unchanged — a Fact/Symptom/Diagnosis that can't be evaluated still surfaces as simply absent from
  its snapshot Map, with no reason of its own. `factEvidence`/`symptomEvidence`/`diagnosisEvidence`
  adapters are unchanged and keep defaulting to `'sensor_absent'` for their own missing-item case.

## Scope

Files touched, all under `backend/src/inference/` except test files in the same tree:

- `types.ts` — `IndicatorDefinition.compute` signature, `EnvironmentContext.timezone`,
  `IndicatorValue.unavailableReason`.
- `engine.ts` — `InferenceEngine.run`'s new `now` parameter, `computeIndicators` threading it
  through.
- `indicators/soilMoistureRollingAvg1h.ts`, `indicators/temperatureRollingAvg1h.ts` — `now`
  injection, staleness bound (Fix 2), `unavailableReason`.
- `indicators/dryingRateDeviationSigma.ts` — `now` injection, timezone-aware `dayKey`,
  `unavailableReason`.
- `indicators/wateringIntervalDeviationSigma.ts` — `now` injection, `unavailableReason`.
- `evidence.ts` — `indicatorEvidence` adapter reading the new `unavailableReason` field.
- `registry.ts` — the 4-item checklist comment at the top is removed (all 4 resolved) and replaced
  with a single one-line comment recording the one deliberately-deferred residual: `AvailabilityReason`
  is threaded through Indicators only, not Facts/Symptoms/Diagnoses (Fix 4's explicit non-goal
  above) — a real, separate future item, worth keeping visible rather than silently dropping.
- Every existing test file under `backend/src/inference/indicators/*.test.ts`, `engine.test.ts`,
  and `registry.test.ts` — updated to pass explicit `now`/`environment.timezone` values instead of
  relying on real wall-clock time, and to cover the new staleness-bound and
  `unavailableReason`-setting behavior.

## Explicitly not in scope

- No consumer wiring (tRPC/MQTT/MCP/scheduler) — still Phase C, still not started.
- No change to `Facts`/`Symptoms`/`Diagnosis`/`Recommendations` layers beyond what Fix 4 requires
  in the adapters — the rule files themselves (`facts/*.ts`, `symptoms/*.ts`, `diagnoses/*.ts`,
  `recommendations/*.ts`) are untouched.
- No change to the species-blindness boundary or its CI enforcement.
- No new DB-backed settings, no `HealthSettings.timezone` read from the inference layer directly —
  `EnvironmentContext.timezone` is a plain string the engine receives, exactly like every other
  `EnvironmentContext` field; wiring it from the real `HealthSettings` row is a Phase C concern.

## Testing approach

Same TDD discipline as the original 18-task plan: each fix gets its own failing test before the
implementation, using Node's built-in `node:test` (already wired via `tsx`, no new dependency).
Key new test cases per fix:

- Fix 1: an indicator test asserting identical output for two calls with the same fixed `now`,
  proving determinism (a property the current `Date.now()`-based tests cannot express at all).
- Fix 2: a rolling-average indicator test with fallback readings older than 24h asserting
  `{ value: null, confidence: 0 }`, contrasted with a fallback within 24h still returning a value.
- Fix 3: a `dryingRateDeviationSigma` test with a `now` timestamp shortly after UTC midnight but
  well within a non-UTC `environment.timezone`'s calendar day, asserting the "today" bucket still
  computes correctly (the exact blind-spot case this fix closes) — plus a regression test
  confirming `timezone: 'UTC'` (or omitted) preserves the exact previous behavior.
- Fix 4: for each of the 4 indicators, a test asserting the correct `unavailableReason` value for
  each of its null-returning paths (insufficient history vs. no recent data), plus an
  `evidence.ts` test confirming `indicatorEvidence` propagates it into `EvidenceItem.missingReason`
  correctly.
