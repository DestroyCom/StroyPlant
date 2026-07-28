import type { Device, PlantProfile, Reading } from '@prisma/client';
import { env } from '../env.js';

export type ParameterKey = 'soilMoisturePercent' | 'temperatureC' | 'humidityPercent' | 'luminosity' | 'soilConductivityEcPorous';

export type ParameterStatus = 'ok' | 'too_low' | 'too_high' | 'n/a';

export interface ParameterHealth {
  value: number;
  status: ParameterStatus;
  speciesRange: [number, number] | null;
}

export type HealthTrend = 'stable' | 'degrading' | 'improving' | 'unknown';

export type DeviceHealthStatus = 'ok' | 'warning' | 'warming_up' | 'no_profile';

export interface DeviceHealth {
  status: DeviceHealthStatus;
  parameters: Partial<Record<ParameterKey, ParameterHealth>>;
  trend: HealthTrend;
}

// Short rolling average rather than the instantaneous value alone (docs/STROYPLANT_SPEC.md section 7.3).
const RECENT_WINDOW_MS = 60 * 60_000;
const TREND_RECENT_DAYS = 3;

// Parameters compared against the species profile, per device type. Soil pH isn't measured by any
// current device (extension to other sensors = Batch 9).
//
// Soil conductivity: two raw candidates exist (soilConductivityEcb/EcPorous, 39e1fa0d/0e —
// see docs/STROYPLANT_SPEC.md section 8), never read by the official Parrot Pot app itself.
// "Ec porous" (pore water EC) is chosen for scoring — soil science research (METER Group,
// 30MHz): it's the derived value that the horticultural industry calls "soil conductivity" by
// default, unlike "Ecb" (bulk EC) which is the raw soil+water+air measurement, not interpretable
// as-is. **Mapping not confirmed empirically on a real Parrot Pot** (no real data
// collected at the time of this decision, only synthetic mock values) — to be revalidated once
// real readings are available (Ec porous must be structurally > Ecb, the derivation
// removing the diluting effect of solid particles/air).
const PARAMETERS_BY_KIND: Record<Device['kind'], ParameterKey[]> = {
  PARROT_POT: ['soilMoisturePercent', 'temperatureC', 'luminosity', 'soilConductivityEcPorous'],
  XIAOMI_LYWSD03MMC: ['temperatureC', 'humidityPercent'],
};

// The Parrot Pot firmware returns luminosity in mol/m²/day (DLI, confirmed via the
// official Parrot-Developers/node-flower-power lib — docs/STROYPLANT_SPEC.md section 8), whereas the
// WatchFlower CSV expresses its "Light MIN/MAX" ranges in mmol/m²/day — a ×1000 conversion is needed
// before any comparison. The other parameters don't need conversion (same units on
// both sides).
const UNIT_CONVERSION: Partial<Record<ParameterKey, number>> = {
  luminosity: 1000,
};

// Parameter most revealing of a progressive lack of water/moisture, used for trend
// detection: soil moisture for the Parrot Pot (probe in the soil), ambient humidity for the Xiaomi
// (no soil probe).
const TREND_PARAMETER_BY_KIND: Record<Device['kind'], ParameterKey> = {
  PARROT_POT: 'soilMoisturePercent',
  XIAOMI_LYWSD03MMC: 'humidityPercent',
};

function rangeOrNull(min: number | null, max: number | null): [number, number] | null {
  return min != null && max != null ? [min, max] : null;
}

