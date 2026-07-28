import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { log } from '../logger.js';

// Batch 9 (docs/STROYPLANT_SPEC.md section 14): production serves the frontend build from the
// same process/port as the API — no separate nginx/Caddy container. The Docker image places the
// Vite build at <app-root>/frontend-dist, a sibling of the compiled backend's dist/ (see
// Dockerfile) — this resolves to that path from wherever this compiled file ends up.
const FRONTEND_DIST = path.join(import.meta.dirname, '..', '..', 'frontend-dist');

// A local `pnpm dev` never has this directory (Vite's own dev server serves the frontend
// separately, proxying API calls to this backend) — skip registering entirely rather than
// erroring, so dev is unaffected.
export async function registerStaticFrontend(app: FastifyInstance): Promise<void> {
  if (!existsSync(FRONTEND_DIST)) {
    log({ direction: 'INFO', label: `Static frontend not found at ${FRONTEND_DIST} — skipping (expected in dev)`, result: 'OK' });
    return;
  }

  await app.register(fastifyStatic, { root: FRONTEND_DIST, wildcard: false });

  // Mandatory SPA fallback (section 14): any route that isn't /api/*, /mcp*, /.well-known/* nor an
  // existing static asset must return index.html, so TanStack Router's client-side routing works
  // on a hard refresh for a route like /devices/123 instead of 404ing.
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/mcp') || request.url.startsWith('/.well-known/')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}
