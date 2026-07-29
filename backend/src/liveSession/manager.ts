import { EventEmitter } from 'node:events';
import type { DeviceKind } from '@prisma/client';
import type { SerializedReading } from '../api/trpc/serialize.js';
import { serializeReading } from '../api/trpc/serialize.js';
import type { ConnectionQueue } from '../ble/connectionQueue.js';
import { log } from '../logger.js';
import type { DeviceProvider, SensorReading } from '../providers/types.js';
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
}

// Module-level singleton state, same pattern as mqtt/manager.ts — exactly one live session
// globally at a time (the single shared GATT connection can't do more than one anyway; this makes
// a second attempt fail fast and clearly instead of silently queuing for up to 5 minutes).
let activeSession: ActiveSession | null = null;

export const liveSessionEmitter = new EventEmitter();

export function getActiveLiveSession(): { deviceId: string; startedAt: string } | null {
  if (!activeSession) return null;
  return { deviceId: activeSession.deviceId, startedAt: new Date(activeSession.startedAt).toISOString() };
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
  activeSession = { deviceId, controller, startedAt: Date.now() };

  const timeoutHandle = setTimeout(() => {
    stopReason = 'timeout';
    controller.abort();
  }, maxDurationMs);

  const onSample = async (reading: SensorReading): Promise<void> => {
    try {
      const created = await persistReading(deviceId, kind, reading, 'LIVE');
      const event: LiveSampleEvent = { type: 'sample', deviceId, reading: serializeReading(created) };
      liveSessionEmitter.emit('event', event);
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
    }
  };

  connectionQueue
    .run(() => provider.subscribeLive(deviceId, kind, onSample, controller.signal))
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
    });
}

export function stopLiveSession(deviceId: string): void {
  if (activeSession?.deviceId === deviceId) {
    activeSession.controller.abort();
  }
}
