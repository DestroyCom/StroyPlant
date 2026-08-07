import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { dryingRateDeviationSigma } from './dryingRateDeviationSigma.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
const DAY_MS = 24 * 3_600_000;

function readingsForDay(daysAgo: number, startPercent: number, endPercent: number) {
  const dayStart = new Date(Date.now() - daysAgo * DAY_MS);
  dayStart.setUTCHours(0, 0, 0, 0);
  return [
    fakeReading({ timestamp: new Date(dayStart.getTime() + 1 * 3_600_000), soilMoisturePercent: startPercent }),
    fakeReading({ timestamp: new Date(dayStart.getTime() + 20 * 3_600_000), soilMoisturePercent: endPercent }),
  ];
}

describe('dryingRateDeviationSigma', () => {
  it('returns null when there are fewer than 5 baseline days', () => {
    const readings = [...readingsForDay(2, 50, 45), ...readingsForDay(1, 50, 45), ...readingsForDay(0, 50, 30)];
    const result = dryingRateDeviationSigma.compute({ readings, wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });

  it('reports a strongly positive sigma when today dries much faster than a stable baseline', () => {
    // Baseline days deliberately vary the day-end percent (44/45/46) rather than repeating an
    // identical value: an identical drop every day yields a real (not just float-noise) stddev of
    // exactly 0, which the implementation correctly treats as "no meaningful baseline" and returns
    // null for — a degenerate fixture that would silently pass this assertion for the wrong reason
    // (an unguarded 0/~0 division producing a huge, meaningless number) rather than genuinely
    // proving deviation detection.
    const endPercents = [44, 46, 45, 44, 46, 45, 44, 46, 45, 44]; // ~5-7.5%/day baseline, real spread
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, endPercents[i])).flat();
    const today = readingsForDay(0, 50, 20); // ~38%/day today — far above baseline
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env);
    assert.ok(result.value != null && result.value > 2, `expected sigma > 2, got ${result.value}`);
  });

  it('returns null when today has no reading pair to compute a rate from', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const result = dryingRateDeviationSigma.compute({ readings: baselineDays, wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });
});