function speciesRangeFor(key: ParameterKey, profile: PlantProfile): [number, number] | null {
  switch (key) {
    case 'soilMoisturePercent':
      return rangeOrNull(profile.soilMoistureMinPercent, profile.soilMoistureMaxPercent);
    case 'temperatureC':
      return rangeOrNull(profile.temperatureMinC, profile.temperatureMaxC);
    case 'humidityPercent':
      return rangeOrNull(profile.humidityMinPercent, profile.humidityMaxPercent);
    case 'luminosity':
      return rangeOrNull(profile.lightMinMmol, profile.lightMaxMmol);
    case 'soilConductivityEcPorous':
      return rangeOrNull(profile.soilConductivityMinUsCm, profile.soilConductivityMaxUsCm);
  }
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function stdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function valuesFor(key: ParameterKey, readings: Reading[]): number[] {
  return readings.map((reading) => reading[key]).filter((value): value is number => value != null);
}

/**
 * Computes a device's health score by combining the species profile's generic ranges
 * (coarse guardrail) and a device-specific rolling baseline (docs/STROYPLANT_SPEC.md section
 * 7.3). `readings` must cover the `env.healthBaselineWindowDays` window — it's up to the caller
 * to bound the Prisma query upstream.
 */
export function computeDeviceHealth(device: Pick<Device, 'kind'>, readings: Reading[], profile: PlantProfile | null): DeviceHealth {
  if (!profile) {
    return { status: 'no_profile', parameters: {}, trend: 'unknown' };
  }

  // A reading taken with the probe out of the soil (Plant Dr STATUS_FLAGS, section 7.11) doesn't
  // represent a plant state — excluded from baseline/scoring entirely, not just displayed
  // differently, so it can't pollute the rolling average or the trend detection.
  const sorted = readings.filter((reading) => reading.isInAir !== true).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const oldest = sorted[0];
  const daysCovered = oldest ? (Date.now() - oldest.timestamp.getTime()) / (24 * 3600_000) : 0;
  const warmingUp = daysCovered < env.healthWarmupMinDays;

  const now = Date.now();
  const recentReadings = sorted.filter((reading) => now - reading.timestamp.getTime() <= RECENT_WINDOW_MS);
  // Fallback if no reading in the last hour (infrequent polling / device not seen recently).
  const recentSource = recentReadings.length > 0 ? recentReadings : sorted.slice(-5);

  const parameters: Partial<Record<ParameterKey, ParameterHealth>> = {};
  let hasOutOfRange = false;

  for (const key of PARAMETERS_BY_KIND[device.kind]) {
    const rawValue = average(valuesFor(key, recentSource));
    if (rawValue == null) continue;
    const recentValue = rawValue * (UNIT_CONVERSION[key] ?? 1);

    const speciesRange = speciesRangeFor(key, profile);
    let status: ParameterStatus = 'n/a';
    if (speciesRange) {
      const [min, max] = speciesRange;
      status = recentValue < min ? 'too_low' : recentValue > max ? 'too_high' : 'ok';
      if (status !== 'ok') hasOutOfRange = true;
    }

    parameters[key] = { value: recentValue, status, speciesRange };
  }

  return {
    status: warmingUp ? 'warming_up' : hasOutOfRange ? 'warning' : 'ok',
    parameters,
    trend: computeTrend(sorted, device.kind),
  };
}

function computeTrend(sorted: Reading[], kind: Device['kind']): HealthTrend {
  const key = TREND_PARAMETER_BY_KIND[kind];
  const now = Date.now();
  const recentCutoff = now - TREND_RECENT_DAYS * 24 * 3600_000;

  const recentValues = valuesFor(
    key,
    sorted.filter((reading) => reading.timestamp.getTime() >= recentCutoff),
  );
  const olderValues = valuesFor(
    key,
    sorted.filter((reading) => reading.timestamp.getTime() < recentCutoff),
  );

  const recentMean = average(recentValues);
  const olderMean = average(olderValues);
  if (recentMean == null || olderMean == null) return 'unknown';

  const delta = recentMean - olderMean;
  // Threshold = standard deviation of the previous baseline, with a floor to avoid a zero threshold
  // if that baseline is perfectly stable (little variance with few points early in the device's life).
  const threshold = Math.max(stdDev(olderValues, olderMean), 1);

  if (delta < -threshold) return 'degrading';
  if (delta > threshold) return 'improving';
  return 'stable';
}
