import type { DiagnosisFinding, EvidenceItem, FactSnapshot, IndicatorIndex, SymptomSnapshot } from './types.js';

type Polarity = 'supports' | 'contradicts';

export function factEvidence(facts: FactSnapshot, factId: string, weight: number, polarity: Polarity = 'supports'): EvidenceItem {
  const fact = facts.get(factId);
  return {
    source: { kind: 'fact', id: factId },
    weight,
    strength: fact ? (fact.holds ? 1 : 0) : null,
    confidence: fact?.confidence ?? null,
    polarity,
  };
}

export function indicatorEvidence(
  indicators: IndicatorIndex,
  indicatorId: string,
  weight: number,
  toStrength: (value: number) => number,
  polarity: Polarity = 'supports',
): EvidenceItem {
  const indicator = indicators.get(indicatorId);
  const strength = indicator && indicator.value != null ? toStrength(indicator.value) : null;
  return {
    source: { kind: 'indicator', id: indicatorId },
    weight,
    strength,
    confidence: indicator?.confidence ?? null,
    polarity,
    // undefined both when the indicator was never computed at all (capability-gated-out) and when
    // it was computed but didn't set its own reason — either way, evidence.ts's missingFrom()
    // falls back to 'sensor_absent', which is correct for the former case and shouldn't occur for
    // the latter now that every registered Indicator sets this field on every null path.
    missingReason: indicator?.unavailableReason,
  };
}

export function symptomEvidence(
  symptoms: SymptomSnapshot,
  symptomId: string,
  weight: number,
  polarity: Polarity = 'supports',
): EvidenceItem {
  const symptom = symptoms.get(symptomId);
  return {
    source: { kind: 'symptom', id: symptomId },
    weight,
    strength: symptom ? symptom.severity : null,
    confidence: symptom?.confidence ?? null,
    polarity,
  };
}

export function diagnosisEvidence(diagnosis: DiagnosisFinding, weight: number, polarity: Polarity = 'supports'): EvidenceItem {
  return {
    source: { kind: 'diagnosis', id: diagnosis.id },
    weight,
    strength: diagnosis.confidence,
    confidence: diagnosis.confidence,
    polarity,
  };
}

export function operationalEvidence(id: string, active: boolean, weight: number, polarity: Polarity = 'supports'): EvidenceItem {
  return {
    source: { kind: 'operational', id },
    weight,
    strength: active ? 1 : 0,
    confidence: 1,
    polarity,
  };
}
