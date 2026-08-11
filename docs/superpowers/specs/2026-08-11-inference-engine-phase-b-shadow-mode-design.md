# Horticultural inference engine — Phase B, shadow mode

Date: 2026-08-11
Status: approved by DestCom, ready for implementation planning.

## Purpose

The horticultural inference engine's V1 vertical slice (`chronic_underwatering` →
`TRIGGER_WATERING`, Phase A) merged to `main` on 2026-08-10, followed by a hardening pass
(clock injection, staleness bound, timezone-aware bucketing, `AvailabilityReason` threading) on
2026-08-11. Nothing consumes `inferenceEngine` yet — `backend/src/health/` (the legacy
`computeDeviceHealth`) remains the sole code path the app actually reads or acts on.

This spec covers Phase B of the RFC's 5-phase Migration Plan
(`docs/superpowers/specs/2026-08-07-horticultural-inference-engine-design.md`, "Migration plan"
section): **shadow mode**. The new engine runs alongside the legacy one on real devices, its
result is compared to the legacy result, and every disagreement is logged — but the legacy engine
stays the sole decision-maker for everything user-visible and everything that can trigger a real
watering. Nothing about auto-watering, the dashboard, MQTT, or the MCP server changes in this
phase. The purpose is purely to accumulate real-world evidence (the RFC's "Migration metrics")
before Phase C (migrating real, read-only consumers) is even considered.

## Non-negotiable constraints (inherited from the RFC and the Phase A hardening pass)

- `backend/src/inference/` stays pure: no Prisma queries, no I/O, no dependency on any other part
  of the app except `PlantProfile` via `referenceProfile.ts`. None of this phase's new code lives
  inside that directory — it is fundamentally impure (reads the DB, calls the legacy engine,
  writes a new table).
- The legacy engine (`computeDeviceHealth`) remains the sole authority for `DeviceHealth.status`
  and the sole input to the auto-watering trigger (`scheduler.ts`'s `soilMoisturePercent.status
  === 'too_low'` check). The new engine's result is never read by anything except this shadow
  comparison.
- A failure anywhere in the new engine's shadow evaluation (assembly, `inferenceEngine.run()`,
  the adapter, the DB write) must never affect the legacy path — no shared try/catch, no shared
  early-return, no exception ever propagates into `evaluateDevice`'s watering-trigger logic.

## Deliberate deviation from the RFC's literal text

The RFC's Phase B text triggers the shadow comparison "on every `health.deviceHealth` request"
(the tRPC query, i.e. only when the frontend is open). DestCom confirmed a different trigger:
**the scheduler's existing ~5-minute tick** instead, for regular, UI-independent coverage —
needed to make the RFC's own "Detection metrics" (time delta between when the new engine's
diagnosis crosses into `secondary`/`dominant` and when the legacy status would have flagged
`warning`) meaningful. A query-driven trigger would only produce data whenever someone happens to
open the dashboard, which is far too sparse to compute a "detected N hours earlier" number
honestly. This is the only deviation from the RFC's Phase B text; everything else (the
`toLegacyDeviceHealth` adapter, `migrationNote`, "log only on disagreement") matches as specified.

## Architecture

A new module, `backend/src/health/inferenceShadow.ts`, is the only file that imports both engines
(`computeDeviceHealth` from `./scoring.js` and `inferenceEngine` from
`../inference/registry.js`) — the orchestration layer the RFC describes, symmetric to
`inference/referenceProfile.ts` being the sole sanctioned crossing point for `PlantProfile`.

It exports one function:

```ts
export async function evaluateShadow(
  device: Device & { plantProfile: PlantProfile | null; schedule: Schedule | null },
  healthSettings: HealthSettings,
): Promise<void>
```

Called from `scheduler.ts`'s `tick()` loop, once per device already in that loop's existing query
result (`kind: 'PARROT_POT', plantProfileId: { not: null }` — see "Scope: Parrot Pot only" below),
**as an independent step alongside `evaluateDevice(...)`, never nested inside it**:

```ts
for (const device of devices) {
  try {
    await evaluateDevice(device, provider, connectionQueue);
  } catch (error) {
    log({ /* existing */ });
  }
  if (healthSettings.shadowModeEnabled) {
    try {
      await evaluateShadow(device, healthSettings);
    } catch (error) {
      log({ direction: 'INFO', label: 'Shadow evaluation failed for device', deviceId: device.id, result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
    }
  }
}
```

`evaluateShadow` deliberately re-fetches its own `readings` and calls `computeDeviceHealth()` a
second time, rather than threading `evaluateDevice`'s internal state out to the caller.
`evaluateDevice`'s early returns (schedule inactive, outside allowed hours, cooldown active) exit
*before* computing `health`, and refactoring it to expose that state on every path would touch
the safety-critical watering-trigger function for a side concern — not worth the risk for a
handful of devices evaluated once every 5 minutes. Isolation over micro-optimization.

`healthSettings` is fetched once per tick by the caller (`tick()` already needs it for other
reasons) and passed in, rather than re-fetched inside `evaluateShadow` — the one piece of caller
state genuinely worth sharing, since it costs nothing to pass and every device in the same tick
sees the same settings anyway.

## Scope: Parrot Pot only, this phase

`tick()`'s existing device query already filters to `kind: 'PARROT_POT', plantProfileId: { not:
null }` — Xiaomi devices have no pump and were never in this loop. This happens to also be
correct for shadow mode specifically: the only Diagnosis that exists (`chronic_underwatering`)
consumes `soilMoistureRollingAvg1h`, a field Xiaomi devices don't report at all
(`requiredFields: ['soilMoisturePercent']`, gated out by `EnvironmentContext.capabilities` per the
Extensibility rule). `evaluateShadow` reuses this same device set — no new query, no Xiaomi-shaped
gap to explain.

## Components

### `toLegacyDeviceHealth(inferenceResult: InferenceResult): Pick<DeviceHealth, 'status'>`

The RFC's migration adapter, scoped down to the one field the comparison actually needs
(`DeviceHealth.status`) rather than the full shape — nothing else in `DeviceHealth`
(`parameters`, `trend`, `warningParameters`, `luminosityRecentDaysTooLow`) has any equivalent on
the inference side to map from, and the RFC itself only ever compares `status` in its Phase B
example JSON. Mapping rule:

- `inferenceResult.diagnoses` contains any finding with `tier === 'dominant'` or `tier ===
  'secondary'` → `'warning'`.
- Otherwise → `'ok'`.

`'warming_up'` and `'no_profile'` are never produced by this mapping — they come from the legacy
side only (see "Gating" below, which skips the comparison entirely while legacy itself reports
`'warming_up'`, since neither engine's status is meaningful yet in that state).

### Input assembly

Built fresh inside `evaluateShadow`, reusing existing helpers wherever one already exists — no
new business logic beyond wiring:

- `DeviceObservations`: `{ readings, wateringEvents }` — `readings` fetched the same way
  `evaluateDevice` does (`baselineWindowDays`-bounded, `source: 'POLL'`), `wateringEvents` fetched
  unbounded by `deviceId` (matches what `wateringIntervalDeviationSigma` needs — its own baseline
  window is a count of intervals, not a calendar bound).
- `EnvironmentContext`: `{ deviceKind: device.kind, environment: device.environment, capabilities:
  ['soilMoisture', 'temperature', 'luminosity', 'conductivity'], observationsAvailability: {},
  timezone: healthSettings.timezone }` — capabilities hardcoded to the Parrot Pot's fixed set
  (this phase never runs for Xiaomi, see Scope above); `observationsAvailability` left as `{}`,
  unused by anything today (`types.ts`'s own field, never read — see the Phase A hardening spec's
  Fix 4, which deliberately scoped `AvailabilityReason` to the Indicator level only).
- `ReferenceProfile`: `resolveReferenceProfile(device.plantProfile, device.environment)` — the
  existing function, unmodified, already the sole sanctioned `PlantProfile` crossing point.
- `OperationalConstraints`: `{ autoWateringEnabled: effective.active, withinAllowedWindow:
  isWithinAllowedWindow(new Date().getHours(), effective.allowedStartHour,
  effective.allowedEndHour), cooldownActive }`, where `effective =
  resolveEffectiveSchedule(device, device.schedule)` (already exported) and `cooldownActive` is
  computed the same way `evaluateDevice` does (`lastWatering` lookup against
  `effective.cooldownHours`). `isWithinAllowedWindow` needs to be exported from `scheduler.ts` (a
  one-line change, no behavior change) — it exists but is currently module-private.
- `now`: `new Date()` — real time, the Phase A hardening pass's clock-injection parameter used at
  its sanctioned default.

Unlike `evaluateDevice`, `evaluateShadow` computes these **unconditionally** — it does not honor
the schedule-active/allowed-window/cooldown early-returns `evaluateDevice` uses to decide whether
to *act*. Shadow mode's purpose is to see what the new engine would have said at every tick,
including moments where the legacy engine wouldn't have been allowed to water anyway — cooldown
and window state are still passed through as `OperationalConstraints` (so the new engine's
Recommendation confidence reflects them, per the Recommendation-vs-Execution design), but they
never skip the comparison itself.

### `migrationNote`

`types.ts`'s `FactDefinition` and `SymptomRule` interfaces each gain one new optional field:

```ts
export interface FactDefinition {
  id: FactId;
  needsProfile: boolean;
  requiredIndicators: IndicatorId[];
  migrationNote?: string;
  evaluate(indicators: IndicatorIndex, profile: ReferenceProfile | null): FactResult | null;
}

export interface SymptomRule {
  id: SymptomId;
  requiredFacts?: FactId[];
  consumes: { facts: FactId[]; indicators: IndicatorId[] };
  migrationNote?: string;
  evaluate(ctx: InferenceContext): SymptomResult | null;
}
```

Set on the 3 existing Facts and the 1 existing Symptom (French, matching this project's UI
language convention):

- `soil_moisture_below_profile_min`: no note (this one has a direct legacy equivalent —
  `soilMoisturePercent.status === 'too_low'` — so it never explains a real divergence on its own).
- `drying_rate_unusually_fast`: `"Prend en compte la vitesse de séchage du sol, absente du calcul historique."`
- `watering_interval_unusually_long`: `"Prend en compte l'intervalle entre arrosages, absent du calcul historique."`
- `water_stress` (Symptom): `"Combine humidité du sol, température et régularité d'arrosage en un seul score, au lieu d'un seuil unique."`

### Collecting `mainDifferences`

Only computed when a divergence is actually found (mapped legacy status differs from real legacy
status). Walks `inferenceResult.diagnoses` (today only one `DiagnosisRule`,
`chronic_underwatering`, is registered, so this array has at most one element — if the registry
grows, the same walk applies to every diagnosis at `dominant` or `secondary` tier, not just one)
and, for each, its `severityBreakdown.items` — an `EvidenceContribution[]`, already computed by
the engine — filtering to items whose `contribution` exceeds a small threshold (`0.05`, matching
this codebase's existing `MINIMUM_REPORTABLE_IMPORTANCE`-style initial-estimate convention), then
looking up each contributing item's `source` (a `{ kind: 'fact' | 'symptom' | ..., id }`) against
the registered Fact/Symptom definitions' `migrationNote`. Only `fact` and `symptom` sourced items
are considered (an `indicator`-sourced item has no `migrationNote` slot). Deduplicated, `null`
notes dropped, collected into a `string[]`.

### `ShadowDivergence` (new Prisma model)

```prisma
model ShadowDivergence {
  id                   Int      @id @default(autoincrement())
  deviceId             String
  device               Device   @relation(fields: [deviceId], references: [id])
  timestamp            DateTime @default(now())
  legacyStatus         String
  inferenceDiagnosisId String?
  inferenceTier        String?
  inferenceSeverity    Float?
  inferenceConfidence  Float?
  recommendationAction String?
  mainDifferences      Json

  @@index([deviceId, timestamp])
}
```

Deliberately lighter than the RFC's `DiagnosisEvent`/`DiagnosisEventContributor`/
`DiagnosisEventRecommendation` 3-table design — that schema exists for aggregate, queryable
Success Metrics ("which symptoms most often drive X across every device") which the RFC itself
scopes as "a later increment... becomes load-bearing once Success Metrics is implemented, not
before." This table exists only so DestCom can review divergences over days/weeks without
depending on `docker logs` retention — one row per divergence, `mainDifferences` as a `Json`
array of strings (not normalized into child rows) since nothing here needs cross-device
aggregate SQL yet. No retention/pruning policy — same open-ended stance as `SyncEvent`/
`RawSensorLog`.

`inferenceDiagnosisId`/`inferenceTier`/`inferenceSeverity`/`inferenceConfidence`/
`recommendationAction` are all nullable — the new engine can legitimately produce zero diagnoses
(a genuine divergence: legacy says `'warning'`, new engine says nothing at all, or vice versa).

### `HealthSettings.shadowModeEnabled`

```prisma
model HealthSettings {
  id                 Int      @id @default(1)
  baselineWindowDays Int      @default(14)
  warmupMinDays      Int      @default(3)
  timezone           String   @default("UTC")
  shadowModeEnabled  Boolean  @default(false)
  updatedAt          DateTime @updatedAt
}
```

Default `false` — DestCom enables it deliberately from `/settings` after this deploys, rather
than the new (never-run-continuously-before) engine silently starting to execute on every tick
the moment this ships. Same "Moteur de santé" settings card (`HealthEngineSettingsSection`,
`health.getSettings`/`upsertSettings`) gains one toggle; no new tRPC procedures needed.

### Gating (when `evaluateShadow` does nothing at all — not even a "no divergence" no-op)

- `healthSettings.shadowModeEnabled === false` — checked by the caller (`tick()`), `evaluateShadow`
  is never even called.
- The legacy `computeDeviceHealth(...)` result has `status === 'warming_up'` — neither engine's
  status is meaningful yet; comparing here would produce a mechanical, meaningless divergence
  every single time until the baseline window fills, drowning out real signal.

(`plantProfileId == null` is already excluded by `tick()`'s device query — never reaches
`evaluateShadow` at all.)

## Error handling

A thrown error anywhere inside `evaluateShadow` (assembly, `inferenceEngine.run()`, the adapter,
the `prisma.shadowDivergence.create()` call) is caught by the caller's own try/catch (shown in
Architecture above) and logged via the existing structured logger
(`direction: 'INFO', result: 'ERROR'`) — same shape as the pre-existing per-device catch around
`evaluateDevice`, but a **separate** try/catch, so a shadow-evaluation failure can never suppress
(or be suppressed by) the real watering-decision path for the same device on the same tick.

## Testing

Same `node:test` + mock-provider convention as the rest of this codebase. Two integration-style
tests against `evaluateShadow` (or the pure comparison/mapping helpers it composes, tested in
isolation where possible — `toLegacyDeviceHealth` and the `mainDifferences` collector are pure
functions and get direct unit tests):

- A history where both engines agree (a genuinely healthy watering pattern, no diagnosis, legacy
  `'ok'`) → no `ShadowDivergence` row written.
- A history where they disagree (an underwatered pattern the new engine catches as
  `chronic_underwatering` while the legacy engine hasn't crossed its own `too_low` threshold, or
  vice versa) → exactly one `ShadowDivergence` row, with the correct `legacyStatus`,
  `inferenceDiagnosisId`/`tier`/`severity`/`confidence`, and a `mainDifferences` array containing
  the expected `migrationNote` text(s).
- `toLegacyDeviceHealth`: unit tests for empty diagnoses → `'ok'`, a `weak_hypothesis`-only
  diagnosis → `'ok'` (weak hypotheses don't count as a real disagreement), a `dominant`/
  `secondary` diagnosis → `'warning'`.
- The `warming_up` gate and the `shadowModeEnabled` gate: each produces zero DB writes and zero
  calls into `inferenceEngine.run()` (spy/count, not just "no row written" — proving the gate
  short-circuits before doing any work, not just before persisting).
- `evaluateShadow` throwing (e.g. a deliberately broken mock observation) is caught by the
  caller's try/catch and does not propagate — tested at the `tick()`/caller level, confirming
  `evaluateDevice` for a *different* device in the same tick still runs to completion.

## Explicitly not in scope for this phase

- Nothing in `Facts`/`Symptoms`/`Diagnoses`/`Recommendations` rule *logic* changes — only the new
  optional `migrationNote` field is added, no rule's `evaluate()` body changes.
- No change to `scheduler.ts`'s actual watering-trigger logic, `evaluateDevice`, or anything the
  legacy engine already decides — this phase is strictly additive and read-only with respect to
  the real system.
- No `health.deviceHealth` tRPC change, no frontend change, no MQTT/MCP change — those are Phase C.
- No `DiagnosisEvent`/`DiagnosisEventContributor`/`DiagnosisEventRecommendation` tables (the RFC's
  full Success Metrics schema) — `ShadowDivergence` is a deliberately smaller, temporary table
  scoped to this phase's actual need (manual review over time), not the aggregate-queryable
  schema a future dashboard would need.
- No feature flag beyond `HealthSettings.shadowModeEnabled` — the RFC's `INFERENCE_ENGINE_ENABLED`
  env var and `Device.inferenceEngineEnabled` per-device override are Phase C/D concerns (they
  gate a system that's actually making decisions; shadow mode never does).
- No UI to browse `ShadowDivergence` rows — reviewed directly via Prisma Studio or a SQL query on
  the production server for now, matching how `SyncEvent` was reviewed before the History page
  existed. A dedicated view is a later increment if manual review proves too slow.
