import type { DeviceKind } from '@prisma/client';
import { prisma } from '../db/client.js';
import { log } from '../logger.js';
import type { DeviceProvider } from '../providers/types.js';
import { persistReading, persistSyncFailure } from '../readings.js';
import type { ConnectionQueue } from './connectionQueue.js';
import { getPollSettings } from './pollSettings.js';

// How often each named device gets read — used as the fallback default by getPollSettings() when
// no PollSettings row exists yet. Editable live from the Settings page (replacing the old
// PARROT_POLL_INTERVAL_MS env var, DestCom's explicit request) — see pollSettings.ts. Read fresh
// every tick below rather than once at startup, same pattern health/scheduler.ts already uses for
// getHealthSettings().
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

// How often the poller wakes up to check which devices are due — separate from the per-device
// poll interval itself, so a 5min-per-device cadence doesn't require a 5min-granularity tick.
const TICK_INTERVAL_MS = 15_000;

// Caps how far a permanently-failing device's effective poll interval can back off to — a device
// that's unreachable forever (e.g. a typo'd MAC added via devices.addByAddress) still gets
// retried occasionally (in case it comes back), just not every ~5min forever at the cost of the
// shared connectionQueue (up to ~55s per attempt on node-ble's retry/timeout policy, blocking
// manual watering/sync/live sessions/the auto-watering scheduler in the meantime).
const MAX_BACKOFF_INTERVAL_MS = 60 * 60_000;

const lastPolled = new Map<string, number>();
// Consecutive failure count per device — reset to 0 on any success, incremented on every failure.
// Drives the exponential backoff below; a healthy device (0 consecutive failures) always polls at
// the normal pollIntervalMs, only a device that's ACTUALLY failing repeatedly backs off.
const consecutiveFailures = new Map<string, number>();

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
      consecutiveFailures.delete(deviceId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // Never swallow an error silently (docs/STROYPLANT_SPEC.md section 7.1).
      log({ direction: 'READ', label: 'Poll readSensors failed', deviceId, result: 'ERROR', detail });
      consecutiveFailures.set(deviceId, (consecutiveFailures.get(deviceId) ?? 0) + 1);
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

export function startNamedDevicePoller(provider: DeviceProvider, connectionQueue: ConnectionQueue): void {
  setInterval(async () => {
    try {
      const { pollIntervalMinutes } = await getPollSettings();
      const pollIntervalMs = pollIntervalMinutes * 60_000;
      const devices = await prisma.device.findMany({ where: { name: { not: null } } });
      for (const device of devices) {
        const last = lastPolled.get(device.id) ?? 0;
        const failures = consecutiveFailures.get(device.id) ?? 0;
        const effectiveIntervalMs = Math.min(pollIntervalMs * 2 ** failures, MAX_BACKOFF_INTERVAL_MS);
        if (Date.now() - last < effectiveIntervalMs) continue;
        void pollDevice(device.id, device.kind, provider, connectionQueue);
      }
    } catch (error) {
      // Never let a transient failure here (e.g. SQLite lock contention) become an unhandled
      // rejection — setInterval doesn't await/catch its callback's promise, and Node crashes the
      // whole process on an unhandled rejection by default (the same class of incident this
      // project's history in CLAUDE.md already had to fix elsewhere). Log and let the next tick retry.
      log({
        direction: 'READ',
        label: 'namedDevicePoller tick failed',
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, TICK_INTERVAL_MS);
}
