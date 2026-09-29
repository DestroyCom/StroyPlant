import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPlantAdvice,
  daysCoveredForReadings,
  estimateDaysUntilWatering,
  hoursUntilDayEnd,
  warmupHoursRemaining,
} from './plantAdvice.js';
import type { DeviceHealth } from './scoring.js';

describe('daysCoveredForReadings', () => {
  it('returns 0 for no readings', () => {
    assert.equal(daysCoveredForReadings([]), 0);
  });

  it('returns days since the oldest reading, not the newest', () => {
    const now = Date.now();
    const readings = [{ timestamp: new Date(now - 5 * 24 * 3600_000) }, { timestamp: new Date(now - 1 * 24 * 3600_000) }];
    const days = daysCoveredForReadings(readings);
    assert.ok(days > 4.9 && days < 5.1, `expected ~5 days, got ${days}`);
  });
});

describe('warmupHoursRemaining', () => {
  it('is 0 once daysCovered meets warmupMinDays', () => {
    assert.equal(warmupHoursRemaining(3, 3), 0);
    assert.equal(warmupHoursRemaining(10, 3), 0);
  });

  it('returns the exact remaining hours before that', () => {
    assert.equal(warmupHoursRemaining(1, 3), 48);
    assert.equal(warmupHoursRemaining(2.5, 3), 12);
  });
});

describe('hoursUntilDayEnd', () => {
  it('returns close to 24 just after local midnight', () => {
    const justAfterMidnightUtc = new Date('2026-01-01T00:00:30Z');
    const hours = hoursUntilDayEnd(justAfterMidnightUtc, 'UTC');
    assert.ok(hours > 23.9 && hours <= 24, `expected ~24h, got ${hours}`);
  });

  it('returns close to 0 just before local midnight', () => {
    const justBeforeMidnightUtc = new Date('2026-01-01T23:59:30Z');
    const hours = hoursUntilDayEnd(justBeforeMidnightUtc, 'UTC');
    assert.ok(hours >= 0 && hours < 0.1, `expected ~0h, got ${hours}`);
  });

  it('respects a non-UTC timezone', () => {
    // 22:30 UTC = 23:30 in Europe/Paris (UTC+1 in January) — 30 minutes left in the Paris day.
    const date = new Date('2026-01-01T22:30:00Z');
    const hours = hoursUntilDayEnd(date, 'Europe/Paris');
    assert.ok(hours > 0.4 && hours < 0.6, `expected ~0.5h, got ${hours}`);
  });
});

describe('estimateDaysUntilWatering', () => {
  it('returns null with fewer than 2 points in the window', () => {
    assert.equal(estimateDaysUntilWatering([{ timestamp: new Date(), soilMoisturePercent: 40 }], 20), null);
  });

  it('returns null when moisture is not decreasing', () => {
    const now = Date.now();
    const readings = [
      { timestamp: new Date(now - 4 * 24 * 3600_000), soilMoisturePercent: 30 },
      { timestamp: new Date(now - 2 * 24 * 3600_000), soilMoisturePercent: 32 },
      { timestamp: new Date(now), soilMoisturePercent: 35 },
    ];
    assert.equal(estimateDaysUntilWatering(readings, 20), null);
  });

  it('projects a plausible number of days for a clean linear decline', () => {
    // Drops 2%/day; currently at 40%, threshold 20% → ~10 days away.
    const now = Date.now();
    const readings = [
      { timestamp: new Date(now - 4 * 24 * 3600_000), soilMoisturePercent: 48 },
      { timestamp: new Date(now - 3 * 24 * 3600_000), soilMoisturePercent: 46 },
      { timestamp: new Date(now - 2 * 24 * 3600_000), soilMoisturePercent: 44 },
      { timestamp: new Date(now - 1 * 24 * 3600_000), soilMoisturePercent: 42 },
      { timestamp: new Date(now), soilMoisturePercent: 40 },
    ];
    const days = estimateDaysUntilWatering(readings, 20);
    assert.ok(days != null && days > 8 && days < 12, `expected ~10 days, got ${days}`);
  });

  it('ignores readings outside the prediction window', () => {
    const now = Date.now();
    const readings = [
      { timestamp: new Date(now - 30 * 24 * 3600_000), soilMoisturePercent: 90 }, // way outside the 5-day window
      { timestamp: new Date(now - 1 * 24 * 3600_000), soilMoisturePercent: 40 },
      { timestamp: new Date(now), soilMoisturePercent: 38 },
    ];
    // Only the last 2 points (both inside the window) should drive the slope — a real decline.
    const days = estimateDaysUntilWatering(readings, 20);
    assert.ok(days != null, 'expected a prediction from the 2 in-window points alone');
  });
});

function fakeReading(
  overrides: Partial<{
    timestamp: Date;
    soilMoisturePercent: number | null;
    waterTankLevelPercent: number | null;
    temperatureC: number | null;
    isInAir: boolean | null;
  }> = {},
) {
  return {
    id: 1,
    deviceId: 'TEST',
    timestamp: new Date(),
    soilMoisturePercent: null,
    temperatureC: null,
    luminosity: null,
    waterTankLevelPercent: null,
    soilConductivityUsCm: null,
    isDrySoil: null,
    isWetSoil: null,
    isEmptyTank: null,
    isInAir: null,
    humidityPercent: null,
    batteryPercent: null,
    source: 'POLL' as const,
    rawSensorLog: null,
    ...overrides,
  };
}

