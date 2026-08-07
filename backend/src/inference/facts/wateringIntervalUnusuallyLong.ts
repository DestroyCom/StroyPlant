import type { FactDefinition } from '../types.js';

const SIGNIFICANT_SIGMA = 2;

export const wateringIntervalUnusuallyLong: FactDefinition = {
  id: 'watering_interval_unusually_long',
  needsProfile: false,
  requiredIndicators: ['wateringIntervalDeviationSigma'],
  evaluate(indicators) {
    const indicator = indicators.get('wateringIntervalDeviationSigma');
    if (!indicator || indicator.value == null) return null;

    return {
      id: 'watering_interval_unusually_long',
      holds: indicator.value > SIGNIFICANT_SIGMA,
      confidence: indicator.confidence,
      supportingIndicators: ['wateringIntervalDeviationSigma'],
      evidence: { sigma: indicator.value },
    };
  },
};
