import type { SymptomRule } from '../types.js';
import { irregularWatering } from './irregularWatering.js';
import { waterStress } from './waterStress.js';

export const symptomRules: SymptomRule[] = [waterStress, irregularWatering];