const NO_PROFILE_HEALTH: DeviceHealth = {
  status: 'no_profile',
  parameters: {},
  trend: 'unknown',
  warningParameters: [],
  luminosityRecentDaysTooLow: false,
};

describe('buildPlantAdvice — water', () => {
  it('is null for a Xiaomi device (no soil probe)', () => {
    const advice = buildPlantAdvice({ kind: 'XIAOMI_LYWSD03MMC', environment: null }, [], NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.equal(advice.water, null);
  });

  it('shows raw values with no status when no species is assigned', () => {
    const readings = [fakeReading({ soilMoisturePercent: 42, waterTankLevelPercent: 80 })];
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, readings, NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.deepEqual(advice.water, {
      kind: 'raw_no_profile',
      autoWateringActive: false,
      soilMoisturePercent: 42,
      waterTankLevelPercent: 80,
    });
  });

  it('reports too_low with the species threshold', () => {
    const readings = [fakeReading({ soilMoisturePercent: 15, waterTankLevelPercent: 60 })];
    const health: DeviceHealth = {
      status: 'warning',
      parameters: {
        soilMoisturePercent: { value: 15, status: 'too_low', speciesRange: [20, 60], personalDeviation: 'normal', liveValue: null },
      },
      trend: 'unknown',
      warningParameters: ['soilMoisturePercent'],
      luminosityRecentDaysTooLow: false,
    };
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, readings, health, 3, 'UTC', []);
    assert.equal(advice.water?.kind, 'too_low');
    assert.equal(advice.water?.minPercent, 20);
  });

  it('carries the caller-resolved auto-watering flag, defaulting to false', () => {
    const readings = [fakeReading({ soilMoisturePercent: 40, waterTankLevelPercent: 60 })];
    const health: DeviceHealth = {
      status: 'ok',
      parameters: {
        soilMoisturePercent: { value: 40, status: 'ok', speciesRange: [20, 60], personalDeviation: 'normal', liveValue: null },
      },
      trend: 'unknown',
      warningParameters: [],
      luminosityRecentDaysTooLow: false,
    };
    const device = { kind: 'PARROT_POT', environment: null } as const;
    assert.equal(buildPlantAdvice(device, readings, health, 3, 'UTC', []).water?.autoWateringActive, false);
    assert.equal(buildPlantAdvice(device, readings, health, 3, 'UTC', [], true).water?.autoWateringActive, true);
  });
});

describe('buildPlantAdvice — temperature', () => {
  it('shows the raw value with no comparison on a Xiaomi device (no species assignment possible)', () => {
    const readings = [fakeReading({ temperatureC: 21 })];
    const advice = buildPlantAdvice({ kind: 'XIAOMI_LYWSD03MMC', environment: null }, readings, NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.deepEqual(advice.temperature, { kind: 'raw_no_species_support', isOutdoor: false, temperatureC: 21 });
  });

  it('shows no_plant on a Parrot Pot with no species assigned', () => {
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, [], NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.equal(advice.temperature?.kind, 'no_plant');
  });

  it('shows soon_available with a real countdown while the device is warming up', () => {
    const readings = [fakeReading({ timestamp: new Date(Date.now() - 24 * 3600_000), temperatureC: 21 })];
    const health: DeviceHealth = {
      status: 'warming_up',
      parameters: { temperatureC: { value: 21, status: 'ok', speciesRange: [15, 25], personalDeviation: 'normal', liveValue: null } },
      trend: 'unknown',
      warningParameters: [],
      luminosityRecentDaysTooLow: false,
    };
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, readings, health, 3, 'UTC', []);
    assert.equal(advice.temperature?.kind, 'soon_available');
    assert.ok(advice.temperature && advice.temperature.hoursRemaining! > 40 && advice.temperature.hoursRemaining! < 50);
  });
});

describe('buildPlantAdvice — fertilizer', () => {
  it('is null for a Xiaomi device', () => {
    const advice = buildPlantAdvice({ kind: 'XIAOMI_LYWSD03MMC', environment: null }, [], NO_PROFILE_HEALTH, 3, 'UTC', []);
    assert.equal(advice.fertilizer, null);
  });

  it('carries the species type labels for too_low', () => {
    const health: DeviceHealth = {
      status: 'warning',
      parameters: {
        soilConductivityUsCm: { value: 100, status: 'too_low', speciesRange: [500, 2000], personalDeviation: 'normal', liveValue: null },
      },
      trend: 'unknown',
      warningParameters: [],
      luminosityRecentDaysTooLow: false,
    };
    const advice = buildPlantAdvice({ kind: 'PARROT_POT', environment: null }, [], health, 3, 'UTC', ['Rose', 'Tomate']);
    assert.equal(advice.fertilizer?.kind, 'too_low');
    assert.deepEqual(advice.fertilizer?.typeLabels, ['Rose', 'Tomate']);
  });
});
