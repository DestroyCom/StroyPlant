import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { oAuthDiscoveryMetadata, oAuthProtectedResourceMetadata, withMcpAuth } from 'better-auth/plugins';
import type { FastifyInstance } from 'fastify';
import type { TrpcDeps } from '../api/trpc/context.js';
import { sendWebResponse, toWebRequest } from '../api/webBridge.js';
import { auth } from '../auth/auth.js';
import { buildMcpContext } from './context.js';
import { buildMcpServer } from './server.js';

// Batch 8 (docs/STROYPLANT_SPEC.md section 7.8): the MCP server is mounted directly on the same
// always-running Fastify backend (not a separate stdio process) — reuses the same BLE
// provider/connectionQueue/MQTT client via `deps`, confirmed with DestCom over a separate process.
export function registerMcpRoutes(app: FastifyInstance, deps: TrpcDeps): void {
  // RFC 8414 / RFC 9728 discovery metadata — real MCP clients fetch these at the true server root
  // (never under /api/auth/*) to find the authorization server and register themselves.
  app.get('/.well-known/oauth-authorization-server', async (request, reply) => {
    const response = await oAuthDiscoveryMetadata(auth)(toWebRequest(request));
    return sendWebResponse(reply, response);
  });
  app.get('/.well-known/oauth-protected-resource', async (request, reply) => {
    const response = await oAuthProtectedResourceMetadata(auth)(toWebRequest(request));
    return sendWebResponse(reply, response);
  });

  const mcpHandler = withMcpAuth(auth, async (req, session) => {
    const ctx = await buildMcpContext(session, deps);
    if (!ctx) {
      return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Unknown MCP session user' }, id: null }, { status: 401 });
    }

    // Stateless mode, a fresh McpServer + transport per request: these 4 tools are simple
    // request/response calls with no server-initiated push, so there's no session state worth
    // keeping between calls — the MCP SDK's own documented pattern for stateless deployments.
    // enableJsonResponse avoids a real SSE stream, which the Fastify<->Web bridge below doesn't
    // support (it buffers the whole response via response.text()).
    const server = buildMcpServer(ctx);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(req);
  });

  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    async handler(request, reply) {
      const response = await mcpHandler(toWebRequest(request));
      return sendWebResponse(reply, response);
    },
  });
}
