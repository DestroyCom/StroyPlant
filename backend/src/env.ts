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
  parrotPollIntervalMs: process.env.PARROT_POLL_INTERVAL_MS ? Number(process.env.PARROT_POLL_INTERVAL_MS) : undefined,
  betterAuthSecret: process.env.BETTER_AUTH_SECRET ?? DEV_ONLY_FALLBACK_SECRET,
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? `http://localhost:${Number(process.env.PORT ?? 3000)}`,
  // Health Engine (Batch 4, docs/STROYPLANT_SPEC.md section 7.3) — rolling baseline window per
  // device and minimum number of days before leaving "warm-up" mode (no alert as long as the
  // personal baseline doesn't have enough data, to avoid false positives from day 1).
  healthBaselineWindowDays: Number(process.env.HEALTH_BASELINE_WINDOW_DAYS ?? 14),
  healthWarmupMinDays: Number(process.env.HEALTH_WARMUP_MIN_DAYS ?? 3),
  // Auto-watering scheduler (Batch 5, docs/STROYPLANT_SPEC.md section 7.4) — how often the cron
  // re-evaluates every device's schedule. Deliberately independent from the BLE scan/poll
  // interval: the scheduler only reads already-collected Reading rows, it never triggers its own
  // BLE read cycle (only a watering write, when it decides to act).
  schedulerTickIntervalMs: Number(process.env.SCHEDULER_TICK_INTERVAL_MS ?? 15 * 60_000),
  // MQTT + Home Assistant auto-discovery (Batch 7, docs/STROYPLANT_SPEC.md section 7.7).
  // MQTT_URL unset means the integration is entirely disabled — DestCom has no broker to test
  // against yet, so this must never be required for the backend to start.
  mqttUrl: process.env.MQTT_URL,
  mqttUsername: process.env.MQTT_USERNAME,
  mqttPassword: process.env.MQTT_PASSWORD,
  mqttDiscoveryPrefix: process.env.MQTT_DISCOVERY_PREFIX ?? 'homeassistant',
  mqttBaseTopic: process.env.MQTT_BASE_TOPIC ?? 'stroyplant',
};
