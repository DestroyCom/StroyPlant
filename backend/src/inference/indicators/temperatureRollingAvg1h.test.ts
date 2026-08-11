import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { temperatureRollingAvg1h } from './temperatureRollingAvg1h.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
// See soilMoistureRollingAvg1h.test.ts for the full rationale on using a fixed, far-from-real-time
// reference instant instead of Date.now() in every fixture.
const NOW = new Date('2020-06-15T12:00:00.000Z');

describe('temperatureRollingAvg1h', () => {
  it('averages readings from the last hour', () => {
    const readings = [
      fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), temperatureC: 24 }),
      fakeReading({ timestamp: new Date(NOW.getTime() - 15 * 60_000), temperatureC: 26 }),
    ];
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.ok(result.value != null && Math.abs(result.value - 25) < 1e-9);
  });

  it('returns null when there is no temperature data', () => {
    const result = temperatureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('computes correctly against a `now` far from the real wall clock, proving it never reads Date.now()/new Date() internally', () => {
    const readings = [fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), temperatureC: 21 })];
    const result = temperatureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, 21);
    assert.equal(result.confidence, 1);
  });

  it('produces identical output for two separate calls with the same observations and the same fixed now', () => {
    const readings = [fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), temperatureC: 21 })];
    const observations = { readings, wateringEvents: [] };
    const first = temperatureRollingAvg1h.compute(observations, env, NOW);
    const second = temperatureRollingAvg1h.compute(observations, env, NOW);
    assert.deepEqual(first, second);
  });
});
