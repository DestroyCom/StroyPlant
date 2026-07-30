import { prisma } from '../db/client.js';

const SETTINGS_ID = 1;

export interface PollSettingsValues {
  pollIntervalMinutes: number;
}

const DEFAULTS: PollSettingsValues = { pollIntervalMinutes: 5 };

// Editable from the Settings page instead of the old PARROT_POLL_INTERVAL_MS env var (see
// health/settings.ts for the same pattern) — no row yet means "defaults".
export async function getPollSettings(): Promise<PollSettingsValues> {
  const settings = await prisma.pollSettings.findUnique({ where: { id: SETTINGS_ID } });
  return settings ? { pollIntervalMinutes: settings.pollIntervalMinutes } : DEFAULTS;
}

export async function upsertPollSettings(values: PollSettingsValues): Promise<PollSettingsValues> {
  const settings = await prisma.pollSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...values },
    update: values,
  });
  return { pollIntervalMinutes: settings.pollIntervalMinutes };
}
