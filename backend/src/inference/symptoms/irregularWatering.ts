import { factEvidence } from '../adapters.js';
import { combineNoisyOr, combineWeightedEvidence, computeCoverage } from '../evidence.js';
import type { EvidenceItem, SymptomRule } from '../types.js';

export const irregularWatering: SymptomRule = {
  id: 'irregular_watering',
  consumes: { facts: ['watering_interval_unusually_long'], indicators: [] },
  evaluate(ctx) {
    const items: EvidenceItem[] = [factEvidence(ctx.facts, 'watering_interval_unusually_long', 1)];

    const { value: severity, breakdown: severityBreakdown } = combineWeightedEvidence(items);
    if (severity == null) return null;

    const { confidence, breakdown: confidenceBreakdown } = combineNoisyOr(items);
    const coverage = computeCoverage(items);

    return {
      id: 'irregular_watering',
      severity,
      confidence,
      coverage,
      supportingFacts: ['watering_interval_unusually_long'],
      severityBreakdown,
      confidenceBreakdown,
    };
  },
};
