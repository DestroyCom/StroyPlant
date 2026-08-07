import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnvironmentContext, FactSnapshot } from '../types.js';
import { irregularWatering } from './irregularWatering.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };

describe('irregular_watering', () => {
  it('reports full severity when the fact holds', () => {
    const facts: FactSnapshot = new Map([
      [
        'watering_interval_unusually_long',
        { id: 'watering_interval_unusually_long', holds: true, confidence: 0.9, supportingIndicators: [] },
      ],
    ]);
    const result = irregularWatering.evaluate({ indicators: new Map(), facts, environment: env });
    assert.equal(result?.severity, 1);
    assert.ok(result != null && result.confidence > 0);
  });

  it('reports zero severity when the fact does not hold', () => {
    const facts: FactSnapshot = new Map([
      [
        'watering_interval_unusually_long',
        { id: 'watering_interval_unusually_long', holds: false, confidence: 0.9, supportingIndicators: [] },
      ],
    ]);
    const result = irregularWatering.evaluate({ indicators: new Map(), facts, environment: env });
    assert.equal(result?.severity, 0);
  });

  it('is null when the fact is unavailable', () => {
    assert.equal(irregularWatering.evaluate({ indicators: new Map(), facts: new Map(), environment: env }), null);
  });
});
