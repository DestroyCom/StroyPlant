import type { Device } from '@prisma/client';
import type { MqttClient } from 'mqtt';
import { prisma } from '../db/client.js';
import { computeDeviceHealth } from '../health/scoring.js';
import { getCalibration } from '../health/soilConductivityCalibration.js';
import { getHealthSettings } from '../health/settings.js';
import type { WateringResult } from '../watering.js';
import { buildDiscoveryEntities } from './discovery.js';
import { discoveryConfigTopic, healthTopic, type MqttTopicSettings, stateTopic, wateringResultTopic } from './topics.js';

export function publishDiscovery(client: MqttClient, device: Pick<Device, 'id' | 'name' | 'kind'>, settings: MqttTopicSettings): void {
  for (const entity of buildDiscoveryEntities(device, settings.baseTopic)) {
    const topic = discoveryConfigTopic(settings.discoveryPrefix, entity.component, device.id, entity.objectId);
    client.publish(topic, JSON.stringify(entity.payload), { qos: 1, retain: true });
  }
}

export function publishReadingState(client: MqttClient, deviceId: string, data: Record<string, unknown>, baseTopic: string): void {
  client.publish(stateTopic(baseTopic, deviceId), JSON.stringify(data), { qos: 0, retain: true });
}

// Recomputes the same Health Engine result the `health.deviceHealth` tRPC query and the scheduler
// use (docs/STROYPLANT_SPEC.md section 7.3) — no cache, kept simple since this only runs once per
// poll cycle per device.
export async function publishHealthState(client: MqttClient, deviceId: string, baseTopic: string): Promise<void> {
  const device = await prisma.device.findUnique({ where: { id: deviceId }, include: { plantProfile: true } });
  if (!device?.plantProfile) return;

  const healthSettings = await getHealthSettings();
  const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
  const readings = await prisma.reading.findMany({
    where: { deviceId, timestamp: { gte: since }, source: 'POLL' },
    orderBy: { timestamp: 'asc' },
    include: { rawSensorLog: true },
  });
  const conductivityCalibration = await getCalibration(deviceId);
  const health = computeDeviceHealth(device, readings, device.plantProfile, healthSettings.warmupMinDays, conductivityCalibration);
  client.publish(healthTopic(baseTopic, deviceId), JSON.stringify(health), { qos: 0, retain: true });
}

// Home Assistant's MQTT button component has no built-in per-press result channel (fire-and-forget
// command_topic only) — the outcome is surfaced back explicitly here regardless of trigger source
// (manual tRPC call, CRON scheduler, or this same HA button), so a failure stays visible in HA too
// and never just fire-and-forget (docs/STROYPLANT_SPEC.md section 7.1's non-negotiable rule,
// extended to the HA-visible side by this batch).
export function publishWateringResult(client: MqttClient, deviceId: string, result: WateringResult, baseTopic: string): void {
  const payload = { success: result.success, errorDetail: result.errorDetail ?? null, timestamp: new Date().toISOString() };
  client.publish(wateringResultTopic(baseTopic, deviceId), JSON.stringify(payload), { qos: 1, retain: true });
}
