import { EventEmitter } from 'node:events';
import type { DeviceKind } from '@prisma/client';
import type { SerializedReading } from '../api/trpc/serialize.js';
import { serializeReading } from '../api/trpc/serialize.js';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import { log } from '../logger.js';
import type { DeviceProvider, LiveConnectionHandle, SensorReading } from '../providers/types.js';
import { persistReading } from '../readings.js';

// Bounds how long a live session can hold the single shared GATT connection, starving the
// scanner's own polling and the auto-watering scheduler for everyone else (see
// docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md).
export const LIVE_SESSION_MAX_DURATION_MS = 5 * 60_000;

export type LiveSessionEndReason = 'stopped' | 'timeout' | 'error';

export interface LiveSampleEvent {
  type: 'sample';
  deviceId: string;
  reading: SerializedReading;
}
export interface LiveEndedEvent {
  type: 'ended';
  deviceId: string;
  reason: LiveSessionEndReason;
  detail?: string;
}
export type LiveSessionEvent = LiveSampleEvent | LiveEndedEvent;

interface ActiveSession {
  deviceId: string;
  controller: AbortController;
  startedAt: number;
  // Stored so stopLiveSession() can cancel it — without this, a manual stop racing a
  // near-simultaneous auto-cutoff could let the timeout still fire after abort() (e.g. while a
  // real node-ble provider's post-abort GATT cleanup is still in flight) and overwrite
  // stopReason from 'stopped' to 'timeout', misreporting a manual stop as a timeout.
  timeoutHandle: ReturnType<typeof setTimeout>;
}

// Module-level singleton state, same pattern as mqtt/manager.ts — exactly one live session
// globally at a time (the single shared GATT connection can't do more than one anyway; this makes
// a second attempt fail fast and clearly instead of silently queuing for up to 5 minutes).
let activeSession: ActiveSession | null = null;
let liveConnectionHandle: LiveConnectionHandle | null = null;

export const liveSessionEmitter = new EventEmitter();

export function getActiveLiveSession(): { deviceId: string; startedAt: string } | null {
  if (!activeSession) return null;
  return { deviceId: activeSession.deviceId, startedAt: new Date(activeSession.startedAt).toISOString() };
}

// Non-null uniquement si une session live est active POUR CE deviceId ET que sa connexion GATT est
// déjà établie (le provider appelle onConnectionReady après connexion, avant les notifications —
// il y a donc une brève fenêtre au tout début d'une session où ceci retourne null même si
// activeSession existe déjà).
export function getActiveLiveConnectionHandle(deviceId: string): LiveConnectionHandle | null {
  if (activeSession?.deviceId !== deviceId) return null;
  return liveConnectionHandle;
}

// maxDurationMs defaults to the real 5min cutoff — overridable so a test can exercise the
// auto-cutoff path without actually waiting 5 minutes (see Task 6 Step 3's verification script).
export function startLiveSession(
  deviceId: string,
  kind: DeviceKind,
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
  maxDurationMs = LIVE_SESSION_MAX_DURATION_MS,
): void {
  if (activeSession) {
    throw new Error(`Une session live est déjà active sur ${activeSession.deviceId}`);
  }

  const controller = new AbortController();
  let stopReason: 'stopped' | 'timeout' = 'stopped';

  const timeoutHandle = setTimeout(() => {
    stopReason = 'timeout';
    controller.abort();
  }, maxDurationMs);

  activeSession = { deviceId, controller, startedAt: Date.now(), timeoutHandle };

  const onSample = async (reading: SensorReading): Promise<void> => {
    // try/catch scoped to persistReading only — a downstream 'event' listener throwing must
    // never be caught here and misreported under the "persist failed" label when persistence
    // actually succeeded.
    let created: Awaited<ReturnType<typeof persistReading>>;
    try {
      created = await persistReading(deviceId, kind, reading, 'LIVE');
    } catch (error) {
      // Best-effort persistence for a streaming UI feature — a single failed DB write must never
      // kill an otherwise-healthy live session (unlike a real BLE device action, which
      // docs/STROYPLANT_SPEC.md section 7.1's never-silent rule is actually about).
      log({
        direction: 'INFO',
        label: 'Live sample persist failed',
        deviceId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const event: LiveSampleEvent = { type: 'sample', deviceId, reading: serializeReading(created) };
    liveSessionEmitter.emit('event', event);
  };

  connectionQueue
    .run(() =>
      provider.subscribeLive(deviceId, kind, onSample, controller.signal, (handle) => {
        liveConnectionHandle = handle;
      }),
    )
    .then(
      () => {
        const event: LiveEndedEvent = { type: 'ended', deviceId, reason: stopReason };
        liveSessionEmitter.emit('event', event);
      },
      (error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        log({ direction: 'INFO', label: 'Live session ended abnormally', deviceId, result: 'ERROR', detail });
        const event: LiveEndedEvent = { type: 'ended', deviceId, reason: 'error', detail };
        liveSessionEmitter.emit('event', event);
      },
    )
    .finally(() => {
      clearTimeout(timeoutHandle);
      activeSession = null;
      liveConnectionHandle = null;
    })
    .catch((error: unknown) => {
      // Defensive only: a synchronous throw inside a liveSessionEmitter 'event' listener (in
      // either .then() branch above) would otherwise be an unhandled rejection. activeSession is
      // already cleared correctly by .finally() regardless — this just prevents the process-level
      // warning/crash.
      log({
        direction: 'INFO',
        label: 'Live session settlement handler threw',
        deviceId,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
}

export function stopLiveSession(deviceId: string): void {
  if (activeSession?.deviceId === deviceId) {
    clearTimeout(activeSession.timeoutHandle);
    activeSession.controller.abort();
  }
}
