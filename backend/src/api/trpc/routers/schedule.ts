import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { resolveEffectiveSchedule } from '../../../health/scheduler.js';
import { serializeDate } from '../serialize.js';
import { protectedProcedure, router } from '../trpc.js';

export const scheduleRouter = router({
  // Always resolves to a full object (active/hours/cooldown), never null — a device with no
  // Schedule row yet still has a well-defined effective schedule (see resolveEffectiveSchedule),
  // which is what the "Arrosage automatique" section on the device detail page binds its form to.
  get: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const schedule = await prisma.schedule.findUnique({ where: { deviceId: input.deviceId } });
    return resolveEffectiveSchedule(device, schedule);
  }),

  upsert: protectedProcedure
    .input(
      z.object({
        deviceId: z.string(),
        active: z.boolean(),
        allowedStartHour: z.number().int().min(0).max(23),
        allowedEndHour: z.number().int().min(0).max(23),
        cooldownHours: z.number().int().min(1).max(168),
      }),
    )
    .mutation(async ({ input }) => {
      const { deviceId, ...data } = input;
      const device = await prisma.device.findUnique({ where: { id: deviceId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

      const schedule = await prisma.schedule.upsert({
        where: { deviceId },
        update: data,
        create: { deviceId, ...data },
      });
      return { ...schedule, updatedAt: serializeDate(schedule.updatedAt) };
    }),
});
