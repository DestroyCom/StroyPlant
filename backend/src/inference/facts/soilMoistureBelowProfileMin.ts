import type { FactDefinition } from '../types.js';

export const soilMoistureBelowProfileMin: FactDefinition = {
  id: 'soil_moisture_below_profile_min',
  needsProfile: true,
  requiredIndicators: ['soilMoistureRollingAvg1h'],
  evaluate(indicators, profile) {
    const indicator = indicators.get('soilMoistureRollingAvg1h');
    const min = profile?.soilMoisturePercent?.min;
    if (!indicator || indicator.value == null || min == null) return null;

    return {
      id: 'soil_moisture_below_profile_min',
      holds: indicator.value < min,
      confidence: indicator.confidence,
      supportingIndicators: ['soilMoistureRollingAvg1h'],
      evidence: { currentValue: indicator.value, minimumExpected: min },
    };
  },
};
