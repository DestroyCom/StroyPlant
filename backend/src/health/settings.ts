import { prisma } from '../db/client.js';

const SETTINGS_ID = 1;

export interface HealthSettingsValues {
  baselineWindowDays: number;
  warmupMinDays: number;
}

const DEFAULTS: HealthSettingsValues = { baselineWindowDays: 14, warmupMinDays: 3 };

// Editable from the Settings page instead of env vars (see MqttSettings for the same pattern) — no
// row yet means "defaults", same convention as Schedule's resolveEffectiveSchedule.
export async function getHealthSettings(): Promise<HealthSettingsValues> {
  const settings = await prisma.healthSettings.findUnique({ where: { id: SETTINGS_ID } });
  return settings ? { baselineWindowDays: settings.baselineWindowDays, warmupMinDays: settings.warmupMinDays } : DEFAULTS;
}

export async function upsertHealthSettings(values: HealthSettingsValues): Promise<HealthSettingsValues> {
  const settings = await prisma.healthSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...values },
    update: values,
  });
  return { baselineWindowDays: settings.baselineWindowDays, warmupMinDays: settings.warmupMinDays };
}
