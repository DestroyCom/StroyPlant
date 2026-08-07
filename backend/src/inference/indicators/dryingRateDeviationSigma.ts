import type { Reading } from '@prisma/client';
import type { DeviceObservations, IndicatorDefinition, IndicatorValue } from '../types.js';

const MIN_BASELINE_DAYS = 5;
const BASELINE_WINDOW_DAYS = 14;
const MIN_HOURS_FOR_TODAY_RATE = 2;

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
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
  compute(observations: DeviceObservations): IndicatorValue {
    const withMoisture = observations.readings
      .filter((r) => r.source === 'POLL' && r.soilMoisturePercent != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const byDay = new Map<string, Reading[]>();
    for (const reading of withMoisture) {
      const key = dayKey(reading.timestamp);
      const bucket = byDay.get(key);
      if (bucket) bucket.push(reading);
      else byDay.set(key, [reading]);
    }

    const today = dayKey(new Date());
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
    if (stdDev === 0)
      return { id: 'dryingRateDeviationSigma', value: null, confidence: 0, meta: { sampleSize: recentBaselineRates.length } };

    const sigma = (todayRate - mean) / stdDev;
    const confidence = Math.min(1, recentBaselineRates.length / BASELINE_WINDOW_DAYS);

    return { id: 'dryingRateDeviationSigma', value: sigma, confidence, meta: { sampleSize: recentBaselineRates.length } };
  },
};
