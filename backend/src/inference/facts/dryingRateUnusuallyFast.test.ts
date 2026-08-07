import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IndicatorIndex } from '../types.js';
import { dryingRateUnusuallyFast } from './dryingRateUnusuallyFast.js';

function indicators(value: number | null): IndicatorIndex {
  return new Map([['dryingRateDeviationSigma', { id: 'dryingRateDeviationSigma', value, confidence: 0.9 }]]);
}

describe('drying_rate_unusually_fast', () => {
  it('holds when sigma is above 2', () => {
    assert.equal(dryingRateUnusuallyFast.evaluate(indicators(2.5), null)?.holds, true);
  });

  it('does not hold when sigma is at or below 2', () => {
    assert.equal(dryingRateUnusuallyFast.evaluate(indicators(1.2), null)?.holds, false);
  });

  it('is null when the indicator is unavailable', () => {
    assert.equal(dryingRateUnusuallyFast.evaluate(indicators(null), null), null);
  });

  it('does not need a profile', () => {
    assert.equal(dryingRateUnusuallyFast.needsProfile, false);
  });
});
