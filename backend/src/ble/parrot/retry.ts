import { log } from '../../logger.js';

// Resilience pattern confirmed by the official Parrot app (docs/STROYPLANT_SPEC.md section 7.1,
// docs/PARROT_BLE_DEEP_DIVE.md section 5): up to 3 GATT connection attempts, 15-20s timeout per
// attempt. On GATT_ERROR (133, very frequent): fixed 500ms backoff before retry; on the 2nd
// CONSECUTIVE occurrence, restart the Bluetooth adapter (disable/enable) rather than keep
// retrying on an adapter that's probably in a bad state.
export const CONNECT_RETRY_ATTEMPTS = 3;
export const GATT_133_BACKOFF_MS = 500;
export const CONNECT_TIMEOUT_MS = 18000; // within the spec's 15-20s range

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GattRetryHooks<T> {
  label: string;
  deviceId: string;
  attempt: () => Promise<T>;
  // Detection of the GATT_ERROR=133 code (or equivalent) — depends on the provider, see comments in
  // node-ble/index.ts and noble-bridge/ble-client.ts. On macOS/noble, CoreBluetooth doesn't expose
  // the real code (NSError swallowed): the provider then treats ANY failure as equivalent to 133,
  // which remains consistent with the doc (133 is the most frequent generic error).
  isGattError133: (error: unknown) => boolean;
  // Restarts the Bluetooth adapter (disable then enable, up to 60s wait). On noble/macOS,
  // this isn't cleanly practicable (it would cut off the Mac's whole Bluetooth) — the provider passes
  // a no-op that just logs a recommendation, as the parrot-pot-debug PoC already does.
  restartAdapter: () => Promise<void>;
}

export async function withGattRetry<T>(hooks: GattRetryHooks<T>): Promise<T> {
  let lastError: unknown;
  let consecutive133 = 0;

  for (let attemptNum = 1; attemptNum <= CONNECT_RETRY_ATTEMPTS; attemptNum++) {
    try {
      const result = await hooks.attempt();
      return result;
    } catch (error) {
      lastError = error;
      const is133 = hooks.isGattError133(error);
      const detail = error instanceof Error ? error.message : String(error);

      if (is133) {
        consecutive133++;
        log({
          direction: 'CONNECT',
          label: `${hooks.label}: GATT failure (probable GATT_ERROR=133), attempt ${attemptNum}/${CONNECT_RETRY_ATTEMPTS}`,
          deviceId: hooks.deviceId,
          result: 'ERROR',
          detail,
        });

        if (consecutive133 >= 2 && attemptNum < CONNECT_RETRY_ATTEMPTS) {
          log({
            direction: 'CONNECT',
            label: `${hooks.label}: 2nd consecutive GATT_ERROR=133 — restarting the adapter before retrying`,
            deviceId: hooks.deviceId,
            result: 'ERROR',
          });
          await hooks.restartAdapter();
          consecutive133 = 0;
        } else if (attemptNum < CONNECT_RETRY_ATTEMPTS) {
          await sleep(GATT_133_BACKOFF_MS);
        }
      } else {
        consecutive133 = 0;
        log({
          direction: 'CONNECT',
          label: `${hooks.label}: connection failure, attempt ${attemptNum}/${CONNECT_RETRY_ATTEMPTS}`,
          deviceId: hooks.deviceId,
          result: 'ERROR',
          detail,
        });
        if (attemptNum < CONNECT_RETRY_ATTEMPTS) {
          await sleep(GATT_133_BACKOFF_MS);
        }
      }
    }
  }

  throw lastError;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeoutHandle!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`TIMEOUT: ${label} (${timeoutMs}ms)`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutHandle));
}
