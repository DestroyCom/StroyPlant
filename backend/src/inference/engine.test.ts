import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyTiers, InferenceEngine, reconcileRecommendations, validateRegistry } from './engine.js';
import type {
  DiagnosisFinding,
  DiagnosisRule,
  EvidenceCoverage,
  FactDefinition,
  IndicatorDefinition,
  RecommendationResult,
  SymptomRule,
} from './types.js';

function coverage(ratio: number): EvidenceCoverage {
  return { availableWeight: ratio, totalWeight: 1, ratio };
}

describe('validateRegistry', () => {
  it('throws when a Fact requires an unregistered Indicator', () => {
    const fact: FactDefinition = { id: 'f1', needsProfile: false, requiredIndicators: ['missing_indicator'], evaluate: () => null };
    assert.throws(
      () => validateRegistry({ indicators: [], facts: [fact], symptoms: [], diagnoses: [], recommendations: [] }),
      /missing_indicator/,
    );
  });

  it('does not throw when every reference resolves', () => {
    const indicator: IndicatorDefinition = { id: 'i1', requiredFields: [], compute: () => ({ id: 'i1', value: 1, confidence: 1 }) };
    const fact: FactDefinition = { id: 'f1', needsProfile: false, requiredIndicators: ['i1'], evaluate: () => null };
    assert.doesNotThrow(() =>
      validateRegistry({ indicators: [indicator], facts: [fact], symptoms: [], diagnoses: [], recommendations: [] }),
    );
  });

  it('throws when a Symptom consumes an unregistered Fact', () => {
    const symptom: SymptomRule = { id: 's1', consumes: { facts: ['missing_fact'], indicators: [] }, evaluate: () => null };
    assert.throws(
      () => validateRegistry({ indicators: [], facts: [], symptoms: [symptom], diagnoses: [], recommendations: [] }),
      /missing_fact/,
    );
  });

  it('throws when a Recommendation triggers on an unregistered Diagnosis', () => {
    assert.throws(
      () =>
        validateRegistry({
          indicators: [],
          facts: [],
          symptoms: [],
          diagnoses: [],
          recommendations: [{ id: 'r1', triggers: ['missing_diagnosis'], evaluate: () => null }],
        }),
      /missing_diagnosis/,
    );
  });
});

describe('classifyTiers', () => {
  it("ranks a severe, well-evidenced finding above a mild, thinly-evidenced one — the spec's own worked example", () => {
    const findings: Array<Omit<DiagnosisFinding, 'tier'>> = [
      {
        id: 'a',
        severity: 0.9,
        confidence: 0.65,
        coverage: coverage(0.95),
        evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
      },
      {
        id: 'b',
        severity: 0.3,
        confidence: 0.75,
        coverage: coverage(0.2),
        evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
      },
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
  const baseDiagnosis: DiagnosisFinding = {
    id: 'd1',
    severity: 0.8,
    confidence: 0.8,
    coverage: coverage(1),
    tier: 'dominant',
    evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
  };

  it('merges two candidates recommending the same action, unioning triggeredBy', () => {
    const candidates: RecommendationResult[] = [
      {
        action: 'TRIGGER_WATERING',
        urgency: 'action_needed',
        confidence: 0.6,
        triggeredBy: 'd1',
        evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
      },
      {
        action: 'TRIGGER_WATERING',
        urgency: 'action_needed',
        confidence: 0.9,
        triggeredBy: 'd2',
        evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
      },
    ];
    const [reconciled] = reconcileRecommendations(candidates, [baseDiagnosis, { ...baseDiagnosis, id: 'd2' }]);
    assert.equal(reconciled.confidence, 0.9);
    assert.deepEqual(reconciled.triggeredBy.sort(), ['d1', 'd2']);
  });

  it('drops the lower-importance side of a mutually exclusive pair', () => {
    const candidates: RecommendationResult[] = [
      {
        action: 'TRIGGER_WATERING',
        urgency: 'action_needed',
        confidence: 0.9,
        triggeredBy: 'd1',
        evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
      },
      {
        action: 'DELAY_WATERING',
        urgency: 'advisory',
        confidence: 0.9,
        triggeredBy: 'd_weak',
        evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
      },
    ];
    const diagnoses = [baseDiagnosis, { ...baseDiagnosis, id: 'd_weak', severity: 0.1, confidence: 0.1, coverage: coverage(0.1) }];
    const reconciled = reconcileRecommendations(candidates, diagnoses, [['TRIGGER_WATERING', 'DELAY_WATERING']]);
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].action, 'TRIGGER_WATERING');
  });

  it('sorts by urgency then confidence', () => {
    const candidates: RecommendationResult[] = [
      {
        action: 'A',
        urgency: 'info',
        confidence: 0.9,
        triggeredBy: 'd1',
        evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
      },
      {
        action: 'B',
        urgency: 'action_needed',
        confidence: 0.1,
        triggeredBy: 'd1',
        evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
      },
    ];
    const reconciled = reconcileRecommendations(candidates, [baseDiagnosis]);
    assert.equal(reconciled[0].action, 'B');
  });
});

describe('InferenceEngine', () => {
  it('runs a trivial end-to-end registry and produces a recommendation', () => {
    const indicator: IndicatorDefinition = {
      id: 'moisture',
      requiredFields: [],
      compute: () => ({ id: 'moisture', value: 10, confidence: 1 }),
    };
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
        return holds == null
          ? null
          : {
              id: 'thirsty',
              severity: holds ? 1 : 0,
              confidence: 1,
              coverage: coverage(1),
              supportingFacts: ['dry'],
              evidenceBreakdown: { formula: 'weightedAverage', items: [], missing: [] },
            };
      },
    };
    const diagnosis: DiagnosisRule = {
      id: 'underwatered',
      consumes: { symptoms: ['thirsty'] },
      evaluate: (ctx) => {
        const s = ctx.symptoms.get('thirsty');
        return !s || s.severity === 0
          ? null
          : {
              id: 'underwatered',
              severity: s.severity,
              confidence: s.confidence,
              coverage: coverage(1),
              evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
            };
      },
    };
    const engine = new InferenceEngine(
      [indicator],
      [fact],
      [symptom],
      [diagnosis],
      [
        {
          id: 'water_now',
          triggers: ['underwatered'],
          evaluate: (d) => ({
            action: 'TRIGGER_WATERING',
            urgency: 'action_needed',
            confidence: d.confidence,
            triggeredBy: d.id,
            evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
          }),
        },
      ],
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
