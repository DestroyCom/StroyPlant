import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IndicatorIndex } from '../types.js';
import { wateringIntervalUnusuallyLong } from './wateringIntervalUnusuallyLong.js';

function indicators(value: number | null): IndicatorIndex {
  return new Map([['wateringIntervalDeviationSigma', { id: 'wateringIntervalDeviationSigma', value, confidence: 0.9 }]]);
}

describe('watering_interval_unusually_long', () => {
  it('holds when sigma is above 2', () => {
    assert.equal(wateringIntervalUnusuallyLong.evaluate(indicators(3), null)?.holds, true);
  });

  it('does not hold otherwise', () => {
    assert.equal(wateringIntervalUnusuallyLong.evaluate(indicators(0.5), null)?.holds, false);
  });

  it('is null when unavailable', () => {
    assert.equal(wateringIntervalUnusuallyLong.evaluate(indicators(null), null), null);
  });
});
