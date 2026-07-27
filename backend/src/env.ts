export type BleProviderName = 'mock' | 'noble-bridge' | 'node-ble';

function requireEnum<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid ${name}=${value} — expected one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  bleProvider: requireEnum<BleProviderName>('BLE_PROVIDER', process.env.BLE_PROVIDER, ['mock', 'noble-bridge', 'node-ble'], 'mock'),
  nobleBridgeUrl: process.env.NOBLE_BRIDGE_URL ?? 'http://localhost:4100',
  parrotPollIntervalMs: process.env.PARROT_POLL_INTERVAL_MS ? Number(process.env.PARROT_POLL_INTERVAL_MS) : undefined,
};
