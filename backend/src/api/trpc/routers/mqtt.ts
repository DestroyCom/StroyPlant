import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { getMqttState, reloadMqttClient } from '../../../mqtt/manager.js';
import { protectedProcedure, router } from '../trpc.js';

const SETTINGS_ID = 1;

export const mqttRouter = router({
  // The password is never sent back to the client — `hasPassword` is enough for the Settings UI
  // to show "a password is set" without ever round-tripping the real value.
  get: protectedProcedure.query(async () => {
    const settings = await prisma.mqttSettings.findUnique({ where: { id: SETTINGS_ID } });
    return {
      url: settings?.url ?? null,
      username: settings?.username ?? null,
      hasPassword: !!settings?.password,
      discoveryPrefix: settings?.discoveryPrefix ?? 'homeassistant',
      baseTopic: settings?.baseTopic ?? 'stroyplant',
      connected: getMqttState()?.client.connected ?? false,
    };
  }),

  upsert: protectedProcedure
    .input(
      z.object({
        url: z.string().trim().nullable(),
        username: z.string().trim().nullable(),
        // Omitted entirely = keep the existing password; null or '' = clear it; anything else =
        // set a new one. Distinct from `undefined` so the "leave the password field blank to keep
        // it unchanged" UX doesn't require the client to ever read the real value back.
        password: z.string().nullable().optional(),
        discoveryPrefix: z.string().trim().min(1),
        baseTopic: z.string().trim().min(1),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await prisma.mqttSettings.findUnique({ where: { id: SETTINGS_ID } });
      const password = input.password === undefined ? (existing?.password ?? null) : input.password || null;

      await prisma.mqttSettings.upsert({
        where: { id: SETTINGS_ID },
        create: {
          id: SETTINGS_ID,
          url: input.url,
          username: input.username,
          password,
          discoveryPrefix: input.discoveryPrefix,
          baseTopic: input.baseTopic,
        },
        update: { url: input.url, username: input.username, password, discoveryPrefix: input.discoveryPrefix, baseTopic: input.baseTopic },
      });

      // Applies immediately — no backend restart needed to pick up a Settings change.
      await reloadMqttClient();

      return { connected: getMqttState()?.client.connected ?? false };
    }),
});
