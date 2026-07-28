// Miroir des types backend (backend/prisma/schema.prisma, backend/src/api/ws.ts). Pas de package
// partagé entre backend et frontend (même convention que noble-bridge qui duplique ses propres
// types) — à garder synchronisé manuellement si le schéma évolue.

export type DeviceKind = 'PARROT_POT' | 'XIAOMI_LYWSD03MMC';

export interface Reading {
  id: number;
  deviceId: string;
  timestamp: string;
  soilMoisturePercent: number | null;
  temperatureC: number | null;
  luminosity: number | null;
  waterTankLevelPercent: number | null;
  humidityPercent: number | null;
  batteryPercent: number | null;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string | null;
  lastSeenAt: string | null;
  lastReading: Reading | null;
}

export interface WateringEvent {
  id: number;
  deviceId: string;
  timestamp: string;
  triggerSource: 'MANUAL' | 'CRON';
  success: boolean;
  errorDetail: string | null;
}

export interface LiveReadingMessage {
  type: 'reading';
  deviceId: string;
  kind: DeviceKind;
  reading: Reading;
}
