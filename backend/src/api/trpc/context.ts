import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { auth } from '../../auth/auth.js';
import type { ConnectionQueue } from '../../ble/connectionQueue.js';
import type { DeviceProvider } from '../../providers/types.js';

export interface TrpcDeps {
  provider: DeviceProvider;
  connectionQueue: ConnectionQueue;
}

// Resolves the BetterAuth session the same way getSession()/requireAuth do today
// (backend/src/auth/session.ts) — same cookie-based mechanism, just wired into tRPC's context
// instead of a Fastify preHandler hook.
export function createContextFactory(deps: TrpcDeps) {
  return async function createContext({ req }: CreateFastifyContextOptions) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return { session, ...deps };
  };
}

export type Context = Awaited<ReturnType<ReturnType<typeof createContextFactory>>>;
