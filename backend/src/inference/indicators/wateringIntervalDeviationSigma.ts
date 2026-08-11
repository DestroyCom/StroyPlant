import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const MIN_BASELINE_INTERVALS = 3;
// Deliberate floor on the baseline's standard deviation, same rationale and convention as
// `MIN_STDDEV_PERCENT_PER_DAY` in `dryingRateDeviationSigma.ts`: a device watered on a genuinely
// regular schedule (e.g. always ~every 4 days) can have a small-but-real, nonzero stddev from
// ordinary timing jitter (weekend vs weekday triggers, cooldown/allowed-hours window edges) —
// without a floor, sigma = (currentGap - mean) / stdDev amplifies that jitter into a huge,
// physically meaningless value for even a modest schedule deviation, especially with this
// indicator's typically small sample sizes. Unlike the drying-rate indicator (%/day), this one
// works in hours, so a separate constant is needed. 12 hours is an initial engineering estimate —
// half a day, small relative to the multi-day watering cycles this project's real
// devices use, but large enough to absorb realistic jitter — not derived from real sensor data
// yet; pending empirical recalibration once real production data accumulates (same convention as
// other initial-estimate constants in this codebase, e.g. `HEAT_CONTRIBUTION_MIDPOINT_C` in the
// `water_stress` symptom).
const MIN_STDDEV_HOURS = 12;

export const wateringIntervalDeviationSigma: IndicatorDefinition = {
  id: 'wateringIntervalDeviationSigma',
  requiredFields: [],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const successful = observations.wateringEvents
      .filter((event) => event.success)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (successful.length === 0) return { id: 'wateringIntervalDeviationSigma', value: null, confidence: 0 };

    const intervalsHours: number[] = [];
    for (let i = 1; i < successful.length; i++) {
      intervalsHours.push((successful[i].timestamp.getTime() - successful[i - 1].timestamp.getTime()) / 3_600_000);
    }

    if (intervalsHours.length < MIN_BASELINE_INTERVALS) {
      return { id: 'wateringIntervalDeviationSigma', value: null, confidence: 0, meta: { sampleSize: intervalsHours.length } };
    }

    const mean = intervalsHours.reduce((sum, h) => sum + h, 0) / intervalsHours.length;
    const variance = intervalsHours.reduce((sum, h) => sum + (h - mean) ** 2, 0) / intervalsHours.length;
    const stdDev = Math.sqrt(variance);
    // Floor rather than an exact-zero guard — see MIN_STDDEV_HOURS above: a near-zero-but-real
    // stddev is just as capable of producing an artificially huge sigma as an exact 0 is, and a
    // baseline that already meets MIN_BASELINE_INTERVALS but has zero/near-zero real variance is
    // still real evidence of a regular schedule — it should produce a bounded, meaningful sigma,
    // not null.
    const effectiveStdDev = Math.max(stdDev, MIN_STDDEV_HOURS);

    const lastWatering = successful[successful.length - 1];
    const currentGapHours = (now.getTime() - lastWatering.timestamp.getTime()) / 3_600_000;
    const sigma = (currentGapHours - mean) / effectiveStdDev;
    const confidence = Math.min(1, intervalsHours.length / (MIN_BASELINE_INTERVALS * 2));

    return { id: 'wateringIntervalDeviationSigma', value: sigma, confidence, meta: { sampleSize: intervalsHours.length } };
  },
};
