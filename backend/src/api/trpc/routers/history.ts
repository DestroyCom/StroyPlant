import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { serializeDate } from '../serialize.js';
import { protectedProcedure, router } from '../trpc.js';

// Common shape both WateringEvent (existing, both success and failure rows already) and SyncEvent
// (Task 1/2, failure-only) get mapped into, so the frontend renders one unified feed
// (docs/superpowers/specs/2026-07-30-responsive-and-global-history-design.md).
export interface HistoryEntry {
  id: string; // `watering-${id}` / `sync-${id}` — never collides as a React key across the 2 tables
  type: 'WATERING' | 'SYNC';
  deviceId: string;
  deviceName: string;
  timestamp: string;
  success: boolean; // SyncEvent rows are always false — see Task 1's model comment
  triggerLabel: 'MANUAL' | 'CRON' | 'POLL' | 'CONFIG_PUSH';
  errorDetail: string | null;
}

const HISTORY_LIMIT = 200;

// Exported standalone so it can be verified with fixture data, without touching the database.
export function mergeAndSortHistoryEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export const historyRouter = router({
  list: protectedProcedure.input(z.object({ deviceId: z.string().optional(), days: z.number().optional() })).query(async ({ input }) => {
    const since = input.days != null ? new Date(Date.now() - input.days * 24 * 60 * 60 * 1000) : undefined;
    // No deviceId = every named device, matching devices.list's own `name IS NOT NULL` filter — an
    // unclaimed/unnamed device (e.g. a neighbour's Xiaomi the scanner discovers but nobody claimed)
    // must never flood the feed with its failed reads, potentially pushing real watering events out
    // of the HISTORY_LIMIT cap (docs/superpowers/specs/2026-07-30-responsive-and-global-history-design.md).
    const deviceFilter = input.deviceId ? { deviceId: input.deviceId } : { device: { name: { not: null } } };
    const timeFilter = since ? { timestamp: { gte: since } } : {};

    const [wateringEvents, syncEvents] = await Promise.all([
      prisma.wateringEvent.findMany({
        where: { ...deviceFilter, ...timeFilter },
        include: { device: { select: { name: true } } },
        orderBy: { timestamp: 'desc' },
        take: HISTORY_LIMIT,
      }),
      prisma.syncEvent.findMany({
        where: { ...deviceFilter, ...timeFilter },
        include: { device: { select: { name: true } } },
        orderBy: { timestamp: 'desc' },
        take: HISTORY_LIMIT,
      }),
    ]);

    const entries: HistoryEntry[] = [
      ...wateringEvents.map(
        (event): HistoryEntry => ({
          id: `watering-${event.id}`,
          type: 'WATERING',
          deviceId: event.deviceId,
          deviceName: event.device.name ?? event.deviceId,
          timestamp: serializeDate(event.timestamp),
          success: event.success,
          triggerLabel: event.triggerSource,
          errorDetail: event.errorDetail,
        }),
      ),
      ...syncEvents.map(
        (event): HistoryEntry => ({
          id: `sync-${event.id}`,
          type: 'SYNC',
          deviceId: event.deviceId,
          deviceName: event.device.name ?? event.deviceId,
          timestamp: serializeDate(event.timestamp),
          success: false,
          triggerLabel: event.source,
          errorDetail: event.errorDetail,
        }),
      ),
    ];

    return mergeAndSortHistoryEntries(entries).slice(0, HISTORY_LIMIT);
  }),
});
