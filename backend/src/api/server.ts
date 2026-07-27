import websocketPlugin from '@fastify/websocket';
import Fastify from 'fastify';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import type { DeviceProvider } from '../providers/types.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerClient } from './ws.js';

export async function buildServer(provider: DeviceProvider, connectionQueue: ConnectionQueue) {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);

  app.get('/ws', { websocket: true }, (socket) => {
    registerClient(socket);
  });

  registerDeviceRoutes(app, { provider, connectionQueue });

  return app;
}
