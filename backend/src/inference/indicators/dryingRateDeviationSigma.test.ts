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
    // exactly 0, which would be a degenerate fixture — it would exercise the MIN_STDDEV_PERCENT_PER_DAY
    // floor below rather than genuinely proving deviation detection against a real, non-degenerate
    // baseline spread. Hand-verified: mean ≈ 6.44%/day, stddev ≈ 1.05%/day — already above the 1.0
    // floor, so the floor does not bind here and this test exercises the raw stddev path.
    const endPercents = [44, 46, 45, 44, 46, 45, 44, 46, 45, 44]; // ~5-7.5%/day baseline, real spread
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, endPercents[i])).flat();
    const today = readingsForDay(0, 50, 20); // ~38%/day today — far above baseline
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env);
    assert.ok(result.value != null && result.value > 2, `expected sigma > 2, got ${result.value}`);
  });

  it('bounds sigma via the stddev floor when the baseline has near-zero real variance', () => {
    // Baseline daily drying rates are ~5%/day with only tiny, real day-to-day variation:
    // rates ≈ [5.0, 5.05, 4.95, 5.0, 5.1] → mean = 5.02, population stddev ≈ 0.051 %/day (well
    // under the MIN_STDDEV_PERCENT_PER_DAY = 1.0 floor, so the floor binds).
    // Without the floor, a today's rate of 7%/day (a real but moderate difference — not an extreme
    // event) would give sigma = (7 - 5.02) / 0.051 ≈ 38.8 — artificially huge for what is actually
    // an unremarkable deviation from a very stable device. With the floor applied, effective stddev
    // = max(0.051, 1.0) = 1.0, so sigma = (7 - 5.02) / 1.0 ≈ 1.98 — bounded and explainable.
    const rates = [5.0, 5.05, 4.95, 5.0, 5.1];
    const baselineDays = rates.flatMap((rate, i) => readingsForDay(i + 1, 50, 50 - (rate * 19) / 24));
    const today = readingsForDay(0, 50, 50 - (7 * 19) / 24); // ~7%/day today
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env);
    assert.ok(result.value != null && result.value > 0 && result.value < 10, `expected bounded sigma (< 10), got ${result.value}`);
  });

  it('returns null when today has no reading pair to compute a rate from', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const result = dryingRateDeviationSigma.compute({ readings: baselineDays, wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });
});
