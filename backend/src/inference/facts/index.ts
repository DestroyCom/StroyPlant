import type { FactDefinition } from '../types.js';
import { dryingRateUnusuallyFast } from './dryingRateUnusuallyFast.js';
import { soilMoistureBelowProfileMin } from './soilMoistureBelowProfileMin.js';
import { wateringIntervalUnusuallyLong } from './wateringIntervalUnusuallyLong.js';

export const factDefinitions: FactDefinition[] = [soilMoistureBelowProfileMin, dryingRateUnusuallyFast, wateringIntervalUnusuallyLong];
