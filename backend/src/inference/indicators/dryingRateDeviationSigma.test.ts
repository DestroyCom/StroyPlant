import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeReading } from '../testHelpers.js';
import { dryingRateDeviationSigma } from './dryingRateDeviationSigma.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
const DAY_MS = 24 * 3_600_000;
// See soilMoistureRollingAvg1h.test.ts for the full rationale on using a fixed, far-from-real-time
// reference instant instead of Date.now() in every fixture.
const NOW = new Date('2020-06-15T12:00:00.000Z');

// `referenceNow` defaults to the file-level NOW so most call sites don't need to pass it — a later
// task (Fix 3, timezone-aware day bucketing) needs a second, different reference instant for one
// specific test, which is why this isn't just a closure over NOW.
function readingsForDay(daysAgo: number, startPercent: number, endPercent: number, referenceNow: Date = NOW) {
  const dayStart = new Date(referenceNow.getTime() - daysAgo * DAY_MS);
  dayStart.setUTCHours(0, 0, 0, 0);
  return [
    fakeReading({ timestamp: new Date(dayStart.getTime() + 1 * 3_600_000), soilMoisturePercent: startPercent }),
    fakeReading({ timestamp: new Date(dayStart.getTime() + 20 * 3_600_000), soilMoisturePercent: endPercent }),
  ];
}

describe('dryingRateDeviationSigma', () => {
  it('returns null when there are fewer than 5 baseline days', () => {
    const readings = [...readingsForDay(2, 50, 45), ...readingsForDay(1, 50, 45), ...readingsForDay(0, 50, 30)];
    const result = dryingRateDeviationSigma.compute({ readings, wateringEvents: [] }, env, NOW);
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
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env, NOW);
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
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env, NOW);
    assert.ok(result.value != null && result.value > 0 && result.value < 10, `expected bounded sigma (< 10), got ${result.value}`);
  });

  it('returns null when today has no reading pair to compute a rate from', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const result = dryingRateDeviationSigma.compute({ readings: baselineDays, wateringEvents: [] }, env, NOW);
    assert.equal(result.value, null);
  });

  it('computes correctly against a `now` far from the real wall clock, proving it never reads Date.now()/new Date() internally', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const today = readingsForDay(0, 50, 44);
    const result = dryingRateDeviationSigma.compute({ readings: [...baselineDays, ...today], wateringEvents: [] }, env, NOW);
    // If the indicator computed "today" via the real Date.now() instead of the injected NOW (2020),
    // none of these 2020-dated readings would land in "today"'s bucket and this would return null.
    assert.notEqual(result.value, null);
  });

  it('produces identical output for two separate calls with the same observations and the same fixed now', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const today = readingsForDay(0, 50, 44);
    const observations = { readings: [...baselineDays, ...today], wateringEvents: [] };
    const first = dryingRateDeviationSigma.compute(observations, env, NOW);
    const second = dryingRateDeviationSigma.compute(observations, env, NOW);
    assert.deepEqual(first, second);
  });

  it('buckets "today" by the device timezone, not hardcoded UTC — closes the ~2h blind spot right after UTC midnight', () => {
    const localNow = new Date('2020-06-16T01:00:00.000Z'); // 1am UTC = 2am in Etc/GMT-1, same local calendar day
    const timezone = 'Etc/GMT-1'; // fixed offset (UTC+1), no DST — deterministic
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45, localNow)).flat();
    const todayReadings = [
      // Local midnight (00:00 in Etc/GMT-1) is 2020-06-15T23:00:00Z — the start of local "today".
      fakeReading({ timestamp: new Date('2020-06-15T23:00:00.000Z'), soilMoisturePercent: 50 }),
      // localNow itself: local 02:00, exactly 2h into local "today" — meets MIN_HOURS_FOR_TODAY_RATE.
      fakeReading({ timestamp: localNow, soilMoisturePercent: 46 }),
    ];
    const result = dryingRateDeviationSigma.compute(
      { readings: [...baselineDays, ...todayReadings], wateringEvents: [] },
      { ...env, timezone },
      localNow,
    );
    // Bucketed by hardcoded UTC, the 2020-06-15T23:00:00Z reading falls into the June 15 bucket
    // (not June 16), leaving "today" (June 16 UTC) with only localNow's single reading — dailyRate
    // returns null at its two-reading minimum before MIN_HOURS_FOR_TODAY_RATE is even checked.
    // Bucketed by the device's actual 'Etc/GMT-1' timezone, both readings land in the same
    // local-June-16 bucket, spanning exactly 2h — enough to compute a rate.
    assert.notEqual(result.value, null);
  });

  it('preserves the exact previous (UTC) behavior when timezone is omitted', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const today = readingsForDay(0, 50, 44);
    const observations = { readings: [...baselineDays, ...today], wateringEvents: [] };
    const withExplicitUtc = dryingRateDeviationSigma.compute(observations, { ...env, timezone: 'UTC' }, NOW);
    const withOmittedTimezone = dryingRateDeviationSigma.compute(observations, env, NOW);
    assert.deepEqual(withExplicitUtc, withOmittedTimezone);
  });

  it('sets unavailableReason "insufficient_history" when there are fewer than 5 baseline days', () => {
    const readings = [...readingsForDay(2, 50, 45), ...readingsForDay(1, 50, 45), ...readingsForDay(0, 50, 30)];
    const result = dryingRateDeviationSigma.compute({ readings, wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'insufficient_history');
  });

  it('sets unavailableReason "no_recent_data" when today has no reading pair to compute a rate from', () => {
    const baselineDays = Array.from({ length: 10 }, (_, i) => readingsForDay(i + 1, 50, 45)).flat();
    const result = dryingRateDeviationSigma.compute({ readings: baselineDays, wateringEvents: [] }, env, NOW);
    assert.equal(result.unavailableReason, 'no_recent_data');
  });
});
