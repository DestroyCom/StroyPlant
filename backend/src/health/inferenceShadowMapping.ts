import type {
  DiagnosisFinding,
  EvidenceContribution,
  FactDefinition,
  InferenceResult,
  SymptomRule,
  SymptomSnapshot,
} from '../inference/types.js';
import type { DeviceHealth } from './scoring.js';

const WARNING_TIERS = new Set<DiagnosisFinding['tier']>(['dominant', 'secondary']);

// The RFC's migration adapter (Phase B), scoped to the one field the shadow comparison actually
// needs — DeviceHealth.status. A weak_hypothesis-tier diagnosis doesn't count as a real
// disagreement (the engine itself doesn't treat it as a confident finding), matching how the
// dashboard would eventually treat tiers once Phase C wires a real consumer.
export function toLegacyDeviceHealth(inferenceResult: InferenceResult): Pick<DeviceHealth, 'status'> {
  const hasWarningDiagnosis = inferenceResult.diagnoses.some((diagnosis) => WARNING_TIERS.has(diagnosis.tier));
  return { status: hasWarningDiagnosis ? 'warning' : 'ok' };
}

// An initial engineering estimate (not derived from real data) — an evidence item contributing
// less than this to a diagnosis's severity is not "meaningfully" explaining a divergence. Same
// convention as this codebase's other initial-estimate constants (e.g.
// MINIMUM_REPORTABLE_IMPORTANCE in inference/engine.ts).
const MIGRATION_NOTE_CONTRIBUTION_THRESHOLD = 0.05;

// Walks every diagnosis's severityBreakdown for evidence items that meaningfully contributed
// (contribution above the threshold) and are sourced from a Fact or Symptom carrying a
// migrationNote — collecting those notes to explain, in human terms, what the new engine
// considered that the legacy one didn't. Only fact/symptom-sourced items are considered:
// indicators have no migrationNote slot (they're raw measurements, not horticultural reasoning).
//
// A symptom-sourced item is also descended into: the only registered Diagnosis
// (chronic_underwatering) consumes only Symptoms, so every Fact-sourced evidence item actually
// lives one level deeper, inside each Symptom's OWN severityBreakdown — never walked otherwise.
// A weak_hypothesis-tier diagnosis is excluded entirely (same WARNING_TIERS filter as
// toLegacyDeviceHealth above) — it isn't a real disagreement, so its evidence shouldn't be
// surfaced as an explanation for one.
export function collectMainDifferences(
  diagnoses: DiagnosisFinding[],
  symptoms: SymptomSnapshot,
  factDefinitions: FactDefinition[],
  symptomRules: SymptomRule[],
): string[] {
  const notes = new Set<string>();

  function collectFromItems(items: EvidenceContribution[]): void {
    for (const item of items) {
      if (item.contribution <= MIGRATION_NOTE_CONTRIBUTION_THRESHOLD) continue;

      if (item.source.kind === 'fact') {
        const note = factDefinitions.find((fact) => fact.id === item.source.id)?.migrationNote;
        if (note) notes.add(note);
      } else if (item.source.kind === 'symptom') {
        const symptomRule = symptomRules.find((symptom) => symptom.id === item.source.id);
        if (symptomRule?.migrationNote) notes.add(symptomRule.migrationNote);
        // Descend one more level: this Symptom's own evidence may cite Facts with their own notes.
        const symptomResult = symptoms.get(item.source.id);
        if (symptomResult) collectFromItems(symptomResult.severityBreakdown.items);
      }
    }
  }

  for (const diagnosis of diagnoses) {
    if (!WARNING_TIERS.has(diagnosis.tier)) continue;
    collectFromItems(diagnosis.severityBreakdown.items);
  }

  return [...notes];
}
