import type { Device, PlantProfile, Schedule } from '@prisma/client';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import type { DeviceProvider } from '../providers/types.js';
import { triggerWatering } from '../watering.js';
import { evaluateShadow } from './inferenceShadow.js';
import { computeDeviceHealth } from './scoring.js';
import { getHealthSettings } from './settings.js';
import { getCalibration } from './soilConductivityCalibration.js';

// Fallback values used whenever a device has no Schedule row yet (docs/STROYPLANT_SPEC.md section
// 7.4) — DestCom's explicit choice: a device becomes eligible for auto-watering as soon as a
// species is assigned, with no separate opt-in step, so `active`'s fallback depends on
// `plantProfileId` rather than being a fixed constant like the other fields.
export const DEFAULT_SCHEDULE = {
  allowedStartHour: 6,
  allowedEndHour: 20,
  cooldownHours: 24,
};

export interface EffectiveSchedule {
  active: boolean;
  allowedStartHour: number;
  allowedEndHour: number;
  cooldownHours: number;
}

export function resolveEffectiveSchedule(device: Pick<Device, 'plantProfileId'>, schedule: Schedule | null): EffectiveSchedule {
  return {
    active: schedule?.active ?? device.plantProfileId != null,
    allowedStartHour: schedule?.allowedStartHour ?? DEFAULT_SCHEDULE.allowedStartHour,
    allowedEndHour: schedule?.allowedEndHour ?? DEFAULT_SCHEDULE.allowedEndHour,
    cooldownHours: schedule?.cooldownHours ?? DEFAULT_SCHEDULE.cooldownHours,
  };
}

export function isWithinAllowedWindow(hour: number, startHour: number, endHour: number): boolean {
  // endHour is exclusive; a start > end range wraps past midnight (e.g. 22 -> 6).
  return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

export type DeviceForTick = Device & { plantProfile: PlantProfile | null; schedule: Schedule | null };

async function evaluateDevice(device: DeviceForTick, provider: DeviceProvider, connectionQueue: ConnectionQueue): Promise<void> {
  const effective = resolveEffectiveSchedule(device, device.schedule);
  if (!effective.active) return;

  const currentHour = new Date().getHours();
  if (!isWithinAllowedWindow(currentHour, effective.allowedStartHour, effective.allowedEndHour)) return;

  const lastWatering = await prisma.wateringEvent.findFirst({ where: { deviceId: device.id }, orderBy: { timestamp: 'desc' } });
  if (lastWatering && Date.now() - lastWatering.timestamp.getTime() < effective.cooldownHours * 3600_000) return;

  const healthSettings = await getHealthSettings();
  const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
  const readings = await prisma.reading.findMany({
    where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
    orderBy: { timestamp: 'asc' },
    include: { rawSensorLog: true },
  });
  const conductivityCalibration = await getCalibration(device.id);
  const health = computeDeviceHealth(
    device,
    readings,
    device.plantProfile,
    healthSettings.warmupMinDays,
    conductivityCalibration,
    healthSettings.timezone,
  );

  // Same warm-up safeguard the Health Engine uses for dashboard alerts (docs/STROYPLANT_SPEC.md
  // section 7.3) — trusting a single parameter's status before enough personal baseline has
  // accumulated would risk a spurious real-world watering trigger, not just a wrong badge.
  if (health.status === 'warming_up') return;

  if (health.parameters.soilMoisturePercent?.status !== 'too_low') return;

  log({ direction: 'WRITE', label: 'Scheduler triggering auto-watering (soil moisture too low)', deviceId: device.id, result: 'OK' });
  await triggerWatering(device.id, 'CRON', provider, connectionQueue);
}

async function tick(provider: DeviceProvider, connectionQueue: ConnectionQueue): Promise<void> {
  // Only Parrot Pots have a pump; only devices with a species assigned can ever produce a
  // `soilMoisturePercent` status to act on (computeDeviceHealth returns `no_profile` otherwise).
  const devices = await prisma.device.findMany({
    where: { kind: 'PARROT_POT', plantProfileId: { not: null } },
    include: { plantProfile: true, schedule: true },
  });
  // Fetched once here for the shadow-mode gate below — evaluateDevice() also fetches its own copy
  // internally for the baseline window it needs; a second cheap read once per tick is preferable
  // to threading this through evaluateDevice's own signature for an unrelated concern.
  const healthSettings = await getHealthSettings();

  for (const device of devices) {
    try {
      await evaluateDevice(device, provider, connectionQueue);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Scheduler tick failed for device',
        deviceId: device.id,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    // Phase B, shadow mode (docs/superpowers/specs/2026-08-11-inference-engine-phase-b-shadow-
    // mode-design.md) — deliberately its own try/catch, never sharing one with evaluateDevice
    // above: a shadow-evaluation failure must never affect (or be masked by) the real
    // watering-decision path for the same device on the same tick.
    if (healthSettings.shadowModeEnabled) {
      try {
        await evaluateShadow(device, healthSettings);
      } catch (error) {
        log({
          direction: 'INFO',
          label: 'Shadow evaluation failed for device',
          deviceId: device.id,
          result: 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export function startScheduler(provider: DeviceProvider, connectionQueue: ConnectionQueue, intervalMs = env.schedulerTickIntervalMs): void {
  log({ direction: 'INFO', label: `Auto-watering scheduler started — tick every ${intervalMs / 60_000}min`, result: 'OK' });
  setInterval(() => {
    void tick(provider, connectionQueue);
  }, intervalMs);
}
