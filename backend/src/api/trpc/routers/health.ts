import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { computeDeviceHealth } from '../../../health/scoring.js';
import { getHealthSettings, upsertHealthSettings } from '../../../health/settings.js';
import { getCalibration } from '../../../health/soilConductivityCalibration.js';
import { kickOffWateringConfigPush } from '../../../wateringConfigPush.js';
import { serializeDate } from '../serialize.js';
import { protectedProcedure, router } from '../trpc.js';

export const healthRouter = router({
  // Instance-wide, editable from the Settings page instead of env vars — see health/settings.ts.
  getSettings: protectedProcedure.query(() => getHealthSettings()),

  upsertSettings: protectedProcedure
    .input(
      z.object({
        baselineWindowDays: z.number().int().min(1).max(365),
        warmupMinDays: z.number().int().min(0).max(365),
        timezone: z.string().min(1),
        shadowModeEnabled: z.boolean(),
      }),
    )
    .mutation(({ input }) => upsertHealthSettings(input)),

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
    .mutation(async ({ ctx, input }) => {
      const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
      if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

      let profile: { id: number; tags: number | null } | null = null;
      if (input.plantProfileId != null) {
        profile = await prisma.plantProfile.findUnique({ where: { id: input.plantProfileId }, select: { id: true, tags: true } });
        if (!profile) throw new TRPCError({ code: 'NOT_FOUND', message: 'Plant profile not found' });
      }

      // Captured BEFORE the update below overwrites it — needed to tell "this species assignment
      // just changed to an orchid" apart from "the device already had this exact orchid species
      // assigned and is being re-saved" (e.g. the species picker's own "no-op" re-select path, or
      // a future bulk-edit). Without this check, the orchid auto-default below would re-fire and
      // silently clobber a user's later explicit "Perfect Drop"/"Plant Sitter"/"Custom" choice on
      // every re-save of the same orchid species, not just the first transition into one.
      const previousPlantProfileId = device.plantProfileId;

      const updated = await prisma.device.update({
        where: { id: device.id },
        data: { plantProfileId: input.plantProfileId },
        include: { plantProfile: true },
      });

      // Orchid auto-default to Manual mode — reproduces a real, confirmed behavior of the official
      // app (docs/superpowers/specs/2026-08-31-parrot-pot-official-app-parity-design.md section 4,
      // `DataManager.java:3033` in the decompiled source: `createWateringConfigThread(plantId,
      // isOrchid ? 0 : 1)`). Bit 256 of `PlantProfile.tags` = orchid. Only forces the mode on a
      // genuine transition into this orchid species (species actually changed) AND when the mode
      // isn't already MANUAL — never fights a user's later explicit choice on a re-save of the
      // same species, and never fires at all for a non-orchid species.
      const ORCHID_TAG_BIT = 256;
      const isOrchid = profile != null && profile.tags != null && (profile.tags & ORCHID_TAG_BIT) !== 0;
      const speciesChanged = previousPlantProfileId !== input.plantProfileId;
      if (isOrchid && speciesChanged) {
        const existingSchedule = await prisma.schedule.findUnique({ where: { deviceId: device.id } });
        if (existingSchedule?.wateringMode !== 'MANUAL') {
          await prisma.schedule.upsert({
            where: { deviceId: device.id },
            update: { wateringMode: 'MANUAL' },
            create: {
              deviceId: device.id,
              active: existingSchedule?.active ?? input.plantProfileId != null,
              allowedStartHour: existingSchedule?.allowedStartHour ?? 6,
              allowedEndHour: existingSchedule?.allowedEndHour ?? 20,
              cooldownHours: existingSchedule?.cooldownHours ?? 24,
              wateringMode: 'MANUAL',
            },
          });
        }
      }

      // Species assignment is already a deliberate, infrequent user action — always recompute
      // eligibility and push (enable or disable) in the background. Guarded to Parrot Pot only —
      // runWateringConfigPush itself also rejects other kinds, but only via a thrown-and-caught
      // Error, which would otherwise log a spurious ERROR + SyncEvent row on every non-Parrot-Pot
      // species assignment (see wateringConfigPush.ts).
      if (device.kind === 'PARROT_POT') {
        kickOffWateringConfigPush({ provider: ctx.provider, connectionQueue: ctx.connectionQueue }, device.id);
      }

      return { ...updated, lastSeenAt: serializeDate(updated.lastSeenAt) };
    }),

  deviceHealth: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId }, include: { plantProfile: true } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    const healthSettings = await getHealthSettings();
    const since = new Date(Date.now() - healthSettings.baselineWindowDays * 24 * 3600_000);
    const readings = await prisma.reading.findMany({
      where: { deviceId: device.id, timestamp: { gte: since }, source: 'POLL' },
      orderBy: { timestamp: 'asc' },
      include: { rawSensorLog: true },
    });
    const conductivityCalibration = await getCalibration(device.id);

    return computeDeviceHealth(
      device,
      readings,
      device.plantProfile,
      healthSettings.warmupMinDays,
      conductivityCalibration,
      healthSettings.timezone,
    );
  }),
});
