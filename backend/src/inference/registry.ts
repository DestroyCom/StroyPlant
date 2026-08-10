import { diagnosisRules } from './diagnoses/index.js';
import { InferenceEngine } from './engine.js';
import { factDefinitions } from './facts/index.js';
import { indicatorDefinitions } from './indicators/index.js';
import { recommendationRules } from './recommendations/index.js';
import { symptomRules } from './symptoms/index.js';

// The V1 vertical slice, fully wired. validateRegistry() runs inside the InferenceEngine
// constructor — an inconsistent registry fails at import time, not silently at request time.
export const inferenceEngine = new InferenceEngine(
  indicatorDefinitions,
  factDefinitions,
  symptomRules,
  diagnosisRules,
  recommendationRules,
);
