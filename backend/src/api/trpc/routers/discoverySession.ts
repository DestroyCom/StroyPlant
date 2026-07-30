import { TRPCError } from '@trpc/server';
import { getActiveDiscoverySession, startDiscoverySession, stopDiscoverySession } from '../../../ble/discoverySession.js';
import { protectedProcedure, router } from '../trpc.js';

export const discoverySessionRouter = router({
  // Backs the "Ajouter un appareil" page's own start/stop lifecycle — whether a discovery
  // session is currently running (there's only ever one, globally).
  status: protectedProcedure.query(() => getActiveDiscoverySession()),

  start: protectedProcedure.mutation(({ ctx }) => {
    try {
      startDiscoverySession(ctx.provider);
    } catch (error) {
      // Expected, not a bug: a session is already active (e.g. two browser tabs both on
      // "Ajouter un appareil").
      throw new TRPCError({ code: 'CONFLICT', message: error instanceof Error ? error.message : String(error) });
    }
    return { ok: true as const };
  }),

  stop: protectedProcedure.mutation(() => {
    stopDiscoverySession();
    return { ok: true as const };
  }),
});
