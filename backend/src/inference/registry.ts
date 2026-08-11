// Before wiring a real consumer (tRPC/MQTT/MCP/scheduler) to inferenceEngine: AvailabilityReason
// (types.ts) is threaded through Indicators only (IndicatorValue.unavailableReason), not yet
// through Facts/Symptoms/Diagnoses — a deliberate scope cut made by the 2026-08-10 Phase A
// hardening pass (docs/superpowers/specs/2026-08-10-inference-engine-phase-a-hardening-design.md),
// not an oversight; nothing downstream consumes evidenceBreakdown.missing at the Fact/Symptom/
// Diagnosis level yet. The other 3 findings that same pass identified (no clock injection, no
// staleness bound on the rolling-average fallback, hardcoded-UTC day bucketing) are resolved.
// Also: the Phase C adapter must populate EnvironmentContext.timezone from the real
// HealthSettings.timezone row — omitting it silently falls back to 'UTC' with no test failure to
// catch the regression.
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
