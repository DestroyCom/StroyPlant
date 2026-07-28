import mqtt, { type MqttClient } from 'mqtt';
import { env } from '../env.js';
import { log } from '../logger.js';
import { availabilityTopic } from './topics.js';

// Returns null when MQTT_URL is unset — the integration (Batch 7, docs/STROYPLANT_SPEC.md section
// 7.7) must stay entirely optional, since DestCom has no broker/Home Assistant instance to test
// against yet. Every call site treats a null client as "MQTT disabled", never as an error.
export function connectMqtt(): MqttClient | null {
  if (!env.mqttUrl) {
    log({ direction: 'INFO', label: 'MQTT disabled (MQTT_URL not set)', result: 'OK' });
    return null;
  }

  const availability = availabilityTopic(env.mqttBaseTopic);
  const client = mqtt.connect(env.mqttUrl, {
    username: env.mqttUsername,
    password: env.mqttPassword,
    will: { topic: availability, payload: 'offline', qos: 1, retain: true },
  });

  client.on('connect', () => {
    log({ direction: 'INFO', label: `MQTT connected to ${env.mqttUrl}`, result: 'OK' });
    client.publish(availability, 'online', { qos: 1, retain: true });
  });
  client.on('reconnect', () => log({ direction: 'INFO', label: 'MQTT reconnecting', result: 'OK' }));
  client.on('close', () => log({ direction: 'INFO', label: 'MQTT connection closed', result: 'ERROR' }));
  client.on('error', (error) => log({ direction: 'INFO', label: 'MQTT error', result: 'ERROR', detail: error.message }));

  return client;
}
