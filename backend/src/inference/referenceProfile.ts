import type { Device, PlantProfile } from '@prisma/client';
import type { Range, ReferenceProfile } from './types.js';

function rangeOrUndefined(min: number | null, max: number | null): Range | undefined {
  return min != null || max != null ? { min, max } : undefined;
}

// The ONLY file under backend/src/inference/ allowed to import PlantProfile — enforced by
// Task 18's CI check. Maps only the fields the V1 vertical slice's Facts/Symptoms actually
// consume (soilMoisturePercent, temperatureC). humidityPercent/luminosityMmolPerDay/
// soilConductivityUsCm — and any indoor-luminosity floor adjustment — are added here only once a
// Fact/Symptom in a later slice actually needs them (YAGNI), not preemptively. The `0;0` →
// null;null CSV-import convention (docs/HEALTH_ENGINE.md) is already applied upstream by
// importSpeciesProfiles.ts, so this function does not need to re-handle it.
export function resolveReferenceProfile(plantProfile: PlantProfile, _environment: Device['environment']): ReferenceProfile {
  return {
    soilMoisturePercent: rangeOrUndefined(plantProfile.soilMoistureMinPercent, plantProfile.soilMoistureMaxPercent),
    temperatureC: rangeOrUndefined(plantProfile.temperatureMinC, plantProfile.temperatureMaxC),
  };
}
