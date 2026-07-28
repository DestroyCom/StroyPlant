import type { MqttClient } from 'mqtt';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import { prisma } from '../db/client.js';
import { env } from '../env.js';
import { log } from '../logger.js';
import type { DeviceProvider } from '../providers/types.js';
import { triggerWatering } from '../watering.js';
import { sanitizeDeviceId, wateringCommandFilter } from './topics.js';

async function findDeviceBySanitizedId(sanitizedId: string) {
  const devices = await prisma.device.findMany({ where: { name: { not: null } } });
  return devices.find((device) => sanitizeDeviceId(device.id) === sanitizedId) ?? null;
}

async function handleWateringPress(sanitizedId: string, provider: DeviceProvider, connectionQueue: ConnectionQueue, client: MqttClient) {
  const device = await findDeviceBySanitizedId(sanitizedId);
  if (!device) {
    log({ direction: 'INFO', label: 'MQTT watering command for unknown device', result: 'ERROR', detail: sanitizedId });
    return;
  }
  if (device.kind !== 'PARROT_POT') {
    log({ direction: 'INFO', label: 'MQTT watering command for a non-Parrot-Pot device ignored', deviceId: device.id, result: 'ERROR' });
    return;
  }

  await triggerWatering(device.id, 'MANUAL', provider, connectionQueue, client);
}

// Subscribes once to every device's watering command topic (wildcard) — the HA "Arroser
// maintenant" button (mqtt/discovery.ts) publishes here on press. Reuses the exact same
// `triggerWatering` shared with the tRPC `devices.water` mutation and the CRON scheduler, so the
// never-fire-and-forget guarantee (docs/STROYPLANT_SPEC.md section 7.1) applies identically no
// matter which surface triggered the watering.
export function subscribeWateringCommands(client: MqttClient, provider: DeviceProvider, connectionQueue: ConnectionQueue): void {
  const filter = wateringCommandFilter(env.mqttBaseTopic);
  const filterRegex = new RegExp(`^${env.mqttBaseTopic}/([^/]+)/watering/set$`);

  client.subscribe(filter, { qos: 1 }, (error) => {
    if (error) log({ direction: 'INFO', label: 'MQTT subscribe to watering commands failed', result: 'ERROR', detail: error.message });
  });

  client.on('message', (topic) => {
    const match = topic.match(filterRegex);
    if (!match) return;
    void handleWateringPress(match[1], provider, connectionQueue, client);
  });
}
