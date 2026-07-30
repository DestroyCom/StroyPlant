import { randomUUID } from 'node:crypto';
import { prisma } from '../db/client.js';
import { log } from '../logger.js';
import { getMqttState } from '../mqtt/manager.js';
import { publishDiscovery } from '../mqtt/publisher.js';
import type { DeviceProvider, DiscoveredDevice } from '../providers/types.js';
import { GATT_133_BACKOFF_MS } from './parrot/retry.js';

// Bounds how long a discovery session can run — same idea and constant as
// liveSession/manager.ts's LIVE_SESSION_MAX_DURATION_MS: a closed tab or a crashed frontend must
// not leave continuous BLE scanning running forever (docs/superpowers/specs/
// 2026-07-30-scoped-ble-discovery-design.md).
export const DISCOVERY_SESSION_MAX_DURATION_MS = 5 * 60_000;

const SCAN_RESTART_BASE_DELAY_MS = 5_000;
const SCAN_RESTART_MAX_DELAY_MS = 60_000;
const SCAN_HEALTHY_UPTIME_MS = 60_000;

interface ActiveSession {
  id: string;
  controller: AbortController;
  startedAt: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// Module-level singleton, same pattern as liveSession/manager.ts and mqtt/manager.ts — exactly one
// discovery session globally at a time.
let activeSession: ActiveSession | null = null;

export function getActiveDiscoverySession(): { startedAt: string } | null {
  if (!activeSession) return null;
  return { startedAt: new Date(activeSession.startedAt).toISOString() };
}

// Upsert-any-recognized-device behavior is unchanged from the old scanner.ts: named or not, any
// Parrot Pot/Xiaomi seen gets a Device row. Only WHEN this runs changes (session-scoped, not
// forever from boot).
//
// Bugfix (2026-07-30): `device.name` here is always the raw BLE-advertised name (real providers
// never populate anything else, see providers/types.ts's DiscoveredDevice) — it must never
// overwrite a name the user already set via devices.rename/addByAddress. The `update` branch used
// to unconditionally write `name: device.name`, so re-seeing an already-claimed device during any
// later discovery session (i.e. every time /devices/add is reopened) silently reverted its custom
// name back to the raw advertised one. Only the `create` branch (a genuinely new, unclaimed
// device) should ever set `name` from the advertisement.
async function onDeviceSeen(device: DiscoveredDevice): Promise<void> {
  const previous = await prisma.device.findUnique({ where: { id: device.id } });
  const upserted = await prisma.device.upsert({
    where: { id: device.id },
    create: { id: device.id, kind: device.kind, name: device.name, lastSeenAt: new Date() },
    update: { lastSeenAt: new Date() },
  });

  // Real BLE providers never populate `device.name` (only devices.rename claims a device) — this
  // only fires for the mock provider's pre-named devices, so their MQTT discovery still gets
  // published once without waiting on a rename that will never happen in that case.
  const mqttState = getMqttState();
  if (mqttState && upserted.name != null && previous?.name == null) {
    publishDiscovery(mqttState.client, upserted, mqttState);
  }
}

// maxDurationMs defaults to the real 5min cutoff — overridable so a verification script can
// exercise the auto-cutoff path without actually waiting 5 minutes (see Task 1 Step 2).
// Returns the new session's id — the caller (the discoverySession tRPC router) hands it back to
// whichever frontend page instance started it, so that instance (and only that instance) can
// later stop precisely this session (see stopDiscoverySession below): without an id, any caller
// could stop whatever session happens to be active, including one started by a different tab/page
// instance after a hard reload skipped this one's own cleanup.
export function startDiscoverySession(provider: DeviceProvider, maxDurationMs = DISCOVERY_SESSION_MAX_DURATION_MS): string {
  if (activeSession) {
    throw new Error('Une session de découverte est déjà active');
  }

  const id = randomUUID();
  const controller = new AbortController();

  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, maxDurationMs);

  const session: ActiveSession = { id, controller, startedAt: Date.now(), timeoutHandle };
  activeSession = session;

  // Mirrors liveSession/manager.ts's .finally() on the tracked async operation: auto-cutoff only
  // aborts the signal (above), so runResilientScan's loop must actually settle before the
  // singleton is released — without this, getActiveDiscoverySession() would keep reporting a
  // session as active forever past its own auto-cutoff, since stopDiscoverySession() is the only
  // other path that clears it. Guarded by `activeSession === session` so a manual stop (which
  // already clears activeSession synchronously) can't have this late cleanup clobber a
  // subsequently-started session.
  void runResilientScan(provider, controller.signal).finally(() => {
    clearTimeout(session.timeoutHandle);
    if (activeSession === session) {
      activeSession = null;
    }
  });

  return id;
}

// Only actually stops the active session if `sessionId` matches it — a mismatch (the session it
// thought it owned already ended, or belongs to a different caller entirely, e.g. another
// browser tab's discovery session) is a no-op, not an error: there's nothing THIS caller is
// entitled to stop. This is what stops a page instance that never got a session of its own
// (e.g. it got CONFLICT from start) from being able to kill someone else's active session on
// unmount.
export function stopDiscoverySession(sessionId: string): void {
  if (!activeSession || activeSession.id !== sessionId) return;
  clearTimeout(activeSession.timeoutHandle);
  activeSession.controller.abort();
  activeSession = null;
}

// Same resilience pattern the old scanner.ts's runScanLoop had (2026-07-29 production incident:
// a single transient provider.scan() error must never kill discovery silently) — capped
// exponential backoff, reset once a run has stayed up long enough to be considered healthy.
// Bounded by the session's own signal, so this loop naturally stops at the session's cutoff.
async function runResilientScan(provider: DeviceProvider, signal: AbortSignal): Promise<void> {
  let delayMs = SCAN_RESTART_BASE_DELAY_MS;
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      await provider.scan((device) => {
        void onDeviceSeen(device).catch((error) => {
          log({
            direction: 'INFO',
            label: 'onDeviceSeen failed',
            deviceId: device.id,
            result: 'ERROR',
            detail: error instanceof Error ? error.message : String(error),
          });
        });
      }, signal);
      if (signal.aborted) return;
      throw new Error('provider.scan() returned without the abort signal firing');
    } catch (error) {
      if (signal.aborted) return;
      log({
        direction: 'SCAN',
        label: `Discovery session scan stopped on error — restarting in ${delayMs}ms`,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    delayMs =
      Date.now() - startedAt >= SCAN_HEALTHY_UPTIME_MS ? SCAN_RESTART_BASE_DELAY_MS : Math.min(delayMs * 2, SCAN_RESTART_MAX_DELAY_MS);
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, GATT_133_BACKOFF_MS * 4)));
  }
}
