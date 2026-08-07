import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DiagnosisFinding, EnvironmentContext, InferenceContext, OperationalConstraints } from '../types.js';
import { triggerWatering } from './triggerWatering.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };

function ctx(operationalConstraints: OperationalConstraints): InferenceContext & { operationalConstraints: OperationalConstraints } {
  return { indicators: new Map(), facts: new Map(), environment: env, operationalConstraints };
}

const diagnosis: DiagnosisFinding = {
  id: 'chronic_underwatering',
  severity: 0.8,
  confidence: 0.85,
  coverage: { availableWeight: 1, totalWeight: 1, ratio: 1 },
  tier: 'dominant',
  evidenceBreakdown: { formula: 'noisyOr', items: [], missing: [] },
};

describe('trigger_watering', () => {
  it('recommends TRIGGER_WATERING with high confidence when there is no cooldown', () => {
    const result = triggerWatering.evaluate(
      diagnosis,
      ctx({ autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: false }),
    );
    assert.equal(result?.action, 'TRIGGER_WATERING');
    assert.equal(result?.triggeredBy, 'chronic_underwatering');
    assert.ok(result != null && result.confidence > 0.7);
  });

  it('has lower confidence when a cooldown is active', () => {
    const withoutCooldown = triggerWatering.evaluate(
      diagnosis,
      ctx({ autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: false }),
    );
    const withCooldown = triggerWatering.evaluate(
      diagnosis,
      ctx({ autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: true }),
    );
    assert.ok(withoutCooldown != null && withCooldown != null && withCooldown.confidence < withoutCooldown.confidence);
  });

  it('only triggers on chronic_underwatering', () => {
    assert.deepEqual(triggerWatering.triggers, ['chronic_underwatering']);
  });
});
