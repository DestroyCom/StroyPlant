import type { Device, Reading, WateringEvent } from './types';

async function apiFetch<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { credentials: 'include', ...init });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string'
        ? (body as { error: string }).error
        : response.statusText;
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export function fetchDevices(): Promise<Device[]> {
  return apiFetch<Device[]>('/api/devices');
}

export function fetchDeviceHistory(deviceId: string, hours: number): Promise<Reading[]> {
  return apiFetch<Reading[]>(`/api/devices/${encodeURIComponent(deviceId)}/history?hours=${hours}`);
}

export function fetchWateringEvents(deviceId: string): Promise<WateringEvent[]> {
  return apiFetch<WateringEvent[]>(`/api/devices/${encodeURIComponent(deviceId)}/watering-events`);
}

// Jamais fire-and-forget côté backend (docs/STROYPLANT_SPEC.md section 7.1) : un échec renvoie un
// 502 explicite avec le détail, qu'on laisse remonter tel quel à l'appelant plutôt que de l'avaler.
export function triggerWatering(deviceId: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/devices/${encodeURIComponent(deviceId)}/water`, { method: 'POST' });
}
