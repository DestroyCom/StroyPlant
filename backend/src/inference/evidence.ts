import type { EvidenceBreakdown, EvidenceContribution, EvidenceCoverage, EvidenceItem } from './types.js';

export function computeCoverage(items: EvidenceItem[]): EvidenceCoverage {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  const availableWeight = items.filter((item) => item.strength != null).reduce((sum, item) => sum + item.weight, 0);
  return { availableWeight, totalWeight, ratio: totalWeight === 0 ? 0 : availableWeight / totalWeight };
}

function missingFrom(items: EvidenceItem[]): EvidenceBreakdown['missing'] {
  return items
    .filter((item) => item.strength == null)
    .map((item) => ({ source: item.source, reason: item.missingReason ?? 'sensor_absent' }));
}

export function combineWeightedEvidence(items: EvidenceItem[]): { value: number | null; breakdown: EvidenceBreakdown } {
  const available = items.filter((item) => item.strength != null);
  const totalWeight = available.reduce((sum, item) => sum + item.weight, 0);

  const contributions: EvidenceContribution[] = items.map((item) => {
    if (item.strength == null || totalWeight === 0) return { ...item, contribution: 0 };
    return { ...item, contribution: (item.weight / totalWeight) * item.strength };
  });

  const value = totalWeight === 0 ? null : contributions.reduce((sum, contribution) => sum + contribution.contribution, 0);

  return { value, breakdown: { formula: 'weightedAverage', items: contributions, missing: missingFrom(items) } };
}

export function combineNoisyOr(items: EvidenceItem[]): { confidence: number; breakdown: EvidenceBreakdown } {
  let positiveComplement = 1;
  let negativeComplement = 1;

  const contributions: EvidenceContribution[] = items.map((item) => {
    if (item.strength == null) return { ...item, contribution: 0 };
    const effectiveConfidence = item.confidence ?? 1;
    const contribution = item.weight * item.strength * effectiveConfidence;
    if (item.polarity === 'supports') positiveComplement *= 1 - contribution;
    else negativeComplement *= 1 - contribution;
    return { ...item, contribution };
  });

  const positive = 1 - positiveComplement;
  const negative = 1 - negativeComplement;
  const confidence = positive * (1 - negative);

  return { confidence, breakdown: { formula: 'noisyOr', items: contributions, missing: missingFrom(items) } };
}

// Standard logistic sigmoid, centered at `midpoint`. Used by Symptom/Diagnosis rules to turn a
// continuous Indicator value into a 0..1 strength (e.g. "how much does this temperature contribute
// to water stress"), per the spec's Symptoms section.
export function sigmoid(value: number, midpoint: number, steepness: number): number {
  return 1 / (1 + Math.exp(-steepness * (value - midpoint)));
}
