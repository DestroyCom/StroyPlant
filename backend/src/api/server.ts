import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
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
  // Fastify's router caps a single dynamic path segment at 100 chars by default
  // (FST_ERR_MAX_PARAM_LENGTH) — the tRPC plugin registers its whole route as one such segment
  // (`/:path`, matching everything after the /api/trpc prefix), and a batched call's path is every
  // procedure name joined by commas. Found 2026-08-29: the notification bell fires one
  // health.deviceHealth call per device on every page, and once batched alongside a page's own
  // handful of queries the joined path routinely exceeds 100 chars — a real, expected shape for
  // this app now, not a pathological one, so the limit is raised rather than avoided.
  const app = Fastify({ logger: false, maxParamLength: 2000 });
  await app.register(websocketPlugin);

  // CSP scoped to what this SPA actually needs: 'unsafe-inline' on styleSrc only (Radix/shadcn
  // components set inline `style` attributes for popover/dropdown positioning — script-src stays
  // strict). api.github.com is the version-check card's direct browser-side fetch
  // (version-settings-section.tsx); fr.wikipedia.org + upload.wikimedia.org are the "Base de
  // plantes" page's direct browser-side Wikipedia summary/thumbnail fetches
  // (use-wikipedia-summary.ts) — everything else this app talks to is same-origin.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://upload.wikimedia.org'],
        connectSrc: ["'self'", 'https://api.github.com', 'https://fr.wikipedia.org'],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    // Would block the SPA's own same-origin asset loading without a per-asset review this pass
    // didn't scope; X-Frame-Options/frame-ancestors above already closes the clickjacking gap.
    crossOriginEmbedderPolicy: false,
  });

  // Global floor across the whole API surface — the MCP discovery/tool-call routes below have no
  // rate limiting of their own otherwise. BetterAuth's own limiter separately covers /api/auth/*
  // (including the MCP OAuth register/authorize/token endpoints, all under /api/auth/mcp/*).
  await app.register(rateLimit, { global: true, max: 100, timeWindow: '1 minute' });

  registerRawBodyParser(app);

  // Must be registered before routes (unlike Express) — captures unhandled route/handler errors
  // into GlitchTip (see instrument.ts). A no-op if SENTRY_DSN isn't set.
  Sentry.setupFastifyErrorHandler(app);

  // Unauthenticated on purpose — read before login even happens, and it's not a secret (a
  // GlitchTip DSN is meant to be public in a client bundle). Deliberately never baked into the
  // frontend's build output though: this repo's Docker image is published publicly, and baking it
  // in would embed this deployment's error-tracking domain in that public artifact permanently.
  // Fetched live instead by frontend/src/instrument.ts on boot.
  app.get('/api/public-config', async () => ({ sentryDsn: env.sentryDsn ?? null, gitSha: env.gitSha }));

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
    trpcOptions: {
      router: appRouter,
      createContext: createContextFactory({ provider, connectionQueue }),
      // The frontend's httpBatchLink sets methodOverride: 'POST' (avoids a batched GET's input
      // ending up in the URL query string, which can exceed URI length limits — found 2026-08-29
      // once the notification bell added several always-on health.deviceHealth queries on top of
      // whatever a given route already fires). @trpc/server rejects POST for query procedures
      // unless explicitly opted in server-side — this is that opt-in; mutations are unaffected,
      // they were already POST-only.
      allowMethodOverride: true,
    },
  });

  // Registered last: its SPA-fallback notFoundHandler must never shadow the API/MCP/auth routes
  // above, so any request that reaches it genuinely isn't one of those.
  await registerStaticFrontend(app);

  return app;
}
