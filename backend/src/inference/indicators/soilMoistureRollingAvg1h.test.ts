import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { soilMoistureRollingAvg1h } from './soilMoistureRollingAvg1h.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };

describe('soilMoistureRollingAvg1h', () => {
  it('averages readings from the last hour', () => {
    const now = Date.now();
    const readings = [
      fakeReading({ timestamp: new Date(now - 10 * 60_000), soilMoisturePercent: 40 }),
      fakeReading({ timestamp: new Date(now - 40 * 60_000), soilMoisturePercent: 44 }),
    ];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env);
    assert.ok(result.value != null && Math.abs(result.value - 42) < 1e-9);
    assert.equal(result.confidence, 1);
  });

  it('falls back to the last 5 readings when none are within the last hour, at reduced confidence', () => {
    const now = Date.now();
    const readings = Array.from({ length: 5 }, (_, i) =>
      fakeReading({ timestamp: new Date(now - (2 + i) * 3_600_000), soilMoisturePercent: 50 }),
    );
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env);
    assert.equal(result.value, 50);
    assert.equal(result.confidence, 0.5);
  });

  it('returns null with 0 confidence when there is no soil moisture data at all', () => {
    const result = soilMoistureRollingAvg1h.compute({ readings: [], wateringEvents: [] }, env);
    assert.equal(result.value, null);
    assert.equal(result.confidence, 0);
  });

  it('ignores LIVE-sourced readings', () => {
    const readings = [fakeReading({ timestamp: new Date(), soilMoisturePercent: 99, source: 'LIVE' })];
    const result = soilMoistureRollingAvg1h.compute({ readings, wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });
});
