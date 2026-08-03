import type { RawSensorLog, Reading } from '@prisma/client';
import { decodeSoilConductivityRaw } from '../ble/parrot/soilConductivity.js';
import { prisma } from '../db/client.js';

// Confidence-gate constants (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-
// and-raw-sensor-log-design.md, Part 3) — plain exported constants, not a Settings DB row (YAGNI).
export const MIN_CALIBRATION_DAYS = 14;
export const MIN_CALIBRATION_RAW_RANGE = 50;

export interface ConductivityCalibration {
  rawMin: number;
  rawMax: number;
  readingCount: number;
  daysCovered: number;
  calibrated: boolean;
}

export type ReadingWithRawLog = Reading & { rawSensorLog: RawSensorLog | null };

// getCalibration() is called on every devices.list/devices.history/health.deviceHealth request
// (the detail page polls health.deviceHealth every 60s) and otherwise re-scans a device's entire
// all-time RawSensorLog history on each call — unbounded, and growing forever with no pruning. A
// calibration's percentile bounds change glacially (all-time 5th/95th percentiles), so a short TTL
// costs nothing in practical staleness; matches the detail page's own ~60s poll interval.
const CALIBRATION_CACHE_TTL_MS = 60_000;
const calibrationCache = new Map<string, { value: ConductivityCalibration | null; expiresAt: number }>();

// Linear-interpolation percentile (matches numpy's default) over an already-sorted array.
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 1) return sortedValues[0];
  const index = p * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

// Bounds derived from the 5th/95th percentile (not the absolute min/max, 2026-07-31 follow-up) of
// the raw 39e1fa02 value this specific device has ever reported during a normal poll — all-time,
// never expiring (DestCom's explicit choice: a calibration should reflect the widest real range
// this device has shown, not "recent" behavior), scoped to source='POLL' like every other Health
// Engine baseline calculation so a live session can never skew it. Percentiles (not the true
// min/max) so a single spurious raw reading (electrical glitch, bad contact) can't permanently
// redefine the whole 0-1000 output scale and silently reshape every historical chart value — it
// just clamps at the extreme end via decodeSoilConductivityRaw's existing clamp() instead.
export async function getCalibration(deviceId: string): Promise<ConductivityCalibration | null> {
  const cached = calibrationCache.get(deviceId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const rows = await prisma.rawSensorLog.findMany({
    where: { reading: { deviceId, source: 'POLL' }, soilConductivityRaw: { not: null } },
    select: { soilConductivityRaw: true },
  });
  if (rows.length === 0) {
    calibrationCache.set(deviceId, { value: null, expiresAt: Date.now() + CALIBRATION_CACHE_TTL_MS });
    return null;
  }

  const values = rows.map((row) => row.soilConductivityRaw as number).sort((a, b) => a - b);
  const rawMin = percentile(values, 0.05);
  const rawMax = percentile(values, 0.95);

  const oldest = await prisma.rawSensorLog.findFirst({
    where: { reading: { deviceId, source: 'POLL' }, soilConductivityRaw: { not: null } },
    orderBy: { reading: { timestamp: 'asc' } },
    include: { reading: { select: { timestamp: true } } },
  });
  const daysCovered = oldest ? (Date.now() - oldest.reading.timestamp.getTime()) / (24 * 3600_000) : 0;

  const readingCount = values.length;
  const calibrated = daysCovered >= MIN_CALIBRATION_DAYS && rawMax - rawMin >= MIN_CALIBRATION_RAW_RANGE;

  const result: ConductivityCalibration = { rawMin, rawMax, readingCount, daysCovered, calibrated };
  calibrationCache.set(deviceId, { value: result, expiresAt: Date.now() + CALIBRATION_CACHE_TTL_MS });
  return result;
}

// Resolves the "fertility" value for one Reading: readings created after this feature shipped
// always have a RawSensorLog row (even if soilConductivityRaw itself is null, e.g. a failed read) —
// for those, recompute fresh using the device's CURRENT calibration (null if not calibrated yet,
// i.e. "calibrating", never a stale number). Readings that predate this feature have no
// RawSensorLog row at all — for those only, fall back to whatever Reading.soilConductivityUsCm the
// old fixed-formula already computed and stored, so historical charts don't go blank.
export function resolveConductivityValue(reading: ReadingWithRawLog, calibration: ConductivityCalibration | null): number | null {
  if (!reading.rawSensorLog) return reading.soilConductivityUsCm;
  if (reading.rawSensorLog.soilConductivityRaw == null || !calibration?.calibrated) return null;
  return decodeSoilConductivityRaw(reading.rawSensorLog.soilConductivityRaw, { rawMin: calibration.rawMin, rawMax: calibration.rawMax });
}
