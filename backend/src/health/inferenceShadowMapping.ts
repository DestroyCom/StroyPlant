import type { DiagnosisFinding, FactDefinition, InferenceResult, SymptomRule } from '../inference/types.js';
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
export function collectMainDifferences(
  diagnoses: DiagnosisFinding[],
  factDefinitions: FactDefinition[],
  symptomRules: SymptomRule[],
): string[] {
  const notes = new Set<string>();

  for (const diagnosis of diagnoses) {
    for (const item of diagnosis.severityBreakdown.items) {
      if (item.contribution <= MIGRATION_NOTE_CONTRIBUTION_THRESHOLD) continue;

      const note =
        item.source.kind === 'fact'
          ? factDefinitions.find((fact) => fact.id === item.source.id)?.migrationNote
          : item.source.kind === 'symptom'
            ? symptomRules.find((symptom) => symptom.id === item.source.id)?.migrationNote
            : undefined;

      if (note) notes.add(note);
    }
  }

  return [...notes];
}
