import type { DeviceObservations, EnvironmentContext, IndicatorDefinition, IndicatorValue } from '../types.js';

const RECENT_WINDOW_MS = 60 * 60_000;
const FALLBACK_SAMPLE_SIZE = 5;
// An initial engineering estimate (not derived from real data): beyond this age, even the
// reduced-confidence (0.5) fallback average is considered too stale to be worth reporting — a
// device offline for months should not produce a confident-enough value that could reach
// TRIGGER_WATERING. Same convention as this codebase's other threshold constants (e.g.
// MIN_STDDEV_PERCENT_PER_DAY in dryingRateDeviationSigma.ts).
const MAX_STALE_FALLBACK_AGE_MS = 24 * 3_600_000;

export const temperatureRollingAvg1h: IndicatorDefinition = {
  id: 'temperatureRollingAvg1h',
  requiredFields: ['temperatureC'],
  compute(observations: DeviceObservations, _environment: EnvironmentContext, now: Date): IndicatorValue {
    const withTemp = observations.readings
      .filter((r) => r.source === 'POLL' && r.temperatureC != null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    const nowMs = now.getTime();
    const recent = withTemp.filter((r) => nowMs - r.timestamp.getTime() <= RECENT_WINDOW_MS);
    const sample = recent.length > 0 ? recent : withTemp.slice(-FALLBACK_SAMPLE_SIZE);

    if (sample.length === 0) return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };

    if (recent.length === 0) {
      const mostRecentFallback = sample[sample.length - 1];
      if (nowMs - mostRecentFallback.timestamp.getTime() > MAX_STALE_FALLBACK_AGE_MS) {
        return { id: 'temperatureRollingAvg1h', value: null, confidence: 0 };
      }
    }

    const values = sample.map((r) => r.temperatureC as number);
    const value = values.reduce((sum, v) => sum + v, 0) / values.length;
    const confidence = recent.length > 0 ? 1 : 0.5;

    return { id: 'temperatureRollingAvg1h', value, confidence, meta: { windowHours: 1, sampleSize: sample.length } };
  },
};
