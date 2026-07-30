import websocketPlugin from '@fastify/websocket';
import * as Sentry from '@sentry/node';
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify';
import Fastify from 'fastify';
import { auth } from '../auth/auth.js';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import { env } from '../env.js';
import { registerMcpRoutes } from '../mcp/routes.js';
import type { DeviceProvider } from '../providers/types.js';
import { registerStaticFrontend } from './staticFrontend.js';
import { createContextFactory } from './trpc/context.js';
import { appRouter } from './trpc/router.js';
import { registerRawBodyParser, sendWebResponse, toWebRequest } from './webBridge.js';

export async function buildServer(provider: DeviceProvider, connectionQueue: ConnectionQueue) {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);
  registerRawBodyParser(app);

  // Must be registered before routes (unlike Express) — captures unhandled route/handler errors
  // into GlitchTip (see instrument.ts). A no-op if SENTRY_DSN isn't set.
  Sentry.setupFastifyErrorHandler(app);

  // Unauthenticated on purpose — read before login even happens, and it's not a secret (a
  // GlitchTip DSN is meant to be public in a client bundle). Deliberately never baked into the
  // frontend's build output though: this repo's Docker image is published publicly, and baking it
  // in would embed this deployment's error-tracking domain in that public artifact permanently.
  // Fetched live instead by frontend/src/instrument.ts on boot.
  app.get('/api/public-config', async () => ({ sentryDsn: env.sentryDsn ?? null }));

  // BetterAuth handler (login/logout/session/...) — never behind requireAuth, it manages
  // its own access logic (official pattern, see docs/integrations/fastify).
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const response = await auth.handler(toWebRequest(request));
      return sendWebResponse(reply, response);
    },
  });

  // MCP server (Batch 8, docs/STROYPLANT_SPEC.md section 7.8) — OAuth discovery metadata + the
  // /mcp tool endpoint, protected by BetterAuth's `mcp` plugin.
  registerMcpRoutes(app, { provider, connectionQueue });

  // All devices/health/readings procedures require a session (protectedProcedure, see
  // api/trpc/trpc.ts) — never exposed without protection (section 7.6, same requirement enforced
  // for the MCP server above via a different mechanism, OAuth rather than a cookie session).
  // useWSS shares this same prefix for the readings.onReading subscription's WS upgrade, reusing
  // the @fastify/websocket plugin registered above.
  await app.register(fastifyTRPCPlugin, {
    prefix: '/api/trpc',
    useWSS: true,
    trpcOptions: { router: appRouter, createContext: createContextFactory({ provider, connectionQueue }) },
  });

  // Registered last: its SPA-fallback notFoundHandler must never shadow the API/MCP/auth routes
  // above, so any request that reaches it genuinely isn't one of those.
  await registerStaticFrontend(app);

  return app;
}
