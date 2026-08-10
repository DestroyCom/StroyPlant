import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toPlantHealthStatusDTO } from './dto.js';
import type { InferenceResult } from './types.js';

const emptyBreakdown = { formula: 'noisyOr' as const, items: [], missing: [] };

describe('toPlantHealthStatusDTO', () => {
  it('maps diagnoses and recommendations to their minimal external shape only', () => {
    const result: InferenceResult = {
      indicators: new Map(),
      facts: new Map(),
      symptoms: new Map(),
      diagnoses: [
        {
          id: 'chronic_underwatering',
          severity: 0.8,
          confidence: 0.9,
          coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
          tier: 'dominant',
          evidenceBreakdown: emptyBreakdown,
        },
      ],
      recommendations: [
        { action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence: 0.85, triggeredBy: ['chronic_underwatering'], importance: 0.7 },
      ],
    };

    const dto = toPlantHealthStatusDTO(result);

    assert.deepEqual(dto, {
      diagnoses: [{ id: 'chronic_underwatering', severity: 0.8, confidence: 0.9, tier: 'dominant' }],
      recommendations: [{ action: 'TRIGGER_WATERING', confidence: 0.85 }],
    });
    // Internal-only fields (coverage, evidenceBreakdown, importance, triggeredBy) never appear.
    assert.equal('evidenceBreakdown' in dto.diagnoses[0], false);
    assert.equal('importance' in dto.recommendations[0], false);
  });

  it('returns empty arrays for an empty result', () => {
    const result: InferenceResult = { indicators: new Map(), facts: new Map(), symptoms: new Map(), diagnoses: [], recommendations: [] };
    assert.deepEqual(toPlantHealthStatusDTO(result), { diagnoses: [], recommendations: [] });
  });
});
