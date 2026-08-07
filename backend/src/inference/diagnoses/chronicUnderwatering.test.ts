import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnvironmentContext, SymptomSnapshot } from '../types.js';
import { chronicUnderwatering } from './chronicUnderwatering.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };
const emptyBreakdown = { formula: 'weightedAverage' as const, items: [], missing: [] };

describe('chronic_underwatering', () => {
  it('combines water_stress and irregular_watering into a diagnosis with real interpretation (not an alias)', () => {
    const symptoms: SymptomSnapshot = new Map([
      [
        'water_stress',
        {
          id: 'water_stress',
          severity: 0.8,
          confidence: 0.9,
          coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
          supportingFacts: [],
          evidenceBreakdown: emptyBreakdown,
        },
      ],
      [
        'irregular_watering',
        {
          id: 'irregular_watering',
          severity: 1,
          confidence: 0.8,
          coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
          supportingFacts: [],
          evidenceBreakdown: emptyBreakdown,
        },
      ],
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
