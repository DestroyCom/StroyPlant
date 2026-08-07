import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeWateringEvent } from '../testHelpers.js';
import { wateringIntervalDeviationSigma } from './wateringIntervalDeviationSigma.js';

const env = { deviceKind: 'PARROT_POT' as const, environment: null, capabilities: [], observationsAvailability: {} };
const DAY_MS = 24 * 3_600_000;
const HOUR_MS = 3_600_000;

describe('wateringIntervalDeviationSigma', () => {
  it('returns null with no successful watering events', () => {
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: [] }, env);
    assert.equal(result.value, null);
  });

  it('returns null with fewer than 3 historical intervals', () => {
    const events = [
      fakeWateringEvent({ timestamp: new Date(Date.now() - 8 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(Date.now() - 4 * DAY_MS) }),
    ];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env);
    assert.equal(result.value, null);
  });

  it('reports a positive sigma when the current gap is far longer than a regular history', () => {
    const events = [
      fakeWateringEvent({ timestamp: new Date(Date.now() - 40 * DAY_MS) }),
      fakeWateringEvent({ timestamp: new Date(Date.now() - 36 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(Date.now() - 32 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(Date.now() - 28 * DAY_MS) }), // 4-day interval
      fakeWateringEvent({ timestamp: new Date(Date.now() - 15 * DAY_MS) }), // 13-day gap since — the "current" gap
    ];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env);
    assert.ok(result.value != null && result.value > 2, `expected sigma > 2, got ${result.value}`);
  });

  it('bounds sigma via the stddev floor when the baseline has near-zero real variance', () => {
    // Baseline intervals are ~96h (4 days) apart with only tiny, real jitter: [94, 96, 98, 96] hours
    // → mean = 96h, population stddev = sqrt(((-2)^2 + 0^2 + 2^2 + 0^2) / 4) = sqrt(2) ≈ 1.414h,
    // well under the MIN_STDDEV_HOURS = 12 floor, so the floor binds.
    // Current gap since the last watering is 130h (~5.4 days) — a real but moderate deviation from
    // the ~4-day habit, not an extreme event.
    // Without the floor: sigma = (130 - 96) / 1.414 ≈ 24.04 — artificially huge for a moderately
    // late watering on an otherwise very regular device.
    // With the floor applied: effective stddev = max(1.414, 12) = 12, so
    // sigma = (130 - 96) / 12 ≈ 2.83 — bounded and explainable.
    const currentGapHours = 130;
    const intervalsHours = [94, 96, 98, 96]; // oldest→newest gaps between successive waterings
    let agoHours = currentGapHours;
    const timestamps: Date[] = [new Date(Date.now() - agoHours * HOUR_MS)]; // newest (last) event first
    for (let i = intervalsHours.length - 1; i >= 0; i--) {
      agoHours += intervalsHours[i];
      timestamps.push(new Date(Date.now() - agoHours * HOUR_MS));
    }
    // timestamps is newest→oldest; fakeWateringEvent order doesn't matter, the indicator sorts.
    const events = timestamps.map((timestamp) => fakeWateringEvent({ timestamp }));
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env);
    assert.ok(result.value != null && result.value > 0 && result.value < 5, `expected bounded sigma (< 5), got ${result.value}`);
  });

  it('ignores failed watering events', () => {
    const events = [fakeWateringEvent({ timestamp: new Date(Date.now() - DAY_MS), success: false })];
    const result = wateringIntervalDeviationSigma.compute({ readings: [], wateringEvents: events }, env);
    assert.equal(result.value, null);
  });
});
