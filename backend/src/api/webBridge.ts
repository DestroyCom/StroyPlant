import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Fastify (Node req/res) <-> Web standard Request/Response bridge — BetterAuth's own handler and,
// since Batch 8, the MCP OAuth/discovery endpoints both expect Fetch API types. Written once here
// instead of duplicated per route.
//
// The OAuth token endpoint (/api/auth/mcp/token) accepts application/x-www-form-urlencoded per
// RFC 6749 — real OAuth clients send that, not JSON. Fastify only parses JSON by default, so
// `registerRawBodyParser` (called once at server startup) registers a passthrough parser for that
// content type that keeps the raw string instead of parsing it into an object; BetterAuth's own
// handler parses the body itself. JSON bodies (every other call site) are unaffected.
export function registerRawBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
}

export function toWebRequest(request: FastifyRequest): Request {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const body = typeof request.body === 'string' ? request.body : request.body ? JSON.stringify(request.body) : undefined;
  return new Request(url.toString(), {
    method: request.method,
    headers: fromNodeHeaders(request.headers),
    ...(body ? { body } : {}),
  });
}

export async function sendWebResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.status(response.status);
  response.headers.forEach((value, key) => {
    reply.header(key, value);
  });
  return reply.send(response.body ? await response.text() : null);
}
