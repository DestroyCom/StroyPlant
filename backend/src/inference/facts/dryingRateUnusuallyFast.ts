import type { FactDefinition } from '../types.js';

const SIGNIFICANT_SIGMA = 2;

export const dryingRateUnusuallyFast: FactDefinition = {
  id: 'drying_rate_unusually_fast',
  needsProfile: false,
  requiredIndicators: ['dryingRateDeviationSigma'],
  migrationNote: 'Prend en compte la vitesse de séchage du sol, absente du calcul historique.',
  evaluate(indicators) {
    const indicator = indicators.get('dryingRateDeviationSigma');
    if (!indicator || indicator.value == null) return null;

    return {
      id: 'drying_rate_unusually_fast',
      holds: indicator.value > SIGNIFICANT_SIGMA,
      confidence: indicator.confidence,
      supportingIndicators: ['dryingRateDeviationSigma'],
      evidence: { sigma: indicator.value },
    };
  },
};
