import { prisma } from '../db/client.js';

const SETTINGS_ID = 1;

export interface HealthSettingsValues {
  baselineWindowDays: number;
  warmupMinDays: number;
  // IANA timezone name, used by health/dailyLightIntegral.ts's calendar-day grouping (Part H).
  timezone: string;
  // Inference engine Phase B (shadow mode) — off by default, see schema.prisma's comment.
  shadowModeEnabled: boolean;
}

const DEFAULTS: HealthSettingsValues = { baselineWindowDays: 14, warmupMinDays: 3, timezone: 'UTC', shadowModeEnabled: false };

// Validates a string is a real IANA timezone the JS Intl API accepts — the one place this matters,
// since an invalid value would silently make health/dailyLightIntegral.ts's Intl.DateTimeFormat
// call throw for every device's luminosity scoring, not just fail to save. Validated here (the
// single choke point every caller, including the tRPC mutation, goes through) rather than at the
// call site, per the project's "validate at system boundaries" convention.
function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export async function getHealthSettings(): Promise<HealthSettingsValues> {
  const settings = await prisma.healthSettings.findUnique({ where: { id: SETTINGS_ID } });
  return settings
    ? {
        baselineWindowDays: settings.baselineWindowDays,
        warmupMinDays: settings.warmupMinDays,
        timezone: settings.timezone,
        shadowModeEnabled: settings.shadowModeEnabled,
      }
    : DEFAULTS;
}

export async function upsertHealthSettings(values: HealthSettingsValues): Promise<HealthSettingsValues> {
  if (!isValidTimezone(values.timezone)) {
    throw new Error(`Invalid IANA timezone: "${values.timezone}"`);
  }
  const settings = await prisma.healthSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...values },
    update: values,
  });
  return {
    baselineWindowDays: settings.baselineWindowDays,
    warmupMinDays: settings.warmupMinDays,
    timezone: settings.timezone,
    shadowModeEnabled: settings.shadowModeEnabled,
  };
}
