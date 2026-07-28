import type { Reading, WateringEvent } from '@prisma/client';

// tRPC's default (no-transformer) JSON wire format serializes Date the same way Fastify's REST
// responses always did implicitly (Date.toJSON() -> ISO string), with no revival back to Date on
// the client. To keep procedure output types honest (matching what the frontend actually
// receives, rather than the raw Prisma `Date`), timestamps are converted to ISO strings explicitly
// here instead of pulling in a transformer like superjson for this alone.
export type SerializedReading = Omit<Reading, 'timestamp'> & { timestamp: string };
export type SerializedWateringEvent = Omit<WateringEvent, 'timestamp'> & { timestamp: string };

export function serializeReading(reading: Reading): SerializedReading;
export function serializeReading(reading: Reading | null): SerializedReading | null;
export function serializeReading(reading: Reading | null): SerializedReading | null {
  return reading && { ...reading, timestamp: reading.timestamp.toISOString() };
}

export function serializeWateringEvent(event: WateringEvent): SerializedWateringEvent {
  return { ...event, timestamp: event.timestamp.toISOString() };
}

export function serializeDate(date: Date): string;
export function serializeDate(date: Date | null): string | null;
export function serializeDate(date: Date | null): string | null {
  return date?.toISOString() ?? null;
}
