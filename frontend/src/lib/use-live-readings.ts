import type { QueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { trpc } from './trpc';
import type { Device, Reading } from './types';

// A live sample (source: 'LIVE') only ever reports a subset of Reading's fields — a Parrot Pot
// live sample never carries waterTankLevelPercent/isDrySoil/.../conductivity (see
// backend/src/providers/types.ts's ParrotPotReading), a Xiaomi one always carries its full
// temp/humidity/battery triple. Overlaying a live sample wholesale onto the cached `lastReading`
// would silently null out whatever it doesn't report for as long as the session runs. Instead,
// only the fields the live sample actually populates (non-null/non-undefined) overwrite the
// previous reading; everything else — including id/timestamp/source/deviceId, always present on
// the new event — keeps the previous reading's values only where the new one has none. A `POLL`
// reading is always complete, so callers should use it as-is rather than through this merge.
function mergeLiveReading(previous: Reading | null | undefined, live: Reading): Reading {
  if (!previous) return live;
  const overrides = Object.fromEntries(Object.entries(live).filter(([, value]) => value !== null && value !== undefined));
  return { ...previous, ...overrides } as Reading;
}

// Pushes each new BLE reading (readings.onReading subscription, see
// backend/src/api/trpc/routers/readings.ts) directly into the TanStack Query cache, as required
// by docs/STROYPLANT_SPEC.md section 6 — no polling. Reconnection on drop is handled by the tRPC
// WS link itself (frontend/src/lib/trpc.ts), no manual retry loop needed here.
//
// This subscription is global and unfiltered — it also fires for `source: 'LIVE'` samples from a
// live-sensor-mode session, which must never reach the Health Engine baseline or the 24h/7d/30d
// history charts (see CLAUDE.md, "Reading.source tagging"). Both handlers below treat LIVE and
// POLL differently for that reason.
export function useLiveReadings(queryClient: QueryClient): void {
  useSubscription(
    trpc.readings.onReading.subscriptionOptions(undefined, {
      onData(event) {
        queryClient.setQueryData<Device[]>(trpc.devices.list.queryKey(), (devices) =>
          devices?.map((device) => {
            if (device.id !== event.deviceId) return device;
            const lastReading = event.reading.source === 'LIVE' ? mergeLiveReading(device.lastReading, event.reading) : event.reading;
            return { ...device, lastReading, lastSeenAt: event.reading.timestamp };
          }),
        );

        // This GLOBAL subscription only ever appends POLL rows (devices.history filters server-side
        // too, see CLAUDE.md): it fires for every device, including ones whose page nobody has
        // open, so appending live samples here would inject dense extra points into any cached
        // chart with nothing scoped to clean them back out.
        //
        // Appending live points to devices.history IS done — deliberately, and only for the device
        // whose detail page is currently open — by frontend/src/lib/use-live-mode.ts, which owns
        // that behavior: it bounds the live points it adds (see MAX_CACHED_LIVE_POINTS there,
        // POLL rows are never evicted) and is unmounted with the page. Don't "unify" the two: this
        // file staying POLL-only is what keeps that bounded, page-scoped.
        if (event.reading.source !== 'POLL') return;

        queryClient.setQueriesData<Reading[]>(trpc.devices.history.queryFilter({ deviceId: event.deviceId }), (readings) =>
          readings ? [...readings, event.reading] : readings,
        );
      },
    }),
  );
}
