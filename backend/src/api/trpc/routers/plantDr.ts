import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { buildPlantDrWriteValues } from '../../../ble/parrot/plantDr.js';
import { prisma } from '../../../db/client.js';
import { log } from '../../../logger.js';
import { protectedProcedure, router } from '../trpc.js';

// A real potting mix saturates well below this — a captured value above it almost certainly means
// the "capture wet point" button was pressed while water was still actively draining through the
// soil right after pouring, not once the reading had settled a few minutes later (design spec Part
// I, confirmed against a real production capture that read 72.6%). A general ceiling for plausible
// soil saturation, not a per-species value — same YAGNI stance as this project's other gate
// constants (MIN_CALIBRATION_DAYS, MAX_GAP_MS, etc.).
const MAX_PLAUSIBLE_WET_VWC_PERCENT = 55;

export const plantDrRouter = router({
  // Live read from the device, not from our DB — the device itself is the source of truth for its
  // own calibration (docs/STROYPLANT_SPEC.md section 7.11), no local copy kept.
  getCalibration: protectedProcedure.input(z.object({ deviceId: z.string() })).query(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
    if (device.kind !== 'PARROT_POT') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Plant Dr is Parrot Pot only' });

    try {
      return await ctx.connectionQueue.run(() => ctx.provider.readPlantDrCalibration(device.id));
    } catch (error) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: error instanceof Error ? error.message : String(error) });
    }
  }),

  // Writes the device-side dry/wet calibration (Batch 6): DRY_VWC comes from the assigned
  // species' minimum (docs/STROYPLANT_SPEC.md section 7.3, DestCom's explicit choice — no user
  // "dry" gesture), WET_VWC is captured live from the device right now (the user is expected to
  // trigger this right after a normal watering, the "wet" gesture). DRY_N/WET_N are written as 0,
  // matching the factory-default values observed on a real, never-manually-calibrated Parrot Pot
  // (see ble/parrot/plantDr.ts) — their exact physical meaning isn't confirmed, but 0 is what the
  // device already ships with, not a guess.
  calibrateWet: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId }, include: { plantProfile: true } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });
    if (device.kind !== 'PARROT_POT') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Plant Dr is Parrot Pot only' });

    const dryVwcPercent = device.plantProfile?.soilMoistureMinPercent;
    if (dryVwcPercent == null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Assign a species with a known soil moisture minimum before calibrating',
      });
    }

    let wetVwcPercent: number;
    try {
      const reading = await ctx.connectionQueue.run(() => ctx.provider.readSensors(device.id, 'PARROT_POT'));
      if (reading.kind !== 'PARROT_POT') throw new Error('Unexpected reading kind');
      wetVwcPercent = reading.data.soilMoisturePercent;
    } catch (error) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: error instanceof Error ? error.message : String(error) });
    }

    if (wetVwcPercent <= dryVwcPercent) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Current soil moisture (${wetVwcPercent.toFixed(1)}%) isn't above the species' dry threshold (${dryVwcPercent}%) — water the plant first, then retry`,
      });
    }

    if (wetVwcPercent > MAX_PLAUSIBLE_WET_VWC_PERCENT) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Reading (${wetVwcPercent.toFixed(1)}%) is implausibly high for soil saturation — wait a few minutes after watering for the reading to settle, then retry.`,
      });
    }

    const values = buildPlantDrWriteValues({
      dry: { n: 0, vwcPercent: dryVwcPercent },
      wet: { n: 0, vwcPercent: wetVwcPercent },
    });

    try {
      await ctx.connectionQueue.run(() => ctx.provider.writePlantDrCalibration(device.id, values));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log({ direction: 'WRITE', label: 'Plant Dr calibration write failed', deviceId: device.id, result: 'ERROR', detail });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: detail });
    }

    return {
      dryVwcPercent,
      wetVwcPercent,
      configId: values.configId,
    };
  }),
});
