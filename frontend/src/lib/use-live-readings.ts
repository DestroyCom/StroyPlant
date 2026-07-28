import type { QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { devicesQuery } from './queries';
import type { Device, LiveReadingMessage, Reading } from './types';

const RECONNECT_DELAY_MS = 3000;

// Pousse chaque nouvelle lecture BLE (WS /ws, voir backend/src/api/ws.ts) directement dans le cache
// TanStack Query, comme demandé par docs/STROYPLANT_SPEC.md section 6 — pas de polling.
export function useLiveReadings(queryClient: QueryClient): void {
  useEffect(() => {
    let socket: WebSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect() {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.addEventListener('message', (event: MessageEvent<string>) => {
        const message = JSON.parse(event.data) as LiveReadingMessage;
        if (message.type !== 'reading') return;

        queryClient.setQueryData<Device[]>(devicesQuery.queryKey, (devices) =>
          devices?.map((device) =>
            device.id === message.deviceId ? { ...device, lastReading: message.reading, lastSeenAt: message.reading.timestamp } : device,
          ),
        );

        queryClient.setQueriesData<Reading[]>({ queryKey: ['device', message.deviceId, 'history'] }, (readings) =>
          readings ? [...readings, message.reading] : readings,
        );
      });

      socket.addEventListener('close', () => {
        if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
      });
    }

    connect();

    return () => {
      stopped = true;
      clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [queryClient]);
}
