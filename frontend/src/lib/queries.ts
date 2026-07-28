import { queryOptions } from '@tanstack/react-query';
import { fetchDeviceHistory, fetchDevices, fetchWateringEvents } from './api';

export const devicesQuery = queryOptions({
  queryKey: ['devices'] as const,
  queryFn: fetchDevices,
});

export function deviceHistoryQuery(deviceId: string, hours: number) {
  return queryOptions({
    queryKey: ['device', deviceId, 'history', hours] as const,
    queryFn: () => fetchDeviceHistory(deviceId, hours),
  });
}

export function wateringEventsQuery(deviceId: string) {
  return queryOptions({
    queryKey: ['device', deviceId, 'watering-events'] as const,
    queryFn: () => fetchWateringEvents(deviceId),
  });
}
