import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveReferenceProfile } from './referenceProfile.js';
import type { PlantProfile } from '@prisma/client';

function fakePlantProfile(overrides: Partial<PlantProfile> = {}): PlantProfile {
  return {
    id: 1,
    name: 'Test Plant',
    commonName: null,
    soilMoistureMinPercent: null,
    soilMoistureMaxPercent: null,
    soilConductivityMinUsCm: null,
    soilConductivityMaxUsCm: null,
    soilPhMin: null,
    soilPhMax: null,
    temperatureMinC: null,
    temperatureMaxC: null,
    humidityMinPercent: null,
    humidityMaxPercent: null,
    lightMinLux: null,
    lightMaxLux: null,
    lightMinMmol: null,
    lightMaxMmol: null,
    ...overrides,
  };
}

describe('resolveReferenceProfile', () => {
  it('maps soil moisture and temperature ranges directly', () => {
    const profile = fakePlantProfile({ soilMoistureMinPercent: 15, soilMoistureMaxPercent: 60, temperatureMinC: 12, temperatureMaxC: 32 });
    const resolved = resolveReferenceProfile(profile, null);
    assert.deepEqual(resolved.soilMoisturePercent, { min: 15, max: 60 });
    assert.deepEqual(resolved.temperatureC, { min: 12, max: 32 });
  });

  it('omits a range entirely when both bounds are null', () => {
    const resolved = resolveReferenceProfile(fakePlantProfile(), null);
    assert.equal(resolved.soilMoisturePercent, undefined);
    assert.equal(resolved.temperatureC, undefined);
  });
});
