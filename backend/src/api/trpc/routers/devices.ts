import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { log } from '../../../logger.js';
import { getMqttState } from '../../../mqtt/manager.js';
import { publishDiscovery } from '../../../mqtt/publisher.js';
import { persistReading, persistSyncFailure } from '../../../readings.js';
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

  // Edits from the device detail page, after claiming (unlike `rename`, which is the claim step
  // itself and always requires a non-empty name) — all 3 fields optional/independent so the
  // frontend can save just one at a time. `environment` is storage only for now (DestCom's explicit
  // choice, 2026-07-29): the Health Engine still scores every device against the same
  // indoor-calibrated WatchFlower ranges regardless of this value — see docs/HEALTH_ENGINE.md and
  // the Environment enum's comment in schema.prisma.
  updateDetails: protectedProcedure
    .input(
      z.object({
        deviceId: z.string(),
        name: z.string().trim().min(1).optional(),
        location: z.string().trim().max(120).nullable().optional(),
        environment: z.enum(['INDOOR', 'OUTDOOR']).nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

      const data: Prisma.DeviceUpdateInput = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.location !== undefined) data.location = input.location;
      if (input.environment !== undefined) data.environment = input.environment;

      const updated = await prisma.device.update({ where: { id: input.deviceId }, data, include: { plantProfile: true } });

      // Only the name change is relevant to Home Assistant's entity naming — matches `rename`'s
      // own reasoning above.
      if (input.name !== undefined) {
        const mqttState = getMqttState();
        if (mqttState) publishDiscovery(mqttState.client, updated, mqttState);
      }

      return withLastReading(updated);
    }),

  history: protectedProcedure.input(z.object({ deviceId: z.string(), hours: z.number().optional() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const hours = input.hours ?? 24;
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
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

  // Manual "sync now" — reads the device immediately instead of waiting for the scanner's next
  // ~5min poll (backend/src/ble/scanner.ts). Goes through the same connectionQueue as every other
  // GATT operation (only one connection at a time, shared with the scanner/scheduler) and persists
  // through the exact same persistReading() the automatic poll cycle uses (backend/src/readings.ts)
  // — a manual sync is not a separate, parallel code path, matching how devices.water already
  // shares triggerWatering() with the auto-watering scheduler.
  sync: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    let reading: Awaited<ReturnType<typeof ctx.provider.readSensors>>;
    try {
      reading = await ctx.connectionQueue.run(() => ctx.provider.readSensors(device.id, device.kind));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Never let a secondary persistSyncFailure failure mask the real BLE error above — same
      // catch-and-log pattern as forceSyncAll below and the scanner's own pollDeviceNow.
      await persistSyncFailure(device.id, 'MANUAL', detail).catch((persistError) => {
        log({
          direction: 'INFO',
          label: 'persistSyncFailure failed',
          deviceId: device.id,
          result: 'ERROR',
          detail: persistError instanceof Error ? persistError.message : String(persistError),
        });
      });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: detail });
    }

    await persistReading(device.id, device.kind, reading, 'POLL');

    const updated = await prisma.device.findUniqueOrThrow({ where: { id: device.id }, include: { plantProfile: true } });
    return withLastReading(updated);
  }),

  // "Forcer la synchro" (dashboard button) — same idea as `sync` above, but for every named device
  // at once. Deliberately doesn't await each read to completion: with up to 5 sequential GATT
  // connections behind the single connectionQueue, a full sweep can take well over a minute, and
  // there's no reason to hold the HTTP request open for that — each device still goes through the
  // exact same connectionQueue-serialized read + persistReading() path as `sync`/the automatic
  // poll, and pushes live to the frontend via the existing readings.onReading subscription as soon
  // as it lands. This mutation only confirms the syncs were queued, logging (never throwing) any
  // individual failure the same way the scanner's own poll loop already does.
  forceSyncAll: protectedProcedure.mutation(async ({ ctx }) => {
    const devices = await prisma.device.findMany({ where: { name: { not: null } } });
    for (const device of devices) {
      void ctx.connectionQueue
        .run(() => ctx.provider.readSensors(device.id, device.kind))
        .then((reading) => persistReading(device.id, device.kind, reading, 'POLL'))
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          log({
            direction: 'READ',
            label: 'Forced sync readSensors failed',
            deviceId: device.id,
            result: 'ERROR',
            detail,
          });
          void persistSyncFailure(device.id, 'MANUAL', detail).catch((persistError) => {
            log({
              direction: 'INFO',
              label: 'persistSyncFailure failed',
              deviceId: device.id,
              result: 'ERROR',
              detail: persistError instanceof Error ? persistError.message : String(persistError),
            });
          });
        });
    }
    return { triggered: devices.length };
  }),
});
