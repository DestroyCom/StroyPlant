import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { temperatureRollingAvg1h } from './temperatureRollingAvg1h.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };

describe('temperatureRollingAvg1h', () => {
  it('averages readings from the last hour', () => {
    const now = Date.now();
    const readings = [
      fakeReading({ timestamp: new Date(now - 5 * 60_000), temperatureC: 24 }),
      fakeReading({ timestamp: new Date(now - 15 * 60_000), temperatureC: 26 }),
    ];
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env);
    assert.ok(result.value != null && Math.abs(result.value - 25) < 1e-9);
  });

  it('returns null when there is no temperature data', () => {
    const result = temperatureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });
});
