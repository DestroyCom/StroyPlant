// Must be the very first import in index.ts, before any other module — Sentry.init() has to run
// before fastify/node-ble/etc. are loaded for its instrumentation to patch them correctly.
import * as Sentry from '@sentry/node';
import { env } from './env.js';

if (env.sentryDsn) {
  Sentry.init({
    dsn: env.sentryDsn,
    environment: env.nodeEnv,
    // Low in production to keep GlitchTip's disk usage manageable — this is crash/error
    // monitoring first, deep tracing is a bonus, not the goal (see CLAUDE.md rule 7.1: BLE errors
    // are already never silently swallowed, logged via logger.ts; this adds off-site alerting on
    // top of that, not a replacement for it).
    tracesSampleRate: env.nodeEnv === 'production' ? 0.01 : 1.0,
  });
}
