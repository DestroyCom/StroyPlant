import * as Sentry from '@sentry/react';

// Awaited before the app renders (see main.tsx) — Sentry must be initialized before any other
// code runs to catch early errors, but the DSN can't be a build-time value: it's fetched live from
// the backend's /api/public-config instead, so this repo's public Docker image never has this
// deployment's GlitchTip domain baked into its bundled JS.
export async function initSentry(): Promise<void> {
  try {
    const response = await fetch('/api/public-config');
    const { sentryDsn } = (await response.json()) as { sentryDsn: string | null };
    if (!sentryDsn) return;

    Sentry.init({
      dsn: sentryDsn,
      environment: import.meta.env.MODE,
      integrations: [Sentry.browserTracingIntegration()],
      // Low in production to keep GlitchTip's disk usage manageable — this is crash/error
      // monitoring first, deep tracing is a bonus, not the goal.
      tracesSampleRate: import.meta.env.PROD ? 0.01 : 1.0,
    });
  } catch {
    // Monitoring must never block the app from booting — best-effort only.
  }
}
