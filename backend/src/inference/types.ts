import type { Device, Reading, WateringEvent } from '@prisma/client';

// Re-exported so downstream inference files (e.g. engine.ts's FIELD_TO_CAPABILITY map) can
// reference `keyof Reading` without importing directly from '@prisma/client' themselves.
export type { Reading };

export type FactId = string;
export type IndicatorId = string;
export type SymptomId = string;
export type DiagnosisId = string;
export type RecommendationAction = string;

export type AvailabilityReason = 'sensor_absent' | 'no_recent_data' | 'insufficient_history';

export type DeviceCapabilities = ('soilMoisture' | 'temperature' | 'luminosity' | 'conductivity' | 'humidity')[];

export interface EnvironmentContext {
  deviceKind: Device['kind'];
  environment: Device['environment'];
  capabilities: DeviceCapabilities;
  observationsAvailability: Record<string, AvailabilityReason | 'available'>;
}

export interface DeviceObservations {
  readings: Reading[];
  wateringEvents: WateringEvent[];
}

export interface Range {
  min: number | null;
  max: number | null;
}

export interface ReferenceProfile {
  soilMoisturePercent?: Range;
  temperatureC?: Range;
  humidityPercent?: Range;
  luminosityMmolPerDay?: Range;
  soilConductivityUsCm?: Range;
}

export interface IndicatorValue<T = number> {
  id: IndicatorId;
  value: T | null;
  confidence: number;
  meta?: { windowHours?: number; sampleSize?: number; trend?: 'improving' | 'stable' | 'degrading'; [key: string]: unknown };
}

export interface IndicatorDefinition {
  id: IndicatorId;
  requiredFields: (keyof Reading)[];
  compute(observations: DeviceObservations, environment: EnvironmentContext): IndicatorValue;
}

export type IndicatorIndex = Map<IndicatorId, IndicatorValue>;

export interface FactResult {
  id: FactId;
  holds: boolean;
  confidence: number;
  supportingIndicators: IndicatorId[];
  evidence?: Record<string, unknown>;
}

export interface FactDefinition {
  id: FactId;
  needsProfile: boolean;
  requiredIndicators: IndicatorId[];
  evaluate(indicators: IndicatorIndex, profile: ReferenceProfile | null): FactResult | null;
}

export type FactSnapshot = Map<FactId, FactResult>;

export interface EvidenceCoverage {
  availableWeight: number;
  totalWeight: number;
  ratio: number;
}

export type EvidenceSource =
  | { kind: 'fact'; id: FactId }
  | { kind: 'indicator'; id: IndicatorId }
  | { kind: 'symptom'; id: SymptomId }
  | { kind: 'diagnosis'; id: DiagnosisId }
  | { kind: 'operational'; id: string };

export interface EvidenceItem {
  source: EvidenceSource;
  weight: number;
  strength: number | null;
  confidence: number | null;
  polarity: 'supports' | 'contradicts';
  // Not in the original spec's EvidenceItem — added here because EvidenceBreakdown.missing needs a
  // reason per missing item, and only the adapter constructing the item knows why it's missing.
  // Defaults to 'sensor_absent' if omitted (see evidence.ts).
  missingReason?: AvailabilityReason;
}

export interface EvidenceContribution extends EvidenceItem {
  contribution: number;
}

export interface EvidenceBreakdown {
  formula: 'weightedAverage' | 'noisyOr';
  items: EvidenceContribution[];
  missing: Array<{ source: EvidenceSource; reason: AvailabilityReason }>;
}

export interface SymptomResult {
  id: SymptomId;
  severity: number;
  confidence: number;
  coverage: EvidenceCoverage;
  supportingFacts: FactId[];
  evidenceBreakdown: EvidenceBreakdown;
}

export interface SymptomRule {
  id: SymptomId;
  requiredFacts?: FactId[];
  consumes: { facts: FactId[]; indicators: IndicatorId[] };
  evaluate(ctx: InferenceContext): SymptomResult | null;
}

export type SymptomSnapshot = Map<SymptomId, SymptomResult>;

export interface DiagnosisFinding {
  id: DiagnosisId;
  severity: number;
  confidence: number;
  coverage: EvidenceCoverage;
  tier: 'dominant' | 'secondary' | 'weak_hypothesis';
  evidenceBreakdown: EvidenceBreakdown;
}

export interface DiagnosisRule {
  id: DiagnosisId;
  consumes: { symptoms: SymptomId[] };
  evaluate(ctx: InferenceContext & { symptoms: SymptomSnapshot }): Omit<DiagnosisFinding, 'tier'> | null;
}

export type DiagnosisSnapshot = Map<DiagnosisId, DiagnosisFinding>;

export interface OperationalConstraints {
  autoWateringEnabled: boolean;
  withinAllowedWindow: boolean;
  cooldownActive: boolean;
}

export interface RecommendationResult {
  action: RecommendationAction;
  urgency: 'info' | 'advisory' | 'action_needed';
  confidence: number;
  triggeredBy: DiagnosisId;
  evidenceBreakdown: EvidenceBreakdown;
}

export interface RecommendationRule {
  id: string;
  triggers: DiagnosisId[];
  evaluate(
    diagnosis: DiagnosisFinding,
    ctx: InferenceContext & { operationalConstraints: OperationalConstraints },
  ): RecommendationResult | null;
}

export interface Recommendation {
  action: RecommendationAction;
  urgency: 'info' | 'advisory' | 'action_needed';
  confidence: number;
  triggeredBy: DiagnosisId[];
  importance: number;
}

export type PlantState = unknown;

export interface InferenceContext {
  indicators: IndicatorIndex;
  facts: FactSnapshot;
  plantState?: PlantState | null;
  environment: EnvironmentContext;
}

export interface InferenceResult {
  indicators: IndicatorIndex;
  facts: FactSnapshot;
  symptoms: SymptomSnapshot;
  diagnoses: DiagnosisFinding[];
  recommendations: Recommendation[];
}
