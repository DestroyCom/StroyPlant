import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { EnvironmentContext, FactSnapshot, IndicatorIndex } from '../types.js';
import { waterStress } from './waterStress.js';

const env: EnvironmentContext = { deviceKind: 'PARROT_POT', environment: null, capabilities: [], observationsAvailability: {} };

describe('water_stress', () => {
  it('reports high severity when soil is dry, drying fast, and it is hot', () => {
    const facts: FactSnapshot = new Map([
      ['soil_moisture_below_profile_min', { id: 'soil_moisture_below_profile_min', holds: true, confidence: 1, supportingIndicators: [] }],
      ['drying_rate_unusually_fast', { id: 'drying_rate_unusually_fast', holds: true, confidence: 1, supportingIndicators: [] }],
    ]);
    const indicators: IndicatorIndex = new Map([['temperatureRollingAvg1h', { id: 'temperatureRollingAvg1h', value: 32, confidence: 1 }]]);

    const result = waterStress.evaluate({ indicators, facts, environment: env });
    assert.ok(result != null);
    assert.ok(result.severity > 0.7, `expected severity > 0.7, got ${result.severity}`);
    assert.ok(result.confidence > 0.7, `expected confidence > 0.7, got ${result.confidence}`);
    assert.equal(result.coverage.ratio, 1);
  });

  it('is null when none of its evidence is available', () => {
    const result = waterStress.evaluate({ indicators: new Map(), facts: new Map(), environment: env });
    assert.equal(result, null);
  });

  it('has reduced coverage when only some evidence is available', () => {
    const facts: FactSnapshot = new Map([
      ['soil_moisture_below_profile_min', { id: 'soil_moisture_below_profile_min', holds: true, confidence: 1, supportingIndicators: [] }],
    ]);
    const result = waterStress.evaluate({ indicators: new Map(), facts, environment: env });
    assert.ok(result != null && result.coverage.ratio < 1 && result.coverage.ratio > 0);
  });
});
