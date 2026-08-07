import type { Reading, WateringEvent } from '@prisma/client';

let nextId = 1;

export function fakeReading(overrides: Partial<Reading> = {}): Reading {
  return {
    id: nextId++,
    deviceId: 'TEST-DEVICE',
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
    source: 'POLL',
    ...overrides,
  };
}

export function fakeWateringEvent(overrides: Partial<WateringEvent> = {}): WateringEvent {
  return {
    id: nextId++,
    deviceId: 'TEST-DEVICE',
    timestamp: new Date(),
    triggerSource: 'MANUAL',
    success: true,
    errorDetail: null,
    ...overrides,
  };
}
