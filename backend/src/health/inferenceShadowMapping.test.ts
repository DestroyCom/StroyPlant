import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  DiagnosisFinding,
  EvidenceBreakdown,
  FactDefinition,
  InferenceResult,
  SymptomResult,
  SymptomRule,
  SymptomSnapshot,
} from '../inference/types.js';
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
        items: [
          {
            source: { kind: 'fact', id: 'fact_with_note' },
            weight: 1,
            strength: 1,
            confidence: 1,
            polarity: 'supports',
            contribution: 0.5,
          },
        ],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], new Map(), facts, symptoms), ['Fact note.']);
  });

  it('collects the migrationNote of a symptom-sourced item above the threshold', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [
          {
            source: { kind: 'symptom', id: 'symptom_with_note' },
            weight: 1,
            strength: 1,
            confidence: 1,
            polarity: 'supports',
            contribution: 0.5,
          },
        ],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], new Map(), facts, symptoms), ['Symptom note.']);
  });

  it('ignores an item whose contribution is at or below the threshold (0.05)', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [
          {
            source: { kind: 'fact', id: 'fact_with_note' },
            weight: 1,
            strength: 1,
            confidence: 1,
            polarity: 'supports',
            contribution: 0.05,
          },
        ],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], new Map(), facts, symptoms), []);
  });

  it('ignores a fact/symptom with no migrationNote set', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [
          {
            source: { kind: 'fact', id: 'fact_without_note' },
            weight: 1,
            strength: 1,
            confidence: 1,
            polarity: 'supports',
            contribution: 0.5,
          },
        ],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], new Map(), facts, symptoms), []);
  });

  it('ignores an indicator-sourced item (indicators have no migrationNote slot)', () => {
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [
          {
            source: { kind: 'indicator', id: 'soilMoistureRollingAvg1h' },
            weight: 1,
            strength: 1,
            confidence: 1,
            polarity: 'supports',
            contribution: 0.5,
          },
        ],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], new Map(), facts, symptoms), []);
  });

  it('deduplicates the same note appearing from two contributing diagnoses', () => {
    const item = {
      source: { kind: 'fact' as const, id: 'fact_with_note' },
      weight: 1,
      strength: 1,
      confidence: 1,
      polarity: 'supports' as const,
      contribution: 0.5,
    };
    const d1 = diagnosis({ id: 'a', severityBreakdown: { formula: 'weightedAverage', items: [item], missing: [] } });
    const d2 = diagnosis({ id: 'b', severityBreakdown: { formula: 'weightedAverage', items: [item], missing: [] } });
    assert.deepEqual(collectMainDifferences([d1, d2], new Map(), facts, symptoms), ['Fact note.']);
  });

  it('returns an empty array for no diagnoses', () => {
    assert.deepEqual(collectMainDifferences([], new Map(), facts, symptoms), []);
  });

  it("descends into a symptom-sourced item's own severityBreakdown to collect a fact-level migrationNote two levels down", () => {
    // The diagnosis only cites the symptom directly (as chronic_underwatering does in the real
    // registry) — the fact-level note lives inside the symptom's OWN severityBreakdown, which the
    // caller passes in separately via the `symptoms` snapshot map.
    const d = diagnosis({
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [
          {
            source: { kind: 'symptom', id: 'some_symptom' },
            weight: 1,
            strength: 1,
            confidence: 1,
            polarity: 'supports',
            contribution: 0.5,
          },
        ],
        missing: [],
      },
    });

    const symptomResult: SymptomResult = {
      id: 'some_symptom',
      severity: 0.7,
      confidence: 0.7,
      coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
      supportingFacts: ['some_fact'],
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [
          {
            source: { kind: 'fact', id: 'some_fact' },
            weight: 1,
            strength: 1,
            confidence: 1,
            polarity: 'supports',
            contribution: 0.5,
          },
        ],
        missing: [],
      },
      confidenceBreakdown: emptyBreakdown(),
    };
    const symptomSnapshot: SymptomSnapshot = new Map([['some_symptom', symptomResult]]);

    const factsWithNested: FactDefinition[] = [
      ...facts,
      { id: 'some_fact', needsProfile: false, requiredIndicators: [], migrationNote: 'Nested fact note.', evaluate: () => null },
    ];
    const symptomsWithNested: SymptomRule[] = [
      ...symptoms,
      { id: 'some_symptom', consumes: { facts: [], indicators: [] }, evaluate: () => null },
    ];

    assert.deepEqual(collectMainDifferences([d], symptomSnapshot, factsWithNested, symptomsWithNested), ['Nested fact note.']);
  });

  it("never walks a weak_hypothesis-tier diagnosis's evidence, even if it would otherwise produce a note", () => {
    const d = diagnosis({
      tier: 'weak_hypothesis',
      severityBreakdown: {
        formula: 'weightedAverage',
        items: [
          {
            source: { kind: 'fact', id: 'fact_with_note' },
            weight: 1,
            strength: 1,
            confidence: 1,
            polarity: 'supports',
            contribution: 0.5,
          },
        ],
        missing: [],
      },
    });
    assert.deepEqual(collectMainDifferences([d], new Map(), facts, symptoms), []);
  });
});
