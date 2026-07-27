import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth } from './auth.js';

export async function getSession(request: FastifyRequest) {
  return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
}

// Protège toute route/WS en dehors de /api/auth/* — jamais exposé sans protection
// (docs/STROYPLANT_SPEC.md section 7.6, même exigence pour le futur serveur MCP du Lot 8).
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await getSession(request);
  if (!session) {
    reply.code(401);
    throw new Error('Unauthorized');
  }
}
