// Known follow-up before wiring a real consumer (tRPC/MQTT/MCP/scheduler) to inferenceEngine —
// all deferred together since they share one root cause (the engine's real-time/data-availability
// boundary is thin because nothing consumes it yet) and carry zero risk while unwired:
// 1. AvailabilityReason (types.ts) is never actually set by any adapter — EvidenceBreakdown.missing
//    always reports 'sensor_absent' regardless of the real reason (offline vs. never-existed).
// 2. No clock injection: all 4 indicators call Date.now()/new Date() directly, so the pipeline is
//    not replayable/reproducible against the same historical readings — contradicts the RFC's
//    stated reason for not persisting the full evidence tree.
// 3. The two rolling-average indicators' stale-data fallback (last 5 readings) has no age bound —
//    a device offline for months can still produce a confident-enough value that reaches
//    TRIGGER_WATERING.
// 4. dryingRateDeviationSigma buckets days in hardcoded UTC (not the device's configured timezone,
//    unlike the rest of this codebase's convention, e.g. health/dailyLightIntegral.ts's
//    HealthSettings.timezone) — a ~2h/day blind spot right after UTC midnight where the "today"
//    bucket can't span the minimum window.
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
