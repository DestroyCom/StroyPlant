import { isDeviceOnline, isTankLow, statusHeadline } from './format';
import type { Device, DeviceHealth } from './types';

export interface DeviceAlert {
  deviceId: string;
  deviceName: string;
  message: string;
}

// Reuses statusHeadline's own priority (hors ligne > réservoir bas > santé "warning") rather than
// re-deriving it, so the notification bell and the dashboard card badge can never disagree on what
// counts as "a real issue" for a device. The luminosity advisory is independent — it can fire even
// when the primary status is otherwise fine, since it's specifically flagged as its own thing by
// the Health Engine (docs/HEALTH_ENGINE.md's Part H), not a replacement for the per-parameter check.
export function computeDeviceAlerts(device: Device, health: DeviceHealth | undefined): DeviceAlert[] {
  if (!device.name) return [];
  const alerts: DeviceAlert[] = [];

  const hasPrimaryAlert = !isDeviceOnline(device.lastSeenAt) || isTankLow(device) || health?.status === 'warning';
  if (hasPrimaryAlert) {
    alerts.push({ deviceId: device.id, deviceName: device.name, message: statusHeadline(device, health) });
  }

  if (health?.luminosityRecentDaysTooLow) {
    alerts.push({ deviceId: device.id, deviceName: device.name, message: 'Lumière insuffisante depuis 3 jours' });
  }

  return alerts;
}
