import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { getMqttState } from '../../../mqtt/manager.js';
import { publishDiscovery } from '../../../mqtt/publisher.js';
import { triggerWatering } from '../../../watering.js';
import { serializeDate, serializeReading, serializeWateringEvent } from '../serialize.js';
import { protectedProcedure, router } from '../trpc.js';

type DeviceWithPlantProfile = Prisma.DeviceGetPayload<{ include: { plantProfile: true } }>;

// Shared by every procedure returning a Device — the last reading isn't a direct Prisma relation
// on the "current" state, so it's fetched and attached manually.
async function withLastReading(device: DeviceWithPlantProfile) {
  const lastReading = await prisma.reading.findFirst({
    where: { deviceId: device.id },
    orderBy: { timestamp: 'desc' },
  });
  return { ...device, lastSeenAt: serializeDate(device.lastSeenAt), lastReading: serializeReading(lastReading) };
}

export const devicesRouter = router({
  // Only devices the user has named are shown on the dashboard — a device the scanner just
  // discovered stays unnamed until claimed through `add` (devices.listUnnamed / devices.rename),
  // so the dashboard never fills up with devices the user hasn't chosen to track yet.
  list: protectedProcedure.query(async () => {
    const devices = await prisma.device.findMany({ where: { name: { not: null } }, include: { plantProfile: true } });
    return Promise.all(devices.map(withLastReading));
  }),

  listUnnamed: protectedProcedure.query(async () => {
    const devices = await prisma.device.findMany({ where: { name: null }, include: { plantProfile: true } });
    return Promise.all(devices.map(withLastReading));
  }),

  rename: protectedProcedure.input(z.object({ deviceId: z.string(), name: z.string().trim().min(1) })).mutation(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const updated = await prisma.device.update({
      where: { id: input.deviceId },
      data: { name: input.name },
      include: { plantProfile: true },
    });

    // A device is only published to Home Assistant once claimed (named) — matches `devices.list`'s
    // own filter, so nothing appears in HA that isn't already tracked in StroyPlant's own dashboard.
    const mqttState = getMqttState();
    if (mqttState) publishDiscovery(mqttState.client, updated, mqttState);

    return withLastReading(updated);
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

    const result = await triggerWatering(device.id, 'MANUAL', ctx.provider, ctx.connectionQueue);
    if (!result.success) throw new TRPCError({ code: 'BAD_GATEWAY', message: result.errorDetail });
    return { ok: true as const };
  }),
});
