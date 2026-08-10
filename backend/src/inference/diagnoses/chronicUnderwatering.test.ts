import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnvironmentContext, SymptomSnapshot } from '../types.js';
import { chronicUnderwatering } from './chronicUnderwatering.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };
const emptySeverityBreakdown = { formula: 'weightedAverage' as const, items: [], missing: [] };
const emptyConfidenceBreakdown = { formula: 'noisyOr' as const, items: [], missing: [] };

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
          severityBreakdown: emptySeverityBreakdown,
          confidenceBreakdown: emptyConfidenceBreakdown,
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
          severityBreakdown: emptySeverityBreakdown,
          confidenceBreakdown: emptyConfidenceBreakdown,
        },
      ],
    ]);
    const result = chronicUnderwatering.evaluate({ indicators: new Map(), facts: new Map(), environment: env, symptoms });
    assert.ok(result != null);
    // Weighted combination: 0.65 * 0.8 (water_stress) + 0.35 * 1 (irregular_watering) = 0.87
    // This exact check proves both "not a passthrough" and "correctly weighted", not just direction.
    assert.ok(
      result.severity != null && Math.abs(result.severity - 0.87) < 1e-9,
      `expected severity ≈0.87 (correctly weighted combination), got ${result.severity}`,
    );
  });

  it('is null when neither contributing symptom is present', () => {
    const result = chronicUnderwatering.evaluate({ indicators: new Map(), facts: new Map(), environment: env, symptoms: new Map() });
    assert.equal(result, null);
  });
});
