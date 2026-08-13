export type BleProviderName = 'mock' | 'noble-bridge' | 'node-ble';

function requireEnum<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid ${name}=${value} — expected one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

const DEV_ONLY_FALLBACK_SECRET = 'dev-only-insecure-secret-change-me';

if (!process.env.BETTER_AUTH_SECRET) {
  console.warn('[env] BETTER_AUTH_SECRET not set — using dev fallback, set a real value before any real deployment.');
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  bleProvider: requireEnum<BleProviderName>('BLE_PROVIDER', process.env.BLE_PROVIDER, ['mock', 'noble-bridge', 'node-ble'], 'mock'),
  nobleBridgeUrl: process.env.NOBLE_BRIDGE_URL ?? 'http://localhost:4100',
  betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? DEV_ONLY_FALLBACK_SECRET,
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
  // Auto-watering scheduler (Batch 5, docs/STROYPLANT_SPEC.md section 7.4) — how often the cron
  // re-evaluates every device's schedule. Deliberately independent from the BLE scan/poll
  // interval: the scheduler only reads already-collected Reading rows, it never triggers its own
  // BLE read cycle (only a watering write, when it decides to act).
  schedulerTickIntervalMs: Number(process.env.SCHEDULER_TICK_INTERVAL_MS ?? 15 * 60_000),
  // GlitchTip (self-hosted, Sentry-compatible) error monitoring. Optional — unset disables it
  // entirely (see instrument.ts). Deliberately a runtime env var, not baked into the Docker image
  // at build time: the frontend never gets this value in its bundle either, it fetches it live
  // from GET /api/public-config (api/server.ts) — this repo's Docker image is published publicly
  // (.github/workflows/docker-publish.yml), so this instance's DSN/domain must never end up
  // embedded in that published artifact.
  sentryDsn: process.env.SENTRY_DSN,
  // Baked into the image at build time (Dockerfile's GIT_SHA build arg, set from github.sha by
  // .github/workflows/docker-publish.yml) — never set in local `pnpm dev` (null there, the
  // frontend's Version card treats that as "local development build"). A commit SHA isn't a
  // secret (this repo is public), unlike sentryDsn above — safe to bake directly rather than
  // fetch at runtime.
  gitSha: process.env.GIT_SHA || null,
};
