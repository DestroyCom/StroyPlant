import mqtt, { type MqttClient } from 'mqtt';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import { prisma } from '../db/client.js';
import { log } from '../logger.js';
import type { DeviceProvider } from '../providers/types.js';
import { subscribeWateringCommands } from './commands.js';
import { publishDiscovery } from './publisher.js';
import { availabilityTopic, type MqttTopicSettings } from './topics.js';

export interface MqttState extends MqttTopicSettings {
  client: MqttClient;
}

// MQTT configuration lives in the MqttSettings DB row, editable from the Settings page — not env
// vars (DestCom's explicit choice, moved off Batch 7's original env-var-only design: a single
// source of truth, no fallback mechanism to keep in sync). The connection is therefore
// live-reconfigurable rather than fixed at process startup: `reloadMqttClient()` re-reads the DB
// row and replaces the current client, called once at boot (`initMqttManager`) and again every
// time `mqttSettings.upsert` (tRPC) saves a change.
let state: MqttState | null = null;
let deps: { provider: DeviceProvider; connectionQueue: ConnectionQueue } | null = null;

// A plain module-level singleton (like `db/client.js`'s `prisma` export) rather than dependency
// injection through TrpcDeps/scheduler/etc. — there is exactly one MQTT connection for the whole
// process, and threading a value that can now change at runtime through every constructor call
// site would need the same singleton lookup at the other end anyway.
export function getMqttState(): MqttState | null {
  return state;
}

export async function initMqttManager(provider: DeviceProvider, connectionQueue: ConnectionQueue): Promise<void> {
  deps = { provider, connectionQueue };
  await reloadMqttClient();
}

export async function reloadMqttClient(): Promise<void> {
  if (!deps) throw new Error('initMqttManager must be called before reloadMqttClient');

  if (state) {
    state.client.removeAllListeners();
    state.client.end(true);
    state = null;
  }

  const settings = await prisma.mqttSettings.findUnique({ where: { id: 1 } });
  if (!settings?.url) {
    log({ direction: 'INFO', label: 'MQTT disabled (no broker configured in Settings)', result: 'OK' });
    return;
  }

  const { baseTopic, discoveryPrefix } = settings;
  const availability = availabilityTopic(baseTopic);
  const client = mqtt.connect(settings.url, {
    username: settings.username ?? undefined,
    password: settings.password ?? undefined,
    will: { topic: availability, payload: 'offline', qos: 1, retain: true },
  });

  client.on('connect', () => {
    log({ direction: 'INFO', label: `MQTT connected to ${settings.url}`, result: 'OK' });
    client.publish(availability, 'online', { qos: 1, retain: true });
  });
  client.on('reconnect', () => log({ direction: 'INFO', label: 'MQTT reconnecting', result: 'OK' }));
  client.on('close', () => log({ direction: 'INFO', label: 'MQTT connection closed', result: 'ERROR' }));
  client.on('error', (error) => log({ direction: 'INFO', label: 'MQTT error', result: 'ERROR', detail: error.message }));

  state = { client, baseTopic, discoveryPrefix };

  subscribeWateringCommands(client, deps.provider, deps.connectionQueue, baseTopic);

  const namedDevices = await prisma.device.findMany({ where: { name: { not: null } } });
  for (const device of namedDevices) publishDiscovery(client, device, { baseTopic, discoveryPrefix });
}
