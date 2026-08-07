import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { indicatorDefinitions } from './index.js';

describe('indicator registry', () => {
  it('registers exactly the 4 V1-slice indicators, each with a unique id', () => {
    const ids = indicatorDefinitions.map((d) => d.id);
    assert.deepEqual(ids.sort(), [
      'dryingRateDeviationSigma',
      'soilMoistureRollingAvg1h',
      'temperatureRollingAvg1h',
      'wateringIntervalDeviationSigma',
    ]);
    assert.equal(new Set(ids).size, ids.length);
  });
});
