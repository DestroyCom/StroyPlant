import type { Device, PlantProfile } from '@prisma/client';
import { computeDailyTotals } from './dailyLightIntegral.js';
import type { ConductivityCalibration, ReadingWithRawLog } from './soilConductivityCalibration.js';
import { resolveConductivityValue } from './soilConductivityCalibration.js';

export type ParameterKey = 'soilMoisturePercent' | 'temperatureC' | 'humidityPercent' | 'luminosity' | 'soilConductivityUsCm';

export type ParameterStatus = 'ok' | 'too_low' | 'too_high' | 'n/a' | 'calibrating';

export interface ParameterHealth {
  value: number | null;
  status: ParameterStatus;
  speciesRange: [number, number | null] | null;
  personalDeviation: 'unusual_low' | 'unusual_high' | 'normal';
  // Live instantaneous reading (mmol/m²/day, same conversion as `value`) — informational only,
  // never used for `status`. Always null except for `luminosity` (Part H, design spec step 5): the
  // gauge still shows "what the light level looks like right now" alongside the daily-total-based
  // value/status, since the daily total is only ever as fresh as yesterday.
  liveValue: number | null;
}

export type HealthTrend = 'stable' | 'degrading' | 'improving' | 'unknown';

export type DeviceHealthStatus = 'ok' | 'warning' | 'warming_up' | 'no_profile';

export interface DeviceHealth {
  status: DeviceHealthStatus;
  parameters: Partial<Record<ParameterKey, ParameterHealth>>;
  trend: HealthTrend;
  warningParameters: ParameterKey[];
  // True iff the 3 most recent COMPLETE calendar days were all too_low on luminosity (Part H, design
  // spec step 6) — drives the frontend's "move the plant" advisory. False (never true) for Xiaomi
  // devices, which have no luminosity parameter at all, and for any device with fewer than 3
  // complete days of luminosity history.
  luminosityRecentDaysTooLow: boolean;
}

// Short rolling average rather than the instantaneous value alone (docs/STROYPLANT_SPEC.md section 7.3).
const RECENT_WINDOW_MS = 60 * 60_000;
const TREND_RECENT_DAYS = 3;

// Parameters compared against the species profile, per device type. Soil pH isn't measured by any
// current device (extension to other sensors = Batch 9).
//
// Soil conductivity (fertility index) — decoded from the raw 39e1fa02 characteristic, the same
// one WatchFlower's own Parrot Pot driver reads (see ble/parrot/soilConductivity.ts). Replaces the
// earlier soilConductivityEcb/EcPorous candidates (39e1fa0d/0e), confirmed via real production
// logs (2026-07-30) to be unreadable on real Parrot Pot firmware.
const PARAMETERS_BY_KIND: Record<Device['kind'], ParameterKey[]> = {
  PARROT_POT: ['soilMoisturePercent', 'temperatureC', 'luminosity', 'soilConductivityUsCm'],
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

type LightCategory = 'low' | 'medium' | 'high';

// Published general houseplant DLI (Daily Light Integral) categories — NOT a per-species indoor
// dataset (none exists anywhere: not in the WatchFlower CSV, not in the official Parrot app, not in
// any of the other Flower Power repos surveyed). Used only when Device.environment is INDOOR, where
// ambient window light with no supplemental grow lighting makes the outdoor/garden-oriented
// WatchFlower CSV thresholds structurally unreachable for most real placements (a real production
// Parrot Pot reading: 0.1 mol/m²/day, two full orders of magnitude below the CSV's typical 2-7.5
// mol/day minimums). Values in mmol/m²/day to match PlantProfile.lightMinMmol/lightMaxMmol's own
// unit — no separate conversion needed here.
const INDOOR_LIGHT_FLOOR_MMOL: Record<LightCategory, number> = { low: 2000, medium: 5000, high: 10000 };

// Classifies a SPECIES (not a device) by its own outdoor light need, using the CSV's own
// lightMinMmol — a species that tolerates little light outdoors is assumed shade-tolerant indoors
// too, and vice versa. Breakpoints match the same published low/medium/high-light category
// boundaries as INDOOR_LIGHT_FLOOR_MMOL above.
function classifyLightCategory(speciesOutdoorMinMmol: number): LightCategory {
  if (speciesOutdoorMinMmol <= 5000) return 'low';
  if (speciesOutdoorMinMmol <= 15000) return 'medium';
  return 'high';
}

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
    case 'soilConductivityUsCm':
      return rangeOrNull(profile.soilConductivityMinUsCm, profile.soilConductivityMaxUsCm);
  }
}

