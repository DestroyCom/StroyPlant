import { symptomEvidence } from '../adapters.js';
import { combineNoisyOr, combineWeightedEvidence, computeCoverage } from '../evidence.js';
import type { DiagnosisRule, EvidenceItem } from '../types.js';

export const chronicUnderwatering: DiagnosisRule = {
  id: 'chronic_underwatering',
  consumes: { symptoms: ['water_stress', 'irregular_watering'] },
  evaluate(ctx) {
    const items: EvidenceItem[] = [
      symptomEvidence(ctx.symptoms, 'water_stress', 0.65),
      symptomEvidence(ctx.symptoms, 'irregular_watering', 0.35),
    ];

    const { value: severity, breakdown: severityBreakdown } = combineWeightedEvidence(items);
    if (severity == null) return null;

    const { confidence, breakdown: confidenceBreakdown } = combineNoisyOr(items);
    const coverage = computeCoverage(items);

    return { id: 'chronic_underwatering', severity, confidence, coverage, severityBreakdown, confidenceBreakdown };
  },
};
