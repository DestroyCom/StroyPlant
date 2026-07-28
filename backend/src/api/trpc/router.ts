import { devicesRouter } from './routers/devices.js';
import { healthRouter } from './routers/health.js';
import { readingsRouter } from './routers/readings.js';
import { scheduleRouter } from './routers/schedule.js';
import { router } from './trpc.js';

export const appRouter = router({
  devices: devicesRouter,
  health: healthRouter,
  readings: readingsRouter,
  schedule: scheduleRouter,
});

export type AppRouter = typeof appRouter;
