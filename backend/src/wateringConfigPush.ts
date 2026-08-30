// Device-side autonomous watering — the only file that decides eligibility and calls the
// provider's readWateringConfig/writeWateringConfig. See docs/superpowers/specs/2026-08-30-
// parrot-device-side-autonomous-watering-design.md.
import type { Device, PlantProfile, Schedule } from '@prisma/client';
import type { ConnectionQueue } from './ble/connectionQueue.js';
import { buildWateringConfigEnableValues } from './ble/parrot/wateringConfig.js';
import { prisma } from './db/client.js';
import { resolveEffectiveSchedule } from './health/scheduler.js';
import { log } from './logger.js';
import type { DeviceProvider } from './providers/types.js';
import { isWateringConfigPushRunning, setWateringConfigPushState } from './wateringConfigPushSession.js';

export type WateringConfigEligibility =
  | { eligible: false }
  | { eligible: true; vwcIrrPercent: number; vwcCmdPercent: number; nIrr: number };

// A device is a push candidate exactly when the backend scheduler already considers it a
// watering candidate (resolveEffectiveSchedule's active flag) AND its assigned species has
// Parrot-sourced threshold data — the ~3400 WatchFlower-only species have neither field, and stay
// silently ineligible (not an error, an expected common case). A discriminated union rather than
// optional fields, so a caller checking `eligibility.eligible` gets the 3 values narrowed as
// definitely present with no cast needed.
export function resolveWateringConfigEligibility(
  device: Pick<Device, 'plantProfileId'>,
  schedule: Schedule | null,
  plantProfile: Pick<PlantProfile, 'soilMoistureIrrigatePercent' | 'soilMoistureCommandPercent' | 'irrigateCalibrationSampleCount'> | null,
): WateringConfigEligibility {
  if (!resolveEffectiveSchedule(device, schedule).active || !plantProfile) return { eligible: false };

  const { soilMoistureIrrigatePercent, soilMoistureCommandPercent, irrigateCalibrationSampleCount } = plantProfile;
  if (soilMoistureIrrigatePercent == null || soilMoistureCommandPercent == null) return { eligible: false };

  return {
    eligible: true,
    vwcIrrPercent: soilMoistureIrrigatePercent,
    vwcCmdPercent: soilMoistureCommandPercent,
    nIrr: irrigateCalibrationSampleCount ?? 0,
  };
}

export interface WateringConfigPushDeps {
  provider: DeviceProvider;
  connectionQueue: ConnectionQueue;
}

// Self-contained: always re-fetches the device fresh from the DB rather than requiring callers to
// pass an already-loaded object with the right relations — this is shared by 3 call sites
// (assignPlantProfile, schedule.upsert, the manual wateringConfig.push mutation) which don't all
// have the same relations loaded already.
export async function runWateringConfigPush(deps: WateringConfigPushDeps, deviceId: string): Promise<void> {
  setWateringConfigPushState(deviceId, { status: 'running', startedAt: Date.now() });
  try {
    const device = await prisma.device.findUnique({ where: { id: deviceId }, include: { plantProfile: true, schedule: true } });
    if (!device) throw new Error('Device not found');
    if (device.kind !== 'PARROT_POT') throw new Error('Device-side autonomous watering is Parrot Pot only');

    const eligibility = resolveWateringConfigEligibility(device, device.schedule, device.plantProfile);

    if (eligibility.eligible) {
      const values = buildWateringConfigEnableValues(eligibility.vwcIrrPercent, eligibility.vwcCmdPercent, eligibility.nIrr);
      await deps.connectionQueue.run(() => deps.provider.writeWateringConfig(deviceId, { mode: 'enable', values }));

      // Never trust a bare ATT write acknowledgment as proof the config was actually retained —
      // this project has direct real-hardware precedent (the f906/f90c manual-trigger
      // investigation) of a write producing a normal GATT acknowledgment with zero physical
      // effect. Reading back and comparing is the only way to know the values actually landed.
      const readBack = await deps.connectionQueue.run(() => deps.provider.readWateringConfig(deviceId));
      const matches =
        readBack.vwcIrrRaw === values.vwcIrrRaw &&
        readBack.vwcCmdRaw === values.vwcCmdRaw &&
        readBack.nIrr === values.nIrr &&
        readBack.algorithmEnabled === true;
      if (!matches) {
        throw new Error(
          `Config push write did not stick — read back ${JSON.stringify(readBack)}, expected vwcIrrRaw=${values.vwcIrrRaw} vwcCmdRaw=${values.vwcCmdRaw} nIrr=${values.nIrr} algorithmEnabled=true`,
        );
      }

      await prisma.device.update({
        where: { id: deviceId },
        data: { autonomousWateringActive: true, autonomousWateringUpdatedAt: new Date() },
      });
      setWateringConfigPushState(deviceId, { status: 'success', enabled: true, finishedAt: Date.now() });
    } else {
      // Only bother writing "disable" if the device might currently be autonomous — avoids a
      // needless BLE write for a device that was never eligible in the first place.
      if (device.autonomousWateringActive) {
        await deps.connectionQueue.run(() => deps.provider.writeWateringConfig(deviceId, { mode: 'disable' }));
        const readBack = await deps.connectionQueue.run(() => deps.provider.readWateringConfig(deviceId));
        if (readBack.algorithmEnabled !== false) {
          throw new Error(`Config disable write did not stick — read back algorithmEnabled=${readBack.algorithmEnabled}, expected false`);
        }
      }
      await prisma.device.update({
        where: { id: deviceId },
        data: { autonomousWateringActive: false, autonomousWateringUpdatedAt: new Date() },
      });
      setWateringConfigPushState(deviceId, { status: 'success', enabled: false, finishedAt: Date.now() });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log({ direction: 'WRITE', label: 'Watering config push failed', deviceId, result: 'ERROR', detail });
    await prisma.device.update({ where: { id: deviceId }, data: { autonomousWateringActive: false } }).catch(() => {});
    await prisma.syncEvent.create({ data: { deviceId, source: 'CONFIG_PUSH', errorDetail: detail } }).catch(() => {});
    setWateringConfigPushState(deviceId, { status: 'error', message: detail, finishedAt: Date.now() });
  }
}

// Fire-and-forget entry point for the two automatic call sites (assignPlantProfile,
// schedule.upsert) — silently skips if a push is already running for this device (a rare race
// between two rapid saves), never surfaces a CONFLICT to a mutation whose primary purpose isn't
// this push. The manual wateringConfig.push tRPC mutation calls runWateringConfigPush directly
// instead, after throwing its own CONFLICT synchronously (see Task 5's router).
export function kickOffWateringConfigPush(deps: WateringConfigPushDeps, deviceId: string): void {
  if (isWateringConfigPushRunning(deviceId)) return;
  void runWateringConfigPush(deps, deviceId);
}
