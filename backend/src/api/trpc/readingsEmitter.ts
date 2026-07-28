import { EventEmitter } from 'node:events';
import type { DeviceKind } from '@prisma/client';
import type { SerializedReading } from './serialize.js';

export interface ReadingEvent {
  deviceId: string;
  kind: DeviceKind;
  reading: SerializedReading;
}

// Replaces the manual Set<WebSocket> pub/sub that used to live in api/ws.ts — the readings.onReading
// tRPC subscription (routers/readings.ts) consumes this via node:events' `on()` async iterator.
export const readingsEmitter = new EventEmitter();

export function emitReading(event: ReadingEvent): void {
  readingsEmitter.emit('reading', event);
}
