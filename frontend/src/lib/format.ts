import type { Device } from './types';

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

// Le scanner republie chaque device toutes les ~5 min par défaut (backend/src/ble/scanner.ts,
// DEFAULT_POLL_INTERVAL_MS) — 2x cet intervalle absorbe un cycle manqué sans clignoter "hors ligne".
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

// Titre court affiché en tête de la carte / page détail. Volontairement limité à des faits
// vérifiables (connectivité, niveau du réservoir) — pas de jugement du type "le sol est sec" ou
// "la plante va bien", qui relève du Health Engine (Lot 4, pas encore implémenté).
export function statusHeadline(device: Device): string {
  if (!isDeviceOnline(device.lastSeenAt)) {
    return `Hors ligne depuis ${formatRelativeTime(device.lastSeenAt)}`;
  }
  if (isTankLow(device)) {
    return 'Le réservoir commence à se vider';
  }
  return 'Tout fonctionne normalement';
}

export function statusBandClasses(device: Device): { band: string; icon: string } {
  if (!isDeviceOnline(device.lastSeenAt)) return { band: 'bg-muted', icon: 'text-muted-foreground' };
  if (isTankLow(device)) return { band: 'bg-warning-surface', icon: 'text-warning-foreground' };
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
