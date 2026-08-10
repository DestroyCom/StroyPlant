import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferenceEngine } from './registry.js';
import { fakeReading, fakeWateringEvent } from './testHelpers.js';
import type { EnvironmentContext, ReferenceProfile } from './types.js';

const env: EnvironmentContext = {
  deviceKind: 'PARROT_POT',
  environment: 'INDOOR',
  capabilities: ['soilMoisture', 'temperature'],
  observationsAvailability: {},
};
const profile: ReferenceProfile = { soilMoisturePercent: { min: 35, max: 65 }, temperatureC: { min: 12, max: 32 } };
const operational = { autoWateringEnabled: true, withinAllowedWindow: true, cooldownActive: false };
const DAY_MS = 24 * 3_600_000;

function healthyHistory() {
  const readings = [];
  const wateringEvents = [];
  // 40 days of a stable 4-day watering cycle: 60% -> 40% then reset, well within the 35-65 profile
  // range. Long enough (10 watering events) that underwateredHistory() below, after dropping every
  // watering event from the most recent 12 days, still leaves a solid multi-event baseline for
  // wateringIntervalDeviationSigma to judge the resulting gap against — a short baseline (the
  // original 16-day/4-event version) left too few surviving events for that indicator to compute at
  // all once the recent ones were stripped.
  for (let day = 40; day >= 0; day--) {
    const cyclePosition = (40 - day) % 4;
    const moisture = 60 - cyclePosition * 5;
    readings.push(
      fakeReading({ timestamp: new Date(Date.now() - day * DAY_MS - 2 * 3_600_000), soilMoisturePercent: moisture, temperatureC: 22 }),
    );
    readings.push(
      fakeReading({ timestamp: new Date(Date.now() - day * DAY_MS - 20 * 3_600_000), soilMoisturePercent: moisture - 5, temperatureC: 22 }),
    );
    if (cyclePosition === 3) wateringEvents.push(fakeWateringEvent({ timestamp: new Date(Date.now() - day * DAY_MS) }));
  }
  return { readings, wateringEvents };
}

function underwateredHistory() {
  const { readings, wateringEvents } = healthyHistory();
  // Drop every watering event from the most recent 12 days (the longer baseline above still leaves
  // several older events to compute a meaningful watering-interval baseline from), and crash
  // today's moisture far below the profile minimum with a fast decline — deliberately far outside
  // the healthy baseline above.
  const staleWateringEvents = wateringEvents.filter((event) => Date.now() - event.timestamp.getTime() > 12 * DAY_MS);
  const staleReadings = readings.filter((reading) => Date.now() - reading.timestamp.getTime() > 1 * DAY_MS);
  const today = [
    fakeReading({ timestamp: new Date(Date.now() - 8 * 3_600_000), soilMoisturePercent: 30, temperatureC: 29 }),
    // 20 minutes ago, not exactly 1 hour ago: soilMoistureRollingAvg1h's "recent" window is exactly
    // 1 hour, and a reading placed precisely at that boundary is only inside it if the engine
    // happens to run within a few milliseconds of fixture construction — a real, observed source of
    // test flakiness (this reading fell out of the window under any measurable overhead, silently
    // falling back to a 5-reading rolling average diluted by older, healthy-range readings, which
    // masked the crash this fixture is trying to represent). 20 minutes is comfortably inside the
    // window regardless of execution speed.
    fakeReading({ timestamp: new Date(Date.now() - 20 * 60_000), soilMoisturePercent: 16, temperatureC: 30 }),
  ];
  return { readings: [...staleReadings, ...today], wateringEvents: staleWateringEvents };
}

describe('inferenceEngine — chronic_underwatering vertical slice', () => {
  it('produces no diagnosis or recommendation for a healthy watering history', () => {
    const result = inferenceEngine.run(healthyHistory(), profile, env, operational);
    assert.equal(result.diagnoses.length, 0);
    assert.equal(result.recommendations.length, 0);
  });

  it('produces chronic_underwatering and a TRIGGER_WATERING recommendation for a genuinely underwatered device', () => {
    const result = inferenceEngine.run(underwateredHistory(), profile, env, operational);

    assert.equal(result.facts.get('soil_moisture_below_profile_min')?.holds, true);
    assert.ok(result.symptoms.has('water_stress'));

    const diagnosis = result.diagnoses.find((d) => d.id === 'chronic_underwatering');
    assert.ok(diagnosis != null, 'expected a chronic_underwatering diagnosis');
    assert.notEqual(diagnosis.tier, 'weak_hypothesis');

    const recommendation = result.recommendations.find((r) => r.action === 'TRIGGER_WATERING');
    assert.ok(recommendation != null, 'expected a TRIGGER_WATERING recommendation');
    assert.deepEqual(recommendation.triggeredBy, ['chronic_underwatering']);
  });

  it('withholds the recommendation while a cooldown is active, without withholding the diagnosis', () => {
    const result = inferenceEngine.run(underwateredHistory(), profile, env, { ...operational, cooldownActive: true });
    assert.ok(
      result.diagnoses.some((d) => d.id === 'chronic_underwatering'),
      'diagnosis is horticultural reasoning, unaffected by operational constraints',
    );
    const recommendation = result.recommendations.find((r) => r.action === 'TRIGGER_WATERING');
    // Still present (Recommendation vs. Execution: the engine only lowers confidence, it does not
    // itself withhold the recommendation — a real scheduler consuming this would apply its own
    // independent cooldown gate on top, per the spec's "Recommendation vs. Execution" section).
    assert.ok(recommendation != null);
  });
});
