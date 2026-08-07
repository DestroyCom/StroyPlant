import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IndicatorIndex, ReferenceProfile } from '../types.js';
import { soilMoistureBelowProfileMin } from './soilMoistureBelowProfileMin.js';

function indicators(value: number | null): IndicatorIndex {
  return new Map([['soilMoistureRollingAvg1h', { id: 'soilMoistureRollingAvg1h', value, confidence: 1 }]]);
}

const profile: ReferenceProfile = { soilMoisturePercent: { min: 35, max: 65 } };

describe('soil_moisture_below_profile_min', () => {
  it('holds when the indicator is below the profile minimum', () => {
    const result = soilMoistureBelowProfileMin.evaluate(indicators(20), profile);
    assert.equal(result?.holds, true);
    assert.equal(result?.evidence?.currentValue, 20);
    assert.equal(result?.evidence?.minimumExpected, 35);
  });

  it('does not hold when the indicator is within range', () => {
    assert.equal(soilMoistureBelowProfileMin.evaluate(indicators(50), profile)?.holds, false);
  });

  it('is null when there is no profile', () => {
    assert.equal(soilMoistureBelowProfileMin.evaluate(indicators(20), null), null);
  });

  it('is null when the indicator has no value', () => {
    assert.equal(soilMoistureBelowProfileMin.evaluate(indicators(null), profile), null);
  });
});
