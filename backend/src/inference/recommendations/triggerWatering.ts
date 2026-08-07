import { diagnosisEvidence, operationalEvidence } from '../adapters.js';
import { combineNoisyOr } from '../evidence.js';
import type { EvidenceItem, RecommendationRule } from '../types.js';

export const triggerWatering: RecommendationRule = {
  id: 'trigger_watering',
  triggers: ['chronic_underwatering'],
  evaluate(diagnosis, ctx) {
    const items: EvidenceItem[] = [
      diagnosisEvidence(diagnosis, 1),
      operationalEvidence('cooldown_active', ctx.operationalConstraints.cooldownActive, 1, 'contradicts'),
    ];

    const { confidence, breakdown } = combineNoisyOr(items);

    return { action: 'TRIGGER_WATERING', urgency: 'action_needed', confidence, triggeredBy: diagnosis.id, evidenceBreakdown: breakdown };
  },
};
