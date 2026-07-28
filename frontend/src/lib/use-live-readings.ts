import type { QueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { trpc } from './trpc';
import type { Device, Reading } from './types';

// Pushes each new BLE reading (readings.onReading subscription, see
// backend/src/api/trpc/routers/readings.ts) directly into the TanStack Query cache, as required
// by docs/STROYPLANT_SPEC.md section 6 — no polling. Reconnection on drop is handled by the tRPC
// WS link itself (frontend/src/lib/trpc.ts), no manual retry loop needed here.
export function useLiveReadings(queryClient: QueryClient): void {
  useSubscription(
    trpc.readings.onReading.subscriptionOptions(undefined, {
      onData(event) {
        queryClient.setQueryData<Device[]>(trpc.devices.list.queryKey(), (devices) =>
          devices?.map((device) =>
            device.id === event.deviceId ? { ...device, lastReading: event.reading, lastSeenAt: event.reading.timestamp } : device,
          ),
        );

        queryClient.setQueriesData<Reading[]>(trpc.devices.history.queryFilter({ deviceId: event.deviceId }), (readings) =>
          readings ? [...readings, event.reading] : readings,
        );
      },
    }),
  );
}
