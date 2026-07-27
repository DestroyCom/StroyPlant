import websocketPlugin from '@fastify/websocket';
import { fromNodeHeaders } from 'better-auth/node';
import Fastify from 'fastify';
import { auth } from '../auth/auth.js';
import { requireAuth } from '../auth/session.js';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import type { DeviceProvider } from '../providers/types.js';
import { registerDeviceRoutes } from './routes/devices.js';
import { registerClient } from './ws.js';

export async function buildServer(provider: DeviceProvider, connectionQueue: ConnectionQueue) {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);

  // Handler BetterAuth (login/logout/session/...) — jamais derrière requireAuth, c'est lui qui gère
  // sa propre logique d'accès (pattern officiel, voir docs/integrations/fastify).
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

  // WS protégé : session vérifiée en preValidation, avant l'upgrade (échec = réponse HTTP normale,
  // pas de socket ouvert puis fermé).
  app.get('/ws', { websocket: true, preValidation: requireAuth }, (socket) => {
    registerClient(socket);
  });

  // Tout /api/devices/* requiert une session — jamais exposé sans protection (section 7.6, même
  // exigence pour le futur serveur MCP du Lot 8).
  await app.register(async (secured) => {
    secured.addHook('preHandler', requireAuth);
    registerDeviceRoutes(secured, { provider, connectionQueue });
  });

  return app;
}
