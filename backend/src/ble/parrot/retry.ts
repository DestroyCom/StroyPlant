import { log } from '../../logger.js';

// Pattern de résilience confirmé par l'app officielle Parrot (docs/STROYPLANT_SPEC.md section 7.1,
// docs/PARROT_BLE_DEEP_DIVE.md section 5) : jusqu'à 3 tentatives de connexion GATT, timeout 15-20s par
// tentative. Sur GATT_ERROR (133, très fréquente) : backoff fixe de 500ms avant retry ; à la 2e
// occurrence CONSÉCUTIVE, redémarrer l'adaptateur Bluetooth (disable/enable) plutôt que de continuer
// à réessayer sur un adaptateur probablement dans un mauvais état.
export const CONNECT_RETRY_ATTEMPTS = 3;
export const GATT_133_BACKOFF_MS = 500;
export const CONNECT_TIMEOUT_MS = 18000; // dans la fourchette 15-20s de la spec

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GattRetryHooks<T> {
  label: string;
  deviceId: string;
  attempt: () => Promise<T>;
  // Détection du code GATT_ERROR=133 (ou équivalent) — dépend du provider, voir commentaires dans
  // node-ble/index.ts et noble-bridge/ble-client.ts. Sur macOS/noble, CoreBluetooth n'expose pas le
  // code réel (NSError avalé) : le provider traite alors TOUT échec comme équivalent à 133, ce qui
  // reste cohérent avec la doc (133 est l'erreur générique la plus fréquente).
  isGattError133: (error: unknown) => boolean;
  // Redémarre l'adaptateur Bluetooth (disable puis enable, jusqu'à 60s d'attente). Sur noble/macOS,
  // ce n'est pas praticable proprement (couperait tout le Bluetooth du Mac) — le provider passe un
  // no-op qui se contente de logguer une recommandation, comme le fait déjà le PoC parrot-pot-debug.
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
          label: `${hooks.label}: échec GATT (probable GATT_ERROR=133), tentative ${attemptNum}/${CONNECT_RETRY_ATTEMPTS}`,
          deviceId: hooks.deviceId,
          result: 'ERROR',
          detail,
        });

        if (consecutive133 >= 2 && attemptNum < CONNECT_RETRY_ATTEMPTS) {
          log({
            direction: 'CONNECT',
            label: `${hooks.label}: 2e échec GATT_ERROR=133 consécutif — redémarrage de l'adaptateur avant nouvelle tentative`,
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
          label: `${hooks.label}: échec de connexion, tentative ${attemptNum}/${CONNECT_RETRY_ATTEMPTS}`,
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
