import { factEvidence, indicatorEvidence } from '../adapters.js';
import { combineNoisyOr, combineWeightedEvidence, computeCoverage, sigmoid } from '../evidence.js';
import type { EvidenceItem, SymptomRule } from '../types.js';

// Temperature midpoint below which heat doesn't meaningfully add to water stress — an initial
// estimate (not derived from data), pending real-world recalibration per the spec's Calibration
// Layer section (deferred to a later increment, not built in this plan).
const HEAT_CONTRIBUTION_MIDPOINT_C = 28;
const HEAT_CONTRIBUTION_STEEPNESS = 0.3;

export const waterStress: SymptomRule = {
  id: 'water_stress',
  consumes: { facts: ['soil_moisture_below_profile_min', 'drying_rate_unusually_fast'], indicators: ['temperatureRollingAvg1h'] },
  evaluate(ctx) {
    const items: EvidenceItem[] = [
      factEvidence(ctx.facts, 'soil_moisture_below_profile_min', 0.5),
      factEvidence(ctx.facts, 'drying_rate_unusually_fast', 0.3),
      indicatorEvidence(ctx.indicators, 'temperatureRollingAvg1h', 0.2, (value) =>
        sigmoid(value, HEAT_CONTRIBUTION_MIDPOINT_C, HEAT_CONTRIBUTION_STEEPNESS),
      ),
    ];

    const { value: severity, breakdown: severityBreakdown } = combineWeightedEvidence(items);
    if (severity == null) return null;

    const { confidence, breakdown: confidenceBreakdown } = combineNoisyOr(items);
    const coverage = computeCoverage(items);

    return {
      id: 'water_stress',
      severity,
      confidence,
      coverage,
      supportingFacts: ['soil_moisture_below_profile_min', 'drying_rate_unusually_fast'],
      severityBreakdown,
      confidenceBreakdown,
    };
  },
};
