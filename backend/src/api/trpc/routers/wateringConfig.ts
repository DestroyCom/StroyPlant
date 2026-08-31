import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { runWateringConfigPush } from '../../../wateringConfigPush.js';
import { getWateringConfigPushState, isWateringConfigPushRunning } from '../../../wateringConfigPushSession.js';
import { protectedProcedure, router } from '../trpc.js';

export const wateringConfigRouter = router({
  // Live read from the device, not from our DB — same "device is the source of truth" pattern as
  // plantDr.getCalibration.
  getConfig: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
    if (device.kind !== 'PARROT_POT') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Watering config is Parrot Pot only' });

    try {
      return await ctx.connectionQueue.run(() => ctx.provider.readWateringConfig(device.id));
    } catch (error) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: error instanceof Error ? error.message : String(error) });
    }
  }),

  // Polled by the frontend instead of blocking on the mutation's HTTP response — same shape as
  // plantDr.calibrationRunStatus.
  pushRunStatus: protectedProcedure
    .input(z.object({ deviceId: z.string() }))
    .query(({ input }) => getWateringConfigPushState(input.deviceId)),

  // Manual "Repousser maintenant" button — unlike the automatic call sites
  // (health.assignPlantProfile, schedule.upsert), this one throws CONFLICT synchronously instead
  // of silently skipping, since the user just pressed a button and expects immediate feedback.
  push: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
    if (device.kind !== 'PARROT_POT') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Watering config is Parrot Pot only' });
    if (isWateringConfigPushRunning(input.deviceId))
      throw new TRPCError({ code: 'CONFLICT', message: 'A config push is already running for this device' });

    void runWateringConfigPush({ provider: ctx.provider, connectionQueue: ctx.connectionQueue }, input.deviceId);
    return { status: 'started' as const };
  }),
});
