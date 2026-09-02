import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CONNECT_TIMEOUT_MS, withTimeout } from '../../../ble/parrot/retry.js';
import { prisma } from '../../../db/client.js';
import { getCalibration, resolveConductivityValue } from '../../../health/soilConductivityCalibration.js';
import { getActiveLiveConnectionHandle, stopLiveSession } from '../../../liveSession/manager.js';
import { log } from '../../../logger.js';
import { getMqttState } from '../../../mqtt/manager.js';
import { publishDiscovery } from '../../../mqtt/publisher.js';
import { persistReading, persistSyncFailure } from '../../../readings.js';
import { recordWateringOutcome, triggerWatering } from '../../../watering.js';
import { serializeDate, serializeReading, serializeWateringEvent } from '../serialize.js';
import { protectedProcedure, router } from '../trpc.js';

type DeviceWithPlantProfile = Prisma.DeviceGetPayload<{ include: { plantProfile: true } }>;

// Shared by every procedure returning a Device — the last reading isn't a direct Prisma relation
// on the "current" state, so it's fetched and attached manually.
async function withLastReading(device: DeviceWithPlantProfile) {
  const lastReading = await prisma.reading.findFirst({
    where: { deviceId: device.id },
    orderBy: { timestamp: 'desc' },
    include: { rawSensorLog: true },
  });
  if (lastReading) {
    const calibration = await getCalibration(device.id);
    lastReading.soilConductivityUsCm = resolveConductivityValue(lastReading, calibration);
  }
  return { ...device, lastSeenAt: serializeDate(device.lastSeenAt), lastReading: serializeReading(lastReading) };
}

