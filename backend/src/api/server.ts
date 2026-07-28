import websocketPlugin from '@fastify/websocket';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import { fromNodeHeaders } from 'better-auth/node';
import Fastify from 'fastify';
import type { MqttClient } from 'mqtt';
import { auth } from '../auth/auth.js';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import type { DeviceProvider } from '../providers/types.js';
import { createContextFactory } from './trpc/context.js';
import { appRouter } from './trpc/router.js';

export async function buildServer(provider: DeviceProvider, connectionQueue: ConnectionQueue, mqttClient: MqttClient | null = null) {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);

  // BetterAuth handler (login/logout/session/...) — never behind requireAuth, it manages
  // its own access logic (official pattern, see docs/integrations/fastify).
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const headers = fromNodeHeaders(request.headers);
      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      });
      const response = await auth.handler(req);
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      return reply.send(response.body ? await response.text() : null);
    },
  });

  // All devices/health/readings procedures require a session (protectedProcedure, see
  // api/trpc/trpc.ts) — never exposed without protection (section 7.6, same requirement for the
  // future MCP server in Batch 8). useWSS shares this same prefix for the readings.onReading
  // subscription's WS upgrade, reusing the @fastify/websocket plugin registered above.
  await app.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    useWSS: true,
    trpcOptions: { router: appRouter, createContext: createContextFactory({ provider, connectionQueue, mqttClient }) },
  });

  return app;
}
