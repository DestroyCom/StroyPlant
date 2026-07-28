import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { env } from '../../../env.js';
import { computeDeviceHealth } from '../../../health/scoring.js';
import { serializeDate } from '../serialize.js';
import { protectedProcedure, router } from '../trpc.js';

export const healthRouter = router({
  plantProfiles: protectedProcedure.input(z.object({ search: z.string().optional() })).query(async ({ input }) => {
    const search = input.search?.trim();
    return prisma.plantProfile.findMany({
      where: search ? { name: { contains: search } } : undefined,
      orderBy: { name: 'asc' },
      take: 20,
    });
  }),

  assignPlantProfile: protectedProcedure
    .input(z.object({ deviceId: z.string(), plantProfileId: z.number().nullable() }))
    .mutation(async ({ input }) => {
      const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

      if (input.plantProfileId != null) {
        const profile = await prisma.plantProfile.findUnique({ where: { id: input.plantProfileId } });
        if (!profile) throw new TRPCError({ code: 'NOT_FOUND', message: 'Plant profile not found' });
      }

      const updated = await prisma.device.update({
        where: { id: device.id },
        data: { plantProfileId: input.plantProfileId },
        include: { plantProfile: true },
      });
      return { ...updated, lastSeenAt: serializeDate(updated.lastSeenAt) };
    }),

  deviceHealth: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId }, include: { plantProfile: true } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const since = new Date(Date.now() - env.healthBaselineWindowDays * 24 * 3600_000);
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since } },
      orderBy: { timestamp: 'asc' },
    });

    return computeDeviceHealth(device, readings, device.plantProfile);
  }),
});
