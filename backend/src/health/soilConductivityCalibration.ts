import type { Reading, RawSensorLog } from '@prisma/client';
import { prisma } from '../db/client.js';
import { decodeSoilConductivityRaw } from '../ble/parrot/soilConductivity.js';

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

// All-time (never expiring, DestCom's explicit choice) min/max of the raw 39e1fa02 value this
// specific device has ever reported during a normal poll — a calibration should reflect the widest
// real range this device has ever shown, not "recent" behavior. Scoped to source='POLL' like every
// other Health Engine baseline calculation, so a live session can never skew it.
export async function getCalibration(deviceId: string): Promise<ConductivityCalibration | null> {
  const agg = await prisma.rawSensorLog.aggregate({
    where: { reading: { deviceId, source: 'POLL' }, soilConductivityRaw: { not: null } },
    _min: { soilConductivityRaw: true },
    _max: { soilConductivityRaw: true },
    _count: { soilConductivityRaw: true },
  });
  if (agg._count.soilConductivityRaw === 0 || agg._min.soilConductivityRaw == null || agg._max.soilConductivityRaw == null) {
    return null;
  }

  const oldest = await prisma.rawSensorLog.findFirst({
    where: { reading: { deviceId, source: 'POLL' }, soilConductivityRaw: { not: null } },
    orderBy: { reading: { timestamp: 'asc' } },
    include: { reading: { select: { timestamp: true } } },
  });
  const daysCovered = oldest ? (Date.now() - oldest.reading.timestamp.getTime()) / (24 * 3600_000) : 0;

  const rawMin = agg._min.soilConductivityRaw;
  const rawMax = agg._max.soilConductivityRaw;
  const readingCount = agg._count.soilConductivityRaw;
  const calibrated = daysCovered >= MIN_CALIBRATION_DAYS && rawMax - rawMin >= MIN_CALIBRATION_RAW_RANGE;

  return { rawMin, rawMax, readingCount, daysCovered, calibrated };
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
