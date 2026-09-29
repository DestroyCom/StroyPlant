import type { Device } from '@prisma/client';
import type { DeviceHealth } from './scoring.js';
import type { ReadingWithRawLog } from './soilConductivityCalibration.js';

// Window used for the linear-regression watering-date prediction (spec section 7) — deliberately
// short: a device's drying rate can change quickly (weather, a recent watering), a longer window
// would smooth over exactly the recent behavior this prediction needs to reflect.
export const WATERING_PREDICTION_WINDOW_DAYS = 5;
// Sanity cap — an almost-flat but still-technically-negative slope can otherwise project an
// absurd number of days; nothing genuinely useful to say past this, and Parrot's own UI never
// shows a number this large either.
export const MAX_WATERING_PREDICTION_DAYS = 60;

// Mirrors health/scoring.ts's own `daysCovered` computation (oldest reading vs. now) — deliberately
// duplicated rather than imported: this module must stay independent of computeDeviceHealth's
// internals (only its OUTPUT, DeviceHealth, is a dependency — see plantAdvice.ts's buildPlantAdvice).
export function daysCoveredForReadings(readings: Array<{ timestamp: Date }>): number {
  if (readings.length === 0) return 0;
  const oldest = readings.reduce((min, r) => (r.timestamp < min ? r.timestamp : min), readings[0].timestamp);
  return (Date.now() - oldest.getTime()) / (24 * 3600_000);
}

// Hours left before the device-wide warmup gate (HealthSettings.warmupMinDays) clears — the {time}
// placeholder in Parrot's temperature_soon_available_timed/light_soon_available_title_timed strings.
export function warmupHoursRemaining(daysCovered: number, warmupMinDays: number): number {
  return Math.max(0, (warmupMinDays - daysCovered) * 24);
}

// Hours remaining until the current calendar day (in `timezone`) ends — used for the light card's
// own "soon_available" reason when the global warmup has already cleared but Part H's separate
// zero-complete-days gate hasn't (see health/dailyLightIntegral.ts, the same computation style).
export function hoursUntilDayEnd(now: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(formatter.formatToParts(now).map((part) => [part.type, part.value]));
  const secondsSinceMidnight = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return (24 * 3600 - secondsSinceMidnight) / 3600;
}

// Simple least-squares linear regression over the last WATERING_PREDICTION_WINDOW_DAYS days of soil
// moisture, projecting when the value will cross `minPercent` — the {x} placeholder in
// sensorInfo_description_soilMoisture_range. Returns null whenever there's nothing reliable to say:
// fewer than 2 points in the window, a flat/rising trend, or a non-finite/non-positive projection.
export function estimateDaysUntilWatering(
  readings: Array<{ timestamp: Date; soilMoisturePercent: number | null }>,
  minPercent: number,
): number | null {
  const cutoff = Date.now() - WATERING_PREDICTION_WINDOW_DAYS * 24 * 3600_000;
  const points = readings
    .filter((r): r is { timestamp: Date; soilMoisturePercent: number } => r.soilMoisturePercent != null && r.timestamp.getTime() >= cutoff)
    .map((r) => ({ x: (r.timestamp.getTime() - cutoff) / (24 * 3600_000), y: r.soilMoisturePercent }));
  if (points.length < 2) return null;

  const n = points.length;
  const sumX = points.reduce((sum, p) => sum + p.x, 0);
  const sumY = points.reduce((sum, p) => sum + p.y, 0);
  const sumXY = points.reduce((sum, p) => sum + p.x * p.y, 0);
  const sumXX = points.reduce((sum, p) => sum + p.x * p.x, 0);
  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;
  const slopePerDay = (n * sumXY - sumX * sumY) / denominator; // %/day, negative = drying
  if (slopePerDay >= 0) return null;

  const latestValue = points[points.length - 1].y;
  const days = (latestValue - minPercent) / -slopePerDay;
  if (!Number.isFinite(days) || days <= 0) return null;
  return Math.min(Math.round(days), MAX_WATERING_PREDICTION_DAYS);
}

export type WaterAdviceKind = 'too_low' | 'too_high' | 'ok' | 'raw_no_profile';
export type TemperatureAdviceKind = 'too_low' | 'too_high' | 'ok' | 'soon_available' | 'no_plant' | 'raw_no_species_support';
export type LightAdviceKind = 'too_low' | 'too_high' | 'ok' | 'soon_available' | 'no_plant';
export type FertilizerAdviceKind = 'too_low' | 'too_high' | 'ok' | 'not_available' | 'no_plant';

export interface WaterAdvice {
  kind: WaterAdviceKind;
  minPercent?: number;
  daysUntilWatering?: number;
  // Whether anything will actually water this pot on its own (server scheduler or the pot's own
  // on-device algorithm) — picks Parrot's "arrosage automatique" copy vs. its manual-watering copy.
  autoWateringActive: boolean;
  soilMoisturePercent: number | null;
  waterTankLevelPercent: number | null;
}

export interface TemperatureAdvice {
  kind: TemperatureAdviceKind;
  isOutdoor: boolean;
  hoursRemaining?: number;
  temperatureC: number | null;
}

export interface LightAdvice {
  kind: LightAdviceKind;
  hoursRemaining?: number;
}

export interface FertilizerAdvice {
  kind: FertilizerAdviceKind;
  typeLabels: string[];
}

export interface PlantAdvice {
  water: WaterAdvice | null;
  temperature: TemperatureAdvice | null;
  light: LightAdvice | null;
  fertilizer: FertilizerAdvice | null;
}

function mostRecentValue<R, K extends keyof R>(readings: R[], key: K): R[K] | null {
  for (let i = readings.length - 1; i >= 0; i--) {
    const value = readings[i][key];
    if (value != null) return value;
  }
  return null;
}