// Resolves both the comparison range and the resulting status for one parameter. Indoor luminosity
// is the one special case (floor-only comparison against a published category, see above) — every
// other parameter/environment combination uses the species CSV range unchanged.
function resolveRangeAndStatus(
  key: ParameterKey,
  recentValue: number,
  profile: PlantProfile,
  environment: Device['environment'],
): { speciesRange: [number, number | null] | null; status: ParameterStatus } {
  if (key === 'luminosity' && environment === 'INDOOR') {
    const outdoorRange = speciesRangeFor(key, profile);
    if (!outdoorRange) return { speciesRange: null, status: 'n/a' };
    // The indoor accommodation is meant to be more LENIENT than the outdoor range, never stricter —
    // for species whose own outdoor minimum sits below the category floor, cap the floor at that
    // outdoor minimum (found during the final whole-branch review, 2026-08-03).
    const floor = Math.min(INDOOR_LIGHT_FLOOR_MMOL[classifyLightCategory(outdoorRange[0])], outdoorRange[0]);
    return { speciesRange: [floor, null], status: recentValue < floor ? 'too_low' : 'ok' };
  }

  const speciesRange = speciesRangeFor(key, profile);
  if (!speciesRange) return { speciesRange: null, status: 'n/a' };
  const [min, max] = speciesRange;
  return { speciesRange, status: recentValue < min ? 'too_low' : recentValue > max ? 'too_high' : 'ok' };
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

// Minimum baseline sample size before trusting a personal mean/stddev — reuses the same "5" the
// existing recentSource fallback already uses a few lines below (not a new invented threshold).
const PERSONAL_BASELINE_MIN_POINTS = 5;
// Standard statistical convention for "unusual" (2 standard deviations), not a domain-specific
// constant — see design spec Part C.
const PERSONAL_BASELINE_SIGMA = 2;

// Compares a device's own current value against ITS OWN recent history (excluding the same
// RECENT_WINDOW_MS slice being evaluated) — separate from, and never influencing, the
// species-range-based status above. Uses the pre-unit-conversion raw value (same unit valuesFor()
// already returns for this key) so no extra conversion bookkeeping is needed here; unit consistency
// only matters within this self-comparison, not against species thresholds.
function computePersonalDeviation(
  key: ParameterKey,
  rawValue: number,
  sorted: ReadingWithRawLog[],
  recentSource: ReadingWithRawLog[],
  warmingUp: boolean,
  conductivityCalibration: ConductivityCalibration | null,
): 'unusual_low' | 'unusual_high' | 'normal' {
  if (warmingUp) return 'normal';

  const recentSet = new Set(recentSource);
  const baselineReadings = sorted.filter((reading) => !recentSet.has(reading));
  const baselineValues = valuesFor(key, baselineReadings, conductivityCalibration);
  if (baselineValues.length < PERSONAL_BASELINE_MIN_POINTS) return 'normal';

  const baselineMean = average(baselineValues);
  if (baselineMean == null) return 'normal';
  const baselineStdDev = stdDev(baselineValues, baselineMean);
  if (baselineStdDev === 0) return 'normal';

  if (rawValue < baselineMean - PERSONAL_BASELINE_SIGMA * baselineStdDev) return 'unusual_low';
  if (rawValue > baselineMean + PERSONAL_BASELINE_SIGMA * baselineStdDev) return 'unusual_high';
  return 'normal';
}

function valuesFor(key: ParameterKey, readings: ReadingWithRawLog[], conductivityCalibration: ConductivityCalibration | null): number[] {
  if (key === 'soilConductivityUsCm') {
    return readings
      .map((reading) => resolveConductivityValue(reading, conductivityCalibration))
      .filter((value): value is number => value != null);
  }
  return readings.map((reading) => reading[key]).filter((value): value is number => value != null);
}

/**
 * Computes a device's health score by combining the species profile's generic ranges
 * (coarse guardrail) and a device-specific rolling baseline (docs/STROYPLANT_SPEC.md section
 * 7.3). `readings` must cover the configured baseline window (see health/settings.ts) — it's up to
 * the caller to bound the Prisma query upstream and pass the matching `warmupMinDays`.
 */
export function computeDeviceHealth(
  device: Pick<Device, 'kind' | 'environment'>,
  readings: ReadingWithRawLog[],
  profile: PlantProfile | null,
  warmupMinDays: number,
  conductivityCalibration: ConductivityCalibration | null,
  timezone: string,
): DeviceHealth {
  if (!profile) {
    return { status: 'no_profile', parameters: {}, trend: 'unknown', warningParameters: [], luminosityRecentDaysTooLow: false };
  }

  // A reading taken with the probe out of the soil (Plant Dr STATUS_FLAGS, section 7.11) doesn't
  // represent a plant state — excluded from baseline/scoring entirely, not just displayed
  // differently, so it can't pollute the rolling average or the trend detection.
  const sorted = readings.filter((reading) => reading.isInAir !== true).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const oldest = sorted[0];
  const daysCovered = oldest ? (Date.now() - oldest.timestamp.getTime()) / (24 * 3600_000) : 0;
  const warmingUp = daysCovered < warmupMinDays;

  const now = Date.now();
  const recentReadings = sorted.filter((reading) => now - reading.timestamp.getTime() <= RECENT_WINDOW_MS);
  // Fallback if no reading in the last hour (infrequent polling / device not seen recently).
  const recentSource = recentReadings.length > 0 ? recentReadings : sorted.slice(-5);

  const parameters: Partial<Record<ParameterKey, ParameterHealth>> = {};
  let hasOutOfRange = false;
  const warningParameters: ParameterKey[] = [];
  let luminosityRecentDaysTooLow = false;

  for (const key of PARAMETERS_BY_KIND[device.kind]) {
    // Scoped to this one parameter (design spec, Part 4) — an under-calibrated conductivity sensor
    // never pushes the WHOLE device into 'warming_up', that status is a coarser, separate concept.
    if (key === 'soilConductivityUsCm' && conductivityCalibration?.calibrated !== true) {
      parameters[key] = { value: null, status: 'calibrating', speciesRange: null, personalDeviation: 'normal', liveValue: null };
      continue;
    }

    // Luminosity (Part H, 2026-08-03): the daily total (last COMPLETE calendar day, in `timezone`)
    // replaces the hourly-average instantaneous value as the comparison input, across every
    // environment — the instantaneous-vs-daily-threshold mismatch isn't an indoor-only problem, see
    // the design spec's Part H introduction for the real production numbers that proved this.
    if (key === 'luminosity') {
      const mostRecentRaw = [...sorted].reverse().find((reading) => reading.luminosity != null)?.luminosity ?? null;
      const liveValue = mostRecentRaw != null ? mostRecentRaw * (UNIT_CONVERSION[key] ?? 1) : null;

      const dailyTotals = computeDailyTotals(sorted, timezone);
      if (dailyTotals.length === 0) {
        // No complete calendar day yet (brand-new device, or every day so far failed the
        // MAX_GAP_MS gate) — reuses the existing 'calibrating' status (Part D) rather than a new
        // enum member: same meaning, "not enough data yet, never a stale/misleading number".
        parameters[key] = { value: null, status: 'calibrating', speciesRange: null, personalDeviation: 'normal', liveValue };
        continue;
      }

      const recentValue = dailyTotals[0].totalMol * (UNIT_CONVERSION[key] ?? 1);
      const { speciesRange, status } = resolveRangeAndStatus(key, recentValue, profile, device.environment);
      if (status !== 'ok' && status !== 'n/a') {
        hasOutOfRange = true;
        warningParameters.push(key);
      }

      // "Move the plant" advisory (design spec step 6): the 3 most recent COMPLETE days, not just
      // the 1 used for `status` above — a single overcast day must not trigger this, only a
      // sustained pattern. dailyTotals is already most-recent-first.
      const last3Days = dailyTotals.slice(0, 3);
      luminosityRecentDaysTooLow =
        last3Days.length === 3 &&
        last3Days.every(
          (day) => resolveRangeAndStatus(key, day.totalMol * (UNIT_CONVERSION[key] ?? 1), profile, device.environment).status === 'too_low',
        );

      // personalDeviation is deliberately NOT computed for luminosity: Part C's baseline is built
      // from per-reading INSTANTANEOUS values (valuesFor()), which would compare a daily TOTAL
      // against a mean of noon-peak-and-midnight-floor noise — not a meaningful comparison, and Part
      // H's brainstorm didn't ask for a day-total-based personal baseline. Always 'normal' for this
      // one parameter; revisit only if DestCom asks for it explicitly.
      parameters[key] = { value: recentValue, status, speciesRange, personalDeviation: 'normal', liveValue };
      continue;
    }

    const rawValue = average(valuesFor(key, recentSource, conductivityCalibration));
    if (rawValue == null) continue;
    const recentValue = rawValue * (UNIT_CONVERSION[key] ?? 1);

    const { speciesRange, status } = resolveRangeAndStatus(key, recentValue, profile, device.environment);
    // Deliberately excluded from hasOutOfRange (2026-07-31, final-review follow-up): the
    // per-device conductivity calibration is a RELATIVE percentile within this device's own
    // observed raw range (always stretched to fill 0-1000, by construction), compared here
    // against ABSOLUTE µS/cm species thresholds — a scale mismatch already flagged as unresolved
    // even in WatchFlower's own reference app. Until the scale question is actually resolved
    // empirically, this parameter's status/value/speciesRange are still computed and shown on the
    // gauge (tone, hint) for information, but never flip the device's overall status.
    if (status !== 'ok' && status !== 'n/a' && key !== 'soilConductivityUsCm') {
      hasOutOfRange = true;
      warningParameters.push(key);
    }

    const personalDeviation = computePersonalDeviation(key, rawValue, sorted, recentSource, warmingUp, conductivityCalibration);

    parameters[key] = { value: recentValue, status, speciesRange, personalDeviation, liveValue: null };
  }

  return {
    status: warmingUp ? 'warming_up' : hasOutOfRange ? 'warning' : 'ok',
    parameters,
    trend: computeTrend(sorted, device.kind),
    warningParameters,
    luminosityRecentDaysTooLow,
  };
}

function computeTrend(sorted: ReadingWithRawLog[], kind: Device['kind']): HealthTrend {
  const key = TREND_PARAMETER_BY_KIND[kind];
  const now = Date.now();
  const recentCutoff = now - TREND_RECENT_DAYS * 24 * 3600_000;

  const recentValues = valuesFor(
    key,
    sorted.filter((reading) => reading.timestamp.getTime() >= recentCutoff),
    null,
  );
  const olderValues = valuesFor(
    key,
    sorted.filter((reading) => reading.timestamp.getTime() < recentCutoff),
    null,
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