// Le chemin rapide (écriture sur la connexion live déjà ouverte) doit échouer vite pour ne jamais
// retarder le repli vers le chemin normal plus que nécessaire — bien plus court que
// CONNECT_TIMEOUT_MS (18s), qui couvre l'ouverture d'une connexion complète, pas une simple
// écriture sur une connexion déjà établie.
const LIVE_WATERING_FAST_PATH_TIMEOUT_MS = 5000;

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

  // Registers a device directly by its known BLE address, without waiting for a discovery
  // session to find it — for a device that's temporarily out of range, or when the user already
  // knows the address (docs/superpowers/specs/2026-07-30-scoped-ble-discovery-design.md).
  addByAddress: protectedProcedure
    .input(
      z.object({
        macAddress: z
          .string()
          .trim()
          .regex(/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/, 'Adresse invalide (format attendu : AA:BB:CC:DD:EE:FF)')
          .transform((value) => value.toUpperCase()),
        kind: z.enum(['PARROT_POT', 'XIAOMI_LYWSD03MMC']),
        name: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await prisma.device.findUnique({ where: { id: input.macAddress } });
      if (existing) throw new TRPCError({ code: 'CONFLICT', message: 'Un appareil avec cette adresse existe déjà' });

      const created = await prisma.device.create({
        data: { id: input.macAddress, kind: input.kind, name: input.name, lastSeenAt: new Date() },
        include: { plantProfile: true },
      });

      const mqttState = getMqttState();
      if (mqttState) publishDiscovery(mqttState.client, created, mqttState);

      return withLastReading(created);
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
      include: { rawSensorLog: true },
    });
    const calibration = await getCalibration(device.id);
    for (const reading of readings) {
      reading.soilConductivityUsCm = resolveConductivityValue(reading, calibration);
    }
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

    // Chemin rapide : une session live est en cours sur ce device, on réutilise sa connexion GATT
    // déjà ouverte au lieu d'attendre la fin de la session (jusqu'à 5min) pour passer par
    // connectionQueue (voir docs/superpowers/specs/2026-09-02-live-mode-default-design.md, "Key
    // constraint"). Un échec de l'ÉCRITURE PHYSIQUE ici n'est PAS enregistré comme un échec
    // d'arrosage — ce n'est qu'une tentative interne, le vrai résultat est celui du repli
    // ci-dessous, qui, lui, est toujours enregistré (docs/STROYPLANT_SPEC.md section 7.1).
    const liveHandle = getActiveLiveConnectionHandle(device.id);
    if (liveHandle) {
      const fastPathAttempt = liveHandle.triggerWatering();
      let fastPathSucceeded = false;
      try {
        await withTimeout(fastPathAttempt, LIVE_WATERING_FAST_PATH_TIMEOUT_MS, 'live-watering-fast-path');
        fastPathSucceeded = true;
      } catch {
        // La course peut avoir été perdue par le simple timeout du chemin rapide, sans que
        // l'écriture physique ait réellement échoué — elle peut encore être en vol. Libère la
        // queue au plus vite pour le repli ci-dessous plutôt que de laisser la session live la
        // tenir jusqu'à sa fin naturelle — mais node-ble's subscribeLive attend maintenant ce même
        // write avant de démonter la connexion (pendingTriggerWrite), donc fastPathAttempt reflète
        // toujours l'issue GATT réelle, jamais un artefact de déconnexion forcée en plein milieu.
        // On attend donc son vrai résultat (borné par CONNECT_TIMEOUT_MS, cohérent avec le reste
        // du fichier) avant de décider de retomber sur le chemin normal — sinon un second
        // arrosage physique serait risqué si le premier avait en fait fini par réussir.
        stopLiveSession(device.id);
        try {
          await withTimeout(fastPathAttempt, CONNECT_TIMEOUT_MS, 'live-watering-fast-path-settlement');
          fastPathSucceeded = true;
        } catch {
          fastPathSucceeded = false;
        }
      }
      if (fastPathSucceeded) {
        // L'arrosage physique a déjà eu lieu sur la connexion live — l'enregistrement de son
        // résultat doit être isolé dans son propre try/catch : un échec ICI (ex. une erreur Prisma
        // transitoire, ou publishWateringResult qui jette) ne doit JAMAIS retomber vers le chemin
        // normal, qui redéclencherait un second arrosage physique réel sur du vrai matériel — même
        // isolation que triggerWatering() dans watering.ts entre l'action et son enregistrement.
        try {
          await recordWateringOutcome(device.id, 'MANUAL', { success: true });
        } catch (error) {
          log({
            direction: 'WRITE',
            label: 'Failed to record fast-path watering outcome (physical watering already succeeded)',
            deviceId: device.id,
            result: 'ERROR',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
        return { ok: true as const };
      }
    }

    const result = await triggerWatering(device.id, 'MANUAL', ctx.provider, ctx.connectionQueue);
    if (!result.success) throw new TRPCError({ code: 'BAD_GATEWAY', message: result.errorDetail });
    return { ok: true as const };
  }),

  // Manual "sync now" — reads the device immediately instead of waiting for the named-device
  // poller's next ~5min poll (backend/src/ble/namedDevicePoller.ts). Goes through the same
  // connectionQueue as every other GATT operation (only one connection at a time, shared with the
  // poller/scheduler) and persists through the exact same persistReading() the automatic poll
  // cycle uses (backend/src/readings.ts) — a manual sync is not a separate, parallel code path,
  // matching how devices.water already shares triggerWatering() with the auto-watering scheduler.
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
    // Mirrors namedDevicePoller.ts's pollDevice: a successful read is at least as strong evidence
    // the device is online as overhearing its advertisement, and now that discovery no longer runs
    // continuously, a manual sync succeeding is equally strong evidence of "online" too (design
    // spec's Part 2, "lastSeenAt fix").
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });

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
        .then(async (reading) => {
          await persistReading(device.id, device.kind, reading, 'POLL');
          // Same lastSeenAt fix as `sync` above — a successful forced sync is equally strong
          // evidence of "online" as the automatic poller's own successful read.
          await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } });
        })
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
