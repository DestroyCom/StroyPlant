import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { getActiveDiscoverySession, startDiscoverySession, stopDiscoverySession } from '../../../ble/discoverySession.js';
import { protectedProcedure, router } from '../trpc.js';

export const discoverySessionRouter = router({
  // Backs the "Ajouter un appareil" page's own start/stop lifecycle — whether a discovery
  // session is currently running (there's only ever one, globally).
  status: protectedProcedure.query(() => getActiveDiscoverySession()),

  // Returns the new session's id so the caller can later stop precisely this session (never
  // someone else's) — see discoverySession.ts's stopDiscoverySession for why this matters.
  start: protectedProcedure.mutation(({ ctx }) => {
    try {
      const sessionId = startDiscoverySession(ctx.provider);
      return { sessionId };
    } catch (error) {
      // Expected, not a bug: a session is already active (e.g. two browser tabs both on
      // "Ajouter un appareil").
      throw new TRPCError({ code: 'CONFLICT', message: error instanceof Error ? error.message : String(error) });
    }
  }),

  stop: protectedProcedure.input(z.object({ sessionId: z.string() })).mutation(({ input }) => {
    stopDiscoverySession(input.sessionId);
    return { ok: true as const };
  }),
});
