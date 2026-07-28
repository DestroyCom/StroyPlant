import type { Device, PlantProfile, Schedule } from '@prisma/client';
import type { MqttClient } from 'mqtt';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import type { DeviceProvider } from '../providers/types.js';
import { triggerWatering } from '../watering.js';
import { computeDeviceHealth } from './scoring.js';

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

function isWithinAllowedWindow(hour: number, startHour: number, endHour: number): boolean {
  // endHour is exclusive; a start > end range wraps past midnight (e.g. 22 -> 6).
  return startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
}

type DeviceForTick = Device & { plantProfile: PlantProfile | null; schedule: Schedule | null };

async function evaluateDevice(
  device: DeviceForTick,
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
  mqttClient: MqttClient | null,
): Promise<void> {
  const effective = resolveEffectiveSchedule(device, device.schedule);
  if (!effective.active) return;

  const currentHour = new Date().getHours();
  if (!isWithinAllowedWindow(currentHour, effective.allowedStartHour, effective.allowedEndHour)) return;

  const lastWatering = await prisma.wateringEvent.findFirst({ where: { deviceId: device.id }, orderBy: { timestamp: 'desc' } });
  if (lastWatering && Date.now() - lastWatering.timestamp.getTime() < effective.cooldownHours * 3600_000) return;

  const since = new Date(Date.now() - env.healthBaselineWindowDays * 24 * 3600_000);
  const readings = await prisma.reading.findMany({
    where: { deviceId: device.id, timestamp: { gte: since } },
    orderBy: { timestamp: 'asc' },
  });
  const health = computeDeviceHealth(device, readings, device.plantProfile);

  // Same warm-up safeguard the Health Engine uses for dashboard alerts (docs/STROYPLANT_SPEC.md
  // section 7.3) — trusting a single parameter's status before enough personal baseline has
  // accumulated would risk a spurious real-world watering trigger, not just a wrong badge.
  if (health.status === 'warming_up') return;

  if (health.parameters.soilMoisturePercent?.status !== 'too_low') return;

  log({ direction: 'WRITE', label: 'Scheduler triggering auto-watering (soil moisture too low)', deviceId: device.id, result: 'OK' });
  await triggerWatering(device.id, 'CRON', provider, connectionQueue, mqttClient);
}

async function tick(provider: DeviceProvider, connectionQueue: ConnectionQueue, mqttClient: MqttClient | null): Promise<void> {
  // Only Parrot Pots have a pump; only devices with a species assigned can ever produce a
  // `soilMoisturePercent` status to act on (computeDeviceHealth returns `no_profile` otherwise).
  const devices = await prisma.device.findMany({
    where: { kind: 'PARROT_POT', plantProfileId: { not: null } },
    include: { plantProfile: true, schedule: true },
  });

  for (const device of devices) {
    try {
      await evaluateDevice(device, provider, connectionQueue, mqttClient);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'Scheduler tick failed for device',
        deviceId: device.id,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function startScheduler(
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
  mqttClient: MqttClient | null,
  intervalMs = env.schedulerTickIntervalMs,
): void {
  log({ direction: 'INFO', label: `Auto-watering scheduler started — tick every ${intervalMs / 60_000}min`, result: 'OK' });
  setInterval(() => {
    void tick(provider, connectionQueue, mqttClient);
  }, intervalMs);
}
