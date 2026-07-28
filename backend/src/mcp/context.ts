import type { Context, TrpcDeps } from '../api/trpc/context.js';
import { prisma } from '../db/client.js';

interface McpOAuthSession {
  userId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
}

// The MCP OAuth session (BetterAuth's `mcp` plugin, an OAuthAccessToken row) has a different shape
// than the browser cookie session tRPC procedures expect. Only `userId` is used to resolve the real
// user, then a minimal but type-compliant Session-shaped object is built so `protectedProcedure`'s
// truthiness check and `appRouter.createCaller()` both work unchanged — no procedure reads session
// fields beyond that (docs/STROYPLANT_SPEC.md section 7.8).
export async function buildMcpContext(oauthSession: McpOAuthSession, deps: TrpcDeps): Promise<Context | null> {
  const user = await prisma.user.findUnique({ where: { id: oauthSession.userId } });
  if (!user) return null;

  return {
    ...deps,
    session: {
      user,
      session: {
        id: `mcp-${oauthSession.accessToken.slice(0, 16)}`,
        createdAt: new Date(),
        updatedAt: new Date(),
        userId: user.id,
        expiresAt: oauthSession.accessTokenExpiresAt,
        token: oauthSession.accessToken,
        ipAddress: null,
        userAgent: null,
        impersonatedBy: null,
      },
    },
  };
}
