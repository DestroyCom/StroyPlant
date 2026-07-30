import { buildServer } from './api/server.js';
import { ConnectionQueue } from './ble/connectionQueue.js';
import { startNamedDevicePoller } from './ble/namedDevicePoller.js';
import { env } from './env.js';
import { startScheduler } from './health/scheduler.js';
import { log } from './logger.js';
import { initMqttManager } from './mqtt/manager.js';
import { createDeviceProvider } from './providers/factory.js';

async function main() {
  const provider = createDeviceProvider();
  const connectionQueue = new ConnectionQueue();

  log({ direction: 'INFO', label: `Starting StroyPlant backend — provider=${provider.name}`, result: 'OK' });

  // Connects (or logs "disabled" if no broker is configured in Settings) and publishes discovery
  // for every already-named device — subscribing to watering commands and republishing discovery
  // happen again automatically on every `reloadMqttClient()` call too (mqttSettings.upsert, tRPC).
  await initMqttManager(provider, connectionQueue);

  // Polls every already-named device on its own timer, independent of BLE discovery — see
  // docs/superpowers/specs/2026-07-30-scoped-ble-discovery-design.md. Discovery of NEW devices
  // only happens during an explicit discoverySession (started/stopped via tRPC from the
  // "Ajouter un appareil" page), never unconditionally at startup. The poll interval itself is
  // read live from PollSettings on every tick (see ble/pollSettings.ts), not passed in here.
  startNamedDevicePoller(provider, connectionQueue);

  startScheduler(provider, connectionQueue);

  const app = await buildServer(provider, connectionQueue);
  await app.listen({ port: env.port, host: '0.0.0.0' });
  log({ direction: 'INFO', label: `API listening on port ${env.port}`, result: 'OK' });
}

main().catch((error) => {
  log({ direction: 'INFO', label: 'Fatal startup error', result: 'ERROR', detail: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
