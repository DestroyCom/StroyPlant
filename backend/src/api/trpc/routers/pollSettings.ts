import { z } from 'zod';
import { getPollSettings, upsertPollSettings } from '../../../ble/pollSettings.js';
import { protectedProcedure, router } from '../trpc.js';

export const pollSettingsRouter = router({
  // Instance-wide, editable from the Settings page instead of the old PARROT_POLL_INTERVAL_MS env
  // var — see ble/pollSettings.ts.
  get: protectedProcedure.query(() => getPollSettings()),

  upsert: protectedProcedure
    .input(z.object({ pollIntervalMinutes: z.number().int().min(1).max(1440) }))
    .mutation(({ input }) => upsertPollSettings(input)),
});
