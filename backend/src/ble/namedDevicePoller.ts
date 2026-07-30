import type { DeviceKind } from '@prisma/client';
import { prisma } from '../db/client.js';
import { log } from '../logger.js';
import type { DeviceProvider } from '../providers/types.js';
import { persistReading, persistSyncFailure } from '../readings.js';
import type { ConnectionQueue } from './connectionQueue.js';

// How often each named device gets read — same default and env override
// (PARROT_POLL_INTERVAL_MS) the old scanner.ts used, just moved here since this module is now the
// only thing that polls known devices (docs/superpowers/specs/2026-07-30-scoped-ble-discovery-design.md).
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

// How often the poller wakes up to check which devices are due — separate from the per-device
// poll interval itself, so a 5min-per-device cadence doesn't require a 5min-granularity tick.
const TICK_INTERVAL_MS = 15_000;

const lastPolled = new Map<string, number>();

async function pollDevice(deviceId: string, kind: DeviceKind, provider: DeviceProvider, connectionQueue: ConnectionQueue) {
  lastPolled.set(deviceId, Date.now());
  await connectionQueue.run(async () => {
    try {
      const reading = await provider.readSensors(deviceId, kind);
      await persistReading(deviceId, kind, reading, 'POLL');
      // A successful read is at least as strong evidence the device is online as merely
      // overhearing its advertisement — now that discovery no longer runs continuously, this is
      // the only remaining thing keeping lastSeenAt fresh for a named device (see the design
      // spec's "lastSeenAt fix" section).
      await prisma.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Never swallow an error silently (docs/STROYPLANT_SPEC.md section 7.1).
      log({ direction: 'READ', label: 'Poll readSensors failed', deviceId, result: 'ERROR', detail });
      await persistSyncFailure(deviceId, 'POLL', detail).catch((persistError) => {
        log({
          direction: 'INFO',
          label: 'persistSyncFailure failed',
          deviceId,
          result: 'ERROR',
          detail: persistError instanceof Error ? persistError.message : String(persistError),
        });
      });
    }
  });
}

export function startNamedDevicePoller(
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): void {
  setInterval(async () => {
    const devices = await prisma.device.findMany({ where: { name: { not: null } } });
    for (const device of devices) {
      const last = lastPolled.get(device.id) ?? 0;
      if (Date.now() - last < pollIntervalMs) continue;
      void pollDevice(device.id, device.kind, provider, connectionQueue);
    }
  }, TICK_INTERVAL_MS);
}
