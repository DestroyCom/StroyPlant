import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth } from './auth.js';

export async function getSession(request: FastifyRequest) {
  return auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
}

// Protects every route/WS outside /api/auth/* — never exposed without protection
// (docs/STROYPLANT_SPEC.md section 7.6, same requirement for the future MCP server in Batch 8).
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const session = await getSession(request);
  if (!session) {
    reply.code(401);
    throw new Error('Unauthorized');
  }
}
