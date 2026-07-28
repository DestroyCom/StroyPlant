import { devicesRouter } from './routers/devices.js';
import { healthRouter } from './routers/health.js';
import { plantDrRouter } from './routers/plantDr.js';
import { readingsRouter } from './routers/readings.js';
import { scheduleRouter } from './routers/schedule.js';
import { router } from './trpc.js';

export const appRouter = router({
  devices: devicesRouter,
  health: healthRouter,
  plantDr: plantDrRouter,
  readings: readingsRouter,
  schedule: scheduleRouter,
});

export type AppRouter = typeof appRouter;
