import type { IndicatorDefinition } from '../types.js';
import { dryingRateDeviationSigma } from './dryingRateDeviationSigma.js';
import { soilMoistureRollingAvg1h } from './soilMoistureRollingAvg1h.js';
import { temperatureRollingAvg1h } from './temperatureRollingAvg1h.js';
import { wateringIntervalDeviationSigma } from './wateringIntervalDeviationSigma.js';

export const indicatorDefinitions: IndicatorDefinition[] = [
  soilMoistureRollingAvg1h,
  temperatureRollingAvg1h,
  dryingRateDeviationSigma,
  wateringIntervalDeviationSigma,
];
