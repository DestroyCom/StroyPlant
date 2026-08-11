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
});

describe('symptomEvidence', () => {
  it('maps a symptom to its severity as strength', () => {
    const symptoms: SymptomSnapshot = new Map([
      [
        's1',
        {
          id: 's1',
          severity: 0.7,
          confidence: 0.8,
          coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
          supportingFacts: [],
          severityBreakdown: { formula: 'weightedAverage', items: [], missing: [] },
          confidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
        },
      ],
    ]);
    assert.equal(symptomEvidence(symptoms, 's1', 1).strength, 0.7);
  });
});

describe('diagnosisEvidence', () => {
  it('maps a diagnosis to its confidence as strength', () => {
    const diagnosis: DiagnosisFinding = {
      id: 'd1',
      severity: 0.6,
      confidence: 0.85,
      coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
      tier: 'secondary',
      severityBreakdown: { formula: 'weightedAverage', items: [], missing: [] },
      confidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
    };
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
