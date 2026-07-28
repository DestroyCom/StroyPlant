// Manual mirror of the tRPC procedure output shapes (backend/src/api/trpc/routers/*.ts,
// backend/prisma/schema.prisma) — kept as plain types rather than trusting
// `inferRouterOutputs<AppRouter>` because tRPC's default (no-transformer) wire format serializes
// `Date` fields to ISO strings with no client-side revival; the backend explicitly converts them
// (see backend/src/api/trpc/serialize.ts), so these interfaces intentionally type them as
// `string`, matching what actually arrives over the wire, not the raw Prisma `Date` type.

export type DeviceKind = 'PARROT_POT' | 'XIAOMI_LYWSD03MMC';

export interface Reading {
  id: number;
  deviceId: string;
  timestamp: string;
  soilMoisturePercent: number | null;
  temperatureC: number | null;
  luminosity: number | null;
  waterTankLevelPercent: number | null;
  // "Soil conductivity" candidates (39e1fa0d/0e) — collected but not yet used by the Health
  // Engine, see docs/STROYPLANT_SPEC.md section 8.
  soilConductivityEcb: number | null;
  soilConductivityEcPorous: number | null;
  humidityPercent: number | null;
  batteryPercent: number | null;
}

export interface PlantProfile {
  id: number;
  name: string;
  commonName: string | null;
  soilMoistureMinPercent: number | null;
  soilMoistureMaxPercent: number | null;
  soilConductivityMinUsCm: number | null;
  soilConductivityMaxUsCm: number | null;
  soilPhMin: number | null;
  soilPhMax: number | null;
  temperatureMinC: number | null;
  temperatureMaxC: number | null;
  humidityMinPercent: number | null;
  humidityMaxPercent: number | null;
  lightMinLux: number | null;
  lightMaxLux: number | null;
  lightMinMmol: number | null;
  lightMaxMmol: number | null;
}

export type ParameterKey = 'soilMoisturePercent' | 'temperatureC' | 'humidityPercent' | 'luminosity' | 'soilConductivityEcPorous';
export type ParameterStatus = 'ok' | 'too_low' | 'too_high' | 'n/a';

export interface ParameterHealth {
  value: number;
  status: ParameterStatus;
  speciesRange: [number, number] | null;
}

export type HealthTrend = 'stable' | 'degrading' | 'improving' | 'unknown';
export type DeviceHealthStatus = 'ok' | 'warning' | 'warming_up' | 'no_profile';

export interface DeviceHealth {
  status: DeviceHealthStatus;
  parameters: Partial<Record<ParameterKey, ParameterHealth>>;
  trend: HealthTrend;
}

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string | null;
  lastSeenAt: string | null;
  lastReading: Reading | null;
  plantProfile: PlantProfile | null;
}

export interface WateringEvent {
  id: number;
  deviceId: string;
  timestamp: string;
  triggerSource: 'MANUAL' | 'CRON';
  success: boolean;
  errorDetail: string | null;
}
