import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { soilMoistureRollingAvg1h } from './soilMoistureRollingAvg1h.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
// Fixed reference instant, deliberately far from the real wall clock — every test in this file
// builds its fixtures relative to NOW and passes NOW into compute() explicitly. If the indicator
// ever reverts to reading Date.now()/new Date() internally instead of the injected `now`, the
// "recent window" filter below would compare against the real wall clock instead, and these tests
// would fail (or pass for the wrong reason) — this is the regression guard for clock injection.
const NOW = new Date('2020-06-15T12:00:00.000Z');

describe('soilMoistureRollingAvg1h', () => {
  it('averages readings from the last hour', () => {
    const readings = [
      fakeReading({ timestamp: new Date(NOW.getTime() - 10 * 60_000), soilMoisturePercent: 40 }),
      fakeReading({ timestamp: new Date(NOW.getTime() - 40 * 60_000), soilMoisturePercent: 44 }),
    ];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.ok(result.value != null && Math.abs(result.value - 42) < 1e-9);
    assert.equal(result.confidence, 1);
  });

  it('falls back to the last 5 readings when none are within the last hour, at reduced confidence', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (2 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, 50);
    assert.equal(result.confidence, 0.5);
  });

  it('returns null with 0 confidence when there is no soil moisture data at all', () => {
    const result = soilMoistureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('ignores LIVE-sourced readings', () => {
    const readings = [fakeReading({ timestamp: NOW, soilMoisturePercent: 99, source: 'LIVE' })];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
  });

  it('computes correctly against a `now` far from the real wall clock, proving it never reads Date.now()/new Date() internally', () => {
    const readings = [fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), soilMoisturePercent: 33 })];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    // If the indicator used the real Date.now() instead of the injected NOW (2020), this reading
    // (5 minutes before NOW, in 2020) would be years outside any real "last hour" window and would
    // incorrectly fall back to the 5-reading path instead of the primary "recent" path.
    assert.equal(result.value, 33);
    assert.equal(result.confidence, 1);
  });

  it('produces identical output for two separate calls with the same observations and the same fixed now', () => {
    const readings = [fakeReading({ timestamp: new Date(NOW.getTime() - 5 * 60_000), soilMoisturePercent: 33 })];
    const observations = { readings, wateringEvents: [] };
    const first = soilMoistureRollingAvg1h.compute(observations, env, NOW);
    const second = soilMoistureRollingAvg1h.compute(observations, env, NOW);
    assert.deepEqual(first, second);
  });

  it('discards the fallback average when the most recent fallback reading is older than 24h (stale)', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (25 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('still uses the fallback average when the most recent fallback reading is within 24h', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (20 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, 50);
    assert.equal(result.confidence, 0.5);
  });

  it('sets unavailableReason "no_recent_data" when there is no soil moisture data at all', () => {
    const result = soilMoistureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });

  it('sets unavailableReason "no_recent_data" when the fallback average is stale (> 24h old)', () => {
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(NOW.getTime() - (25 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });
});
