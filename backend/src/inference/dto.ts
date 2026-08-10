import type { InferenceResult } from './types.js';

export interface PlantHealthStatusDTO {
  diagnoses: Array<{ id: string; severity: number; confidence: number; tier: string }>;
  recommendations: Array<{ action: string; confidence: number }>;
}

// The only shape ever crossing an external boundary (tRPC/MQTT/MCP, all Phase C — out of this
// plan's scope). InferenceResult and EvidenceBreakdown never serialize directly, per the spec's
// "External representations" section.
export function toPlantHealthStatusDTO(result: InferenceResult): PlantHealthStatusDTO {
  return {
    diagnoses: result.diagnoses.map((d) => ({ id: d.id, severity: d.severity, confidence: d.confidence, tier: d.tier })),
    recommendations: result.recommendations.map((r) => ({ action: r.action, confidence: r.confidence })),
  };
}
