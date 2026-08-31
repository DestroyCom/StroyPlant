import { devicesRouter } from './routers/devices.js';
import { discoverySessionRouter } from './routers/discoverySession.js';
import { healthRouter } from './routers/health.js';
import { historyRouter } from './routers/history.js';
import { liveSessionRouter } from './routers/liveSession.js';
import { mqttRouter } from './routers/mqtt.js';
import { plantDrRouter } from './routers/plantDr.js';
import { pollSettingsRouter } from './routers/pollSettings.js';
import { readingsRouter } from './routers/readings.js';
import { scheduleRouter } from './routers/schedule.js';
import { wateringConfigRouter } from './routers/wateringConfig.js';
import { router } from './trpc.js';

export const appRouter = router({
  devices: devicesRouter,
  discoverySession: discoverySessionRouter,
  health: healthRouter,
  history: historyRouter,
  liveSession: liveSessionRouter,
  mqtt: mqttRouter,
  plantDr: plantDrRouter,
  pollSettings: pollSettingsRouter,
  readings: readingsRouter,
  schedule: scheduleRouter,
  wateringConfig: wateringConfigRouter,
});

export type AppRouter = typeof appRouter;
