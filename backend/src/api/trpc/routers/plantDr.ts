import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { buildPlantDrWriteValues } from '../../../ble/parrot/plantDr.js';
import { prisma } from '../../../db/client.js';
import { log } from '../../../logger.js';
import { getCalibrationRunState, isCalibrationRunning, setCalibrationRunState } from '../../../plantDrCalibrationSession.js';
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
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Appareil introuvable' });
    if (device.kind !== 'PARROT_POT') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Fonction réservée au Parrot Pot' });

    try {
      return await ctx.connectionQueue.run(() => ctx.provider.readPlantDrCalibration(device.id));
    } catch (error) {
      throw new TRPCError({ code: 'BAD_GATEWAY', message: error instanceof Error ? error.message : String(error) });
    }
  }),

  // Live status of the current/last calibrateWet run for this device — polled by the frontend
  // instead of blocking on the mutation's HTTP response (see calibrateWet below for why).
  calibrationRunStatus: protectedProcedure
    .input(z.object({ deviceId: z.string() }))
    .query(({ input }) => getCalibrationRunState(input.deviceId)),

  // Writes the device-side dry/wet calibration (Batch 6): DRY_VWC comes from the assigned
  // species' minimum (docs/STROYPLANT_SPEC.md section 7.3, DestCom's explicit choice — no user
  // "dry" gesture), WET_VWC is captured live from the device right now (the user is expected to
  // trigger this right after a normal watering, the "wet" gesture). DRY_N/WET_N are written as 0,
  // matching the factory-default values observed on a real, never-manually-calibrated Parrot Pot
  // (see ble/parrot/plantDr.ts) — their exact physical meaning isn't confirmed, but 0 is what the
  // device already ships with, not a guess.
  //
  // Deliberately fire-and-poll, not fire-and-forget-forever (docs/STROYPLANT_SPEC.md section 7.1):
  // this used to run its 2 sequential connectionQueue-serialized BLE operations (read then write,
  // each with its own up-to-3-attempt/backoff/adapter-restart retry policy) inline and await the
  // whole thing before responding. Root-caused from a real production failure (2026-08-29, an
  // edge-proxy 502 shown to the user as an unparseable-HTML "DOCTYPE" error even though the device
  // had actually been calibrated correctly): the full sequence can exceed the edge proxy's origin
  // timeout (~100s), which is shorter than the origin reverse proxy's read timeout (240s) — so the
  // edge proxy serves its own error page long before the backend would have responded. The outcome
  // is now tracked in `plantDrCalibrationSession.ts` and exposed via `calibrationRunStatus` above
  // (same module-singleton-plus-polled-status shape as `liveSession`/`discoverySession`) — never
  // silently dropped, just no longer tied to one blocking HTTP round trip.
  calibrateWet: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId }, include: { plantProfile: true } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Appareil introuvable' });
    if (device.kind !== 'PARROT_POT') throw new TRPCError({ code: 'BAD_REQUEST', message: 'Fonction réservée au Parrot Pot' });

    const dryVwcPercent = device.plantProfile?.soilMoistureMinPercent;
    if (dryVwcPercent == null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: "Assigne d'abord une espèce dont l'humidité minimale est connue",
      });
    }

    if (isCalibrationRunning(input.deviceId)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'Une calibration est déjà en cours pour cet appareil' });
    }

    setCalibrationRunState(input.deviceId, { status: 'running', startedAt: Date.now() });

    void (async () => {
      try {
        const reading = await ctx.connectionQueue.run(() => ctx.provider.readSensors(device.id, 'PARROT_POT'));
        if (reading.kind !== 'PARROT_POT') throw new Error('Unexpected reading kind');
        const wetVwcPercent = reading.data.soilMoisturePercent;
        if (wetVwcPercent == null) {
          // soilMoisturePercent is independently best-effort since the 2026-09-01 fa07 outage
          // (docs/superpowers/specs/2026-09-01-parrot-fa07-independent-decode-fix.md) — a
          // malformed buffer on this one field must not silently proceed with `undefined`.
          throw new Error("Le capteur d'humidité du sol est illisible pour le moment sur cet appareil — réessaie plus tard");
        }

        if (wetVwcPercent <= dryVwcPercent) {
          throw new Error(
            `L'humidité actuelle du sol (${wetVwcPercent.toFixed(1)}%) n'est pas au-dessus du seuil sec de l'espèce (${dryVwcPercent}%) — arrose d'abord la plante, puis réessaie`,
          );
        }
        if (wetVwcPercent > MAX_PLAUSIBLE_WET_VWC_PERCENT) {
          throw new Error(
            `Mesure (${wetVwcPercent.toFixed(1)}%) anormalement élevée pour un sol saturé — attends quelques minutes après l'arrosage que la mesure se stabilise, puis réessaie.`,
          );
        }

        const values = buildPlantDrWriteValues({
          dry: { n: 0, vwcPercent: dryVwcPercent },
          wet: { n: 0, vwcPercent: wetVwcPercent },
        });

        await ctx.connectionQueue.run(() => ctx.provider.writePlantDrCalibration(device.id, values));

        setCalibrationRunState(input.deviceId, {
          status: 'success',
          dryVwcPercent,
          wetVwcPercent,
          configId: values.configId,
          finishedAt: Date.now(),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        log({ direction: 'WRITE', label: 'Plant Dr calibration run failed', deviceId: device.id, result: 'ERROR', detail });
        setCalibrationRunState(input.deviceId, { status: 'error', message: detail, finishedAt: Date.now() });
      }
    })();

    return { status: 'started' as const };
  }),
});
