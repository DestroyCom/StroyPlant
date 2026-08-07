import type { RecommendationRule } from '../types.js';
import { triggerWatering } from './triggerWatering.js';

export const recommendationRules: RecommendationRule[] = [triggerWatering];
