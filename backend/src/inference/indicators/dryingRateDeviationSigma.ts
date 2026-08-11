import type { Reading } from '@prisma/client';
import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const MIN_BASELINE_DAYS = 5;
const BASELINE_WINDOW_DAYS = 14;
const MIN_HOURS_FOR_TODAY_RATE = 2;
// Deliberate floor on the baseline's standard deviation. A device with a genuinely stable drying
// pattern can have a small-but-real, nonzero stddev (especially with only 5-14 baseline days and
// population variance, which underestimates true dispersion for small n) — without a floor, sigma
// = (todayRate - mean) / stdDev amplifies any ordinary day-to-day wobble into a huge, physically
// meaningless value for the most stable, healthiest devices. Flooring stdDev at this value keeps
// sigma bounded, deterministic and explainable. This is an initial engineering estimate, not
// derived from real sensor data yet — pending empirical recalibration once real production data
// accumulates (same convention as other initial-estimate constants in this codebase, e.g.
// `HEAT_CONTRIBUTION_MIDPOINT_C` in the `water_stress` symptom).
const MIN_STDDEV_PERCENT_PER_DAY = 1.0;

// "YYYY-MM-DD" in the given IANA timezone — the en-CA locale is a standard trick for getting
// Intl.DateTimeFormat to produce ISO-ordered digits directly, no manual string reassembly needed.
// Deliberately duplicated from health/dailyLightIntegral.ts's own dayKey helper rather than
// imported: backend/src/inference/ must never depend on any other part of the app outside itself,
// mirroring the same isolation principle that already governs the species-blindness boundary.
function dayKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Positive = drying (losing moisture) over the day; negative = gaining (e.g. after watering).
function dailyRate(dayReadings: Reading[]): number | null {
  if (dayReadings.length < 2) return null;
  const first = dayReadings[0];
  const last = dayReadings[dayReadings.length - 1];
  const hours = (last.timestamp.getTime() - first.timestamp.getTime()) / 3_600_000;
  if (hours < MIN_HOURS_FOR_TODAY_RATE) return null;
  return (((first.soilMoisturePercent as number) - (last.soilMoisturePercent as number)) / hours) * 24;
}

export const dryingRateDeviationSigma: IndicatorDefinition = {
  id: 'dryingRateDeviationSigma',
  requiredFields: ['soilMoisturePercent'],
  compute(observations: DeviceObservations, environment: EnvironmentContext, now: Date): IndicatorValue {
    const timezone = environment.timezone ?? 'UTC';
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const byDay = new Map<string, Reading[]>();
    for (const reading of withMoisture) {
      const key = dayKey(reading.timestamp, timezone);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(reading);
      else byDay.set(key, [reading]);
    }

    const today = dayKey(now, timezone);
    const todayRate = dailyRate(byDay.get(today) ?? []);
    if (todayRate == null) return { id: 'dryingRateDeviationSigma', value: null, confidence: 0 };

    const baselineRates: number[] = [];
    for (const [day, dayReadings] of byDay) {
      if (day === today) continue;
      const rate = dailyRate(dayReadings);
      if (rate != null) baselineRates.push(rate);
    }
    const recentBaselineRates = baselineRates.slice(-BASELINE_WINDOW_DAYS);

    if (recentBaselineRates.length < MIN_BASELINE_DAYS) {
      return { id: 'dryingRateDeviationSigma', value: null, confidence: 0, meta: { sampleSize: recentBaselineRates.length } };
    }

    const mean = recentBaselineRates.reduce((sum, r) => sum + r, 0) / recentBaselineRates.length;
    const variance = recentBaselineRates.reduce((sum, r) => sum + (r - mean) ** 2, 0) / recentBaselineRates.length;
    const stdDev = Math.sqrt(variance);
    // Floor rather than an exact-zero guard: a near-zero-but-real stddev is just as capable of
    // producing an artificially huge sigma as an exact 0 is, and a baseline that's ≥5 days but has
    // zero/near-zero real variance is still real evidence of a stable device — it should produce a
    // bounded, meaningful sigma, not null.
    const effectiveStdDev = Math.max(stdDev, MIN_STDDEV_PERCENT_PER_DAY);

    const sigma = (todayRate - mean) / effectiveStdDev;
    const confidence = Math.min(1, recentBaselineRates.length / BASELINE_WINDOW_DAYS);

    return { id: 'dryingRateDeviationSigma', value: sigma, confidence, meta: { sampleSize: recentBaselineRates.length } };
  },
};