function buildWaterAdvice(
  device: Pick<Device, 'kind'>,
  sorted: ReadingWithRawLog[],
  health: DeviceHealth,
  autoWateringActive: boolean,
): WaterAdvice | null {
  if (device.kind !== 'PARROT_POT') return null;
  const soilMoisturePercent = mostRecentValue(sorted, 'soilMoisturePercent');
  const waterTankLevelPercent = mostRecentValue(sorted, 'waterTankLevelPercent');

  const param = health.parameters.soilMoisturePercent;
  if (!param || param.speciesRange == null) {
    return { kind: 'raw_no_profile', autoWateringActive, soilMoisturePercent, waterTankLevelPercent };
  }

  const minPercent = param.speciesRange[0];
  if (param.status === 'too_low') return { kind: 'too_low', minPercent, autoWateringActive, soilMoisturePercent, waterTankLevelPercent };
  if (param.status === 'too_high') return { kind: 'too_high', minPercent, autoWateringActive, soilMoisturePercent, waterTankLevelPercent };

  const daysUntilWatering = estimateDaysUntilWatering(sorted, minPercent) ?? undefined;
  return { kind: 'ok', minPercent, daysUntilWatering, autoWateringActive, soilMoisturePercent, waterTankLevelPercent };
}

function buildTemperatureAdvice(
  device: Pick<Device, 'kind' | 'environment'>,
  sorted: ReadingWithRawLog[],
  health: DeviceHealth,
  globalHoursRemaining: number,
): TemperatureAdvice | null {
  const temperatureC = mostRecentValue(sorted, 'temperatureC');
  const isOutdoor = device.environment === 'OUTDOOR';

  if (device.kind === 'XIAOMI_LYWSD03MMC') return { kind: 'raw_no_species_support', isOutdoor, temperatureC };
  if (health.status === 'no_profile') return { kind: 'no_plant', isOutdoor, temperatureC };
  if (health.status === 'warming_up') return { kind: 'soon_available', isOutdoor, hoursRemaining: globalHoursRemaining, temperatureC };

  const param = health.parameters.temperatureC;
  if (!param || param.status === 'n/a') return null;
  if (param.status === 'too_low') return { kind: 'too_low', isOutdoor, temperatureC };
  if (param.status === 'too_high') return { kind: 'too_high', isOutdoor, temperatureC };
  return { kind: 'ok', isOutdoor, temperatureC };
}

function buildLightAdvice(
  device: Pick<Device, 'kind'>,
  health: DeviceHealth,
  globalHoursRemaining: number,
  now: Date,
  timezone: string,
): LightAdvice | null {
  if (device.kind !== 'PARROT_POT') return null;
  if (health.status === 'no_profile') return { kind: 'no_plant' };
  if (health.status === 'warming_up') return { kind: 'soon_available', hoursRemaining: globalHoursRemaining };

  const param = health.parameters.luminosity;
  if (!param || param.status === 'n/a') return null;
  // Part H's own "zero complete calendar days yet" gate — independent of the device-wide warmup
  // above, see health/scoring.ts's luminosity branch and health/dailyLightIntegral.ts.
  if (param.status === 'calibrating') return { kind: 'soon_available', hoursRemaining: hoursUntilDayEnd(now, timezone) };
  if (param.status === 'too_low') return { kind: 'too_low' };
  if (param.status === 'too_high') return { kind: 'too_high' };
  return { kind: 'ok' };
}

function buildFertilizerAdvice(
  device: Pick<Device, 'kind'>,
  health: DeviceHealth,
  fertilizerTypeLabels: string[],
): FertilizerAdvice | null {
  if (device.kind !== 'PARROT_POT') return null;
  if (health.status === 'no_profile') return { kind: 'no_plant', typeLabels: [] };

  const param = health.parameters.soilConductivityUsCm;
  if (!param) return null;
  if (param.status === 'calibrating' || param.status === 'n/a') return { kind: 'not_available', typeLabels: [] };
  if (param.status === 'too_low') return { kind: 'too_low', typeLabels: fertilizerTypeLabels };
  if (param.status === 'too_high') return { kind: 'too_high', typeLabels: [] };
  return { kind: 'ok', typeLabels: [] };
}

/**
 * Maps a device's already-computed DeviceHealth (health/scoring.ts's computeDeviceHealth) onto the
 * 4-category advice structure the "Plante" tab renders — a status key plus data placeholders only,
 * never composed French text (that lives in the frontend's plantAdviceText.ts). `fertilizerTypeLabels`
 * is the caller-resolved list of this species' specific (non-"tout usage") fertilizer type labels;
 * `autoWateringActive` is the caller-resolved "will this pot be watered automatically" flag.
 */
export function buildPlantAdvice(
  device: Pick<Device, 'kind' | 'environment'>,
  readings: ReadingWithRawLog[],
  health: DeviceHealth,
  warmupMinDays: number,
  timezone: string,
  fertilizerTypeLabels: string[],
  autoWateringActive = false,
): PlantAdvice {
  const sorted = readings.filter((r) => r.isInAir !== true).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const daysCovered = daysCoveredForReadings(sorted);
  const globalHoursRemaining = warmupHoursRemaining(daysCovered, warmupMinDays);
  const now = new Date();

  return {
    water: buildWaterAdvice(device, sorted, health, autoWateringActive),
    temperature: buildTemperatureAdvice(device, sorted, health, globalHoursRemaining),
    light: buildLightAdvice(device, health, globalHoursRemaining, now, timezone),
    fertilizer: buildFertilizerAdvice(device, health, fertilizerTypeLabels),
  };
}
