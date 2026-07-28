import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { log } from '../../../logger.js';
import { serializeDate, serializeReading, serializeWateringEvent } from '../serialize.js';
import { protectedProcedure, router } from '../trpc.js';

export const devicesRouter = router({
  list: protectedProcedure.query(async () => {
    const devices = await prisma.device.findMany({ include: { plantProfile: true } });
    return Promise.all(
      devices.map(async (device) => {
        const lastReading = await prisma.reading.findFirst({
          where: { deviceId: device.id },
          orderBy: { timestamp: 'desc' },
        });
        return { ...device, lastSeenAt: serializeDate(device.lastSeenAt), lastReading: serializeReading(lastReading) };
      }),
    );
  }),

  history: protectedProcedure.input(z.object({ deviceId: z.string(), hours: z.number().optional() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const hours = input.hours ?? 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });
    return readings.map((reading) => serializeReading(reading));
  }),

  wateringEvents: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const events = await prisma.wateringEvent.findMany({
      where: { deviceId: device.id },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });
    return events.map(serializeWateringEvent);
  }),

  water: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    try {
      await ctx.connectionQueue.run(() => ctx.provider.triggerAction(device.id, 'water'));
      await prisma.wateringEvent.create({
        data: { deviceId: device.id, triggerSource: 'MANUAL', success: true },
      });
      return { ok: true as const };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Never fire-and-forget (docs/STROYPLANT_SPEC.md section 7.1, identified WatchFlower bug) — the
      // failure is explicitly logged to the database AND surfaced to the caller, not just logged server-side.
      await prisma.wateringEvent.create({
        data: { deviceId: device.id, triggerSource: 'MANUAL', success: false, errorDetail: detail },
      });
      log({ direction: 'WRITE', label: 'Manual watering trigger failed', deviceId: device.id, result: 'ERROR', detail });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: detail });
    }
  }),
});
