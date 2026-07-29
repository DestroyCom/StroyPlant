import { on } from 'node:events';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import {
  getActiveLiveSession,
  type LiveSessionEvent,
  liveSessionEmitter,
  startLiveSession,
  stopLiveSession,
} from '../../../liveSession/manager.js';
import { protectedProcedure, router } from '../trpc.js';

export const liveSessionRouter = router({
  // Which device (if any) currently holds the single shared GATT connection for a live session —
  // backs the "Mode live" button's disabled state on every other device's page.
  status: protectedProcedure.query(() => getActiveLiveSession()),

  start: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    try {
      startLiveSession(device.id, device.kind, ctx.provider, ctx.connectionQueue);
    } catch (error) {
      // Expected, not a bug: another device already has the single shared connection
      // (docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md).
      throw new TRPCError({ code: 'CONFLICT', message: error instanceof Error ? error.message : String(error) });
    }
    return { ok: true as const };
  }),

  stop: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(({ input }) => {
    stopLiveSession(input.deviceId);
    return { ok: true as const };
  }),

  // Same on()-based async-iterator pattern as readings.onReading (routers/readings.ts) — filters
  // the shared emitter down to the one device this subscriber actually asked about, since
  // liveSessionEmitter broadcasts every active session's events regardless of which page is open.
  onSample: protectedProcedure.input(z.object({ deviceId: z.string() })).subscription(async function* (opts) {
    for await (const [event] of on(liveSessionEmitter, 'event', { signal: opts.signal })) {
      const typedEvent = event as LiveSessionEvent;
      if (typedEvent.deviceId === opts.input.deviceId) yield typedEvent;
    }
  }),
});
