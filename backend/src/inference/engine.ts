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
  RecommendationResult,
  RecommendationRule,
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
      byAction.set(candidate.action, {
        action: candidate.action,
        urgency: candidate.urgency,
        confidence: candidate.confidence,
        triggeredBy: [candidate.triggeredBy],
        importance,
      });
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
      if (!diagnosisIds.has(diagnosisId))
        errors.push(`Recommendation "${recommendation.id}" triggers on unknown diagnosis "${diagnosisId}"`);
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
    validateRegistry({
      indicators: indicatorDefs,
      facts: factDefs,
      symptoms: symptomRules,
      diagnoses: diagnosisRules,
      recommendations: recommendationRules,
    });
  }

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
    const diagnoses = computeDiagnoses(this.diagnosisRules, { ...ctx, symptoms });
    const candidates = computeRecommendationCandidates(this.recommendationRules, diagnoses, {
      ...ctx,
      operationalConstraints: operational,
    });
    const recommendations = reconcileRecommendations(candidates, diagnoses);
    return { indicators, facts, symptoms, diagnoses, recommendations };
  }
}
