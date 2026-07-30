import type { Device, DeviceHealth, ParameterKey } from './types';

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'jamais';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.round(hours / 24);
  return `il y a ${days}j`;
}

export function formatDeviceKind(kind: 'PARROT_POT' | 'XIAOMI_LYWSD03MMC'): string {
  return kind === 'PARROT_POT' ? 'Parrot Pot' : 'Capteur Xiaomi';
}

// The named-device poller re-reads each device every ~5 min by default
// (backend/src/ble/namedDevicePoller.ts, DEFAULT_POLL_INTERVAL_MS), updating lastSeenAt on every
// successful read — 2x this interval absorbs a missed cycle without flickering "offline".
const OFFLINE_THRESHOLD_MS = 10 * 60_000;
const LOW_TANK_THRESHOLD = 20;

export function isDeviceOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < OFFLINE_THRESHOLD_MS;
}

export function isTankLow(device: Device): boolean {
  return (
    device.kind === 'PARROT_POT' &&
    device.lastReading?.waterTankLevelPercent != null &&
    device.lastReading.waterTankLevelPercent < LOW_TANK_THRESHOLD
  );
}

const PARAMETER_LABEL: Record<ParameterKey, string> = {
  soilMoisturePercent: 'Humidité du sol',
  temperatureC: 'Température',
  humidityPercent: 'Humidité',
  luminosity: 'Luminosité',
  soilConductivityUsCm: 'Fertilité du sol',
};

// Judgment derived from the Health Engine (Batch 4) — null if nothing to report (no species assigned, or
// everything is fine), in which case statusHeadline falls back to its existing generic fallback.
function healthHeadline(health: DeviceHealth | undefined): string | null {
  if (!health) return null;
  if (health.status === 'warming_up') return "Période d'observation en cours";
  if (health.status === 'warning') {
    const [key, param] = Object.entries(health.parameters).find(([, p]) => p.status === 'too_low' || p.status === 'too_high') ?? [];
    if (!key || !param) return null;
    const label = PARAMETER_LABEL[key as ParameterKey];
    return param.status === 'too_low' ? `${label} trop basse pour cette espèce` : `${label} trop élevée pour cette espèce`;
  }
  return null;
}

// Short title displayed at the top of the card / detail page. Priority: verifiable facts (connectivity,
// reservoir level) > health judgment (Batch 4b, if a species is assigned) > neutral fallback.
export function statusHeadline(device: Device, health?: DeviceHealth): string {
  if (!isDeviceOnline(device.lastSeenAt)) {
    return `Hors ligne depuis ${formatRelativeTime(device.lastSeenAt)}`;
  }
  if (isTankLow(device)) {
    return 'Le réservoir commence à se vider';
  }
  return healthHeadline(health) ?? 'Tout fonctionne normalement';
}

export function statusBandClasses(device: Device, health?: DeviceHealth): { band: string; icon: string } {
  if (!isDeviceOnline(device.lastSeenAt)) return { band: 'bg-muted', icon: 'text-muted-foreground' };
  if (isTankLow(device)) return { band: 'bg-warning-surface', icon: 'text-warning-foreground' };
  if (healthHeadline(health)) return { band: 'bg-warning-surface', icon: 'text-warning-foreground' };
  return { band: 'bg-teal-100', icon: 'text-teal-700' };
}

export function statusDetail(device: Device): string {
  const reading = device.lastReading;
  if (!reading) return "Aucune lecture pour l'instant.";

  if (device.kind === 'PARROT_POT') {
    const parts: string[] = [];
    if (reading.soilMoisturePercent != null) parts.push(`Humidité du sol : ${Math.round(reading.soilMoisturePercent)}%`);
    if (reading.waterTankLevelPercent != null) parts.push(`Réservoir : ${Math.round(reading.waterTankLevelPercent)}%`);
    return parts.join(' · ') || "Aucune lecture pour l'instant.";
  }

  const parts: string[] = [];
  if (reading.temperatureC != null) parts.push(`Température : ${Math.round(reading.temperatureC)}°`);
  if (reading.humidityPercent != null) parts.push(`Humidité : ${Math.round(reading.humidityPercent)}%`);
  if (reading.batteryPercent != null) parts.push(`Batterie : ${Math.round(reading.batteryPercent)}%`);
  return parts.join(' · ') || "Aucune lecture pour l'instant.";
}

// Calendar-day grouping heading for the history page ("Aujourd'hui" / "Hier" / "Il y a N jours") —
// distinct from formatRelativeTime above, which measures elapsed hours/days from now rather than
// calendar-day boundaries, so it can't tell "yesterday at 23:59" from "today at 00:01".
export function dayBucketLabel(iso: string): string {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / (24 * 60 * 60 * 1000));
  if (diffDays <= 0) return "Aujourd'hui";
  if (diffDays === 1) return 'Hier';
  return `Il y a ${diffDays} jours`;
}
