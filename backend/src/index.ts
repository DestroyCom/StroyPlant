import { buildServer } from './api/server.js';
import { ConnectionQueue } from './ble/connectionQueue.js';
import { startScanner } from './ble/scanner.js';
import { prisma } from './db/client.js';
import { env } from './env.js';
import { startScheduler } from './health/scheduler.js';
import { log } from './logger.js';
import { getMqttState, initMqttManager } from './mqtt/manager.js';
import { publishDiscovery } from './mqtt/publisher.js';
import { createDeviceProvider } from './providers/factory.js';
import { persistReading } from './readings.js';

async function main() {
  const provider = createDeviceProvider();
  const connectionQueue = new ConnectionQueue();

  log({ direction: 'INFO', label: `Starting StroyPlant backend — provider=${provider.name}`, result: 'OK' });

  // Connects (or logs "disabled" if no broker is configured in Settings) and publishes discovery
  // for every already-named device — subscribing to watering commands and republishing discovery
  // happen again automatically on every `reloadMqttClient()` call too (mqttSettings.upsert, tRPC).
  await initMqttManager(provider, connectionQueue);

  startScanner(
    provider,
    {
      async onDeviceSeen(device) {
        const previous = await prisma.device.findUnique({ where: { id: device.id } });
        const upserted = await prisma.device.upsert({
          where: { id: device.id },
          create: { id: device.id, kind: device.kind, name: device.name, lastSeenAt: new Date() },
          update: { name: device.name, lastSeenAt: new Date() },
        });

        // Real BLE providers never populate `device.name` (only `devices.rename`, hooked
        // separately, claims a device) — this only fires for the mock provider's pre-named
        // devices, so their MQTT discovery still gets published once without waiting on a rename
        // that will never happen in that case.
        const mqttState = getMqttState();
        if (mqttState && upserted.name != null && previous?.name == null) {
          publishDiscovery(mqttState.client, upserted, mqttState);
        }
      },
      async onReading(deviceId, kind, reading) {
        await persistReading(deviceId, kind, reading);
      },
    },
    connectionQueue,
    env.parrotPollIntervalMs,
  );

  startScheduler(provider, connectionQueue);

  const app = await buildServer(provider, connectionQueue);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  log({ direction: 'INFO', label: `API listening on port ${env.port}`, result: 'OK' });
}

main().catch((error) => {
  log({ direction: 'INFO', label: 'Fatal startup error', result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
