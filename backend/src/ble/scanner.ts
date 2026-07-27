import { log } from '../logger.js';
import type { DeviceKind, DeviceProvider, DiscoveredDevice, SensorReading } from '../providers/types.js';
import type { ConnectionQueue } from './connectionQueue.js';

export interface ScannerCallbacks {
  onDeviceSeen: (device: DiscoveredDevice) => Promise<void>;
  onReading: (deviceId: string, kind: DeviceKind, reading: SensorReading) => Promise<void>;
}

// Intervalle de polling des capteurs Parrot Pot (connexion GATT via la connectionQueue). Pas de
// valeur imposée par la spec pour le Lot 1 (qui ne couvre que la capture des lectures — le rythme
// de scoring/alerting est une préoccupation du Health Engine, Lot 4) — 5 minutes est un défaut
// raisonnable, ajustable via PARROT_POLL_INTERVAL_MS.
const DEFAULT_POLL_INTERVAL_MS = 5 * 60_000;

export function startScanner(
  provider: DeviceProvider,
  callbacks: ScannerCallbacks,
  connectionQueue: ConnectionQueue,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
) {
  const controller = new AbortController();
  const lastPolled = new Map<string, number>();

  const onDiscovered = async (device: DiscoveredDevice) => {
    try {
      // Le upsert du device DOIT être terminé avant toute écriture de reading (clé étrangère) —
      // jamais lancer les deux en parallèle.
      await callbacks.onDeviceSeen(device);
    } catch (error) {
      log({
        direction: 'INFO',
        label: 'onDeviceSeen failed',
        deviceId: device.id,
        result: 'ERROR',
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    // Devices passifs (Xiaomi) : la lecture est déjà dans l'annonce, pas de connexion GATT.
    if (device.reading) {
      callbacks.onReading(device.id, device.kind, device.reading).catch((error) => {
        log({
          direction: 'INFO',
          label: 'onReading failed',
          deviceId: device.id,
          result: 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    if (device.kind !== 'PARROT_POT') return;

    const last = lastPolled.get(device.id) ?? 0;
    if (Date.now() - last < pollIntervalMs) return;
    lastPolled.set(device.id, Date.now()); // marqué avant l'exécution pour ne pas ré-empiler pendant qu'une lecture est déjà en vol

    connectionQueue.run(async () => {
      try {
        const reading = await provider.readSensors(device.id);
        await callbacks.onReading(device.id, device.kind, reading);
      } catch (error) {
        // Ne jamais avaler une erreur silencieusement (STROYPLANT_SPEC.md section 7.1).
        log({
          direction: 'READ',
          label: 'Poll readSensors failed',
          deviceId: device.id,
          result: 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

  provider.scan(onDiscovered, controller.signal).catch((error) => {
    log({
      direction: 'SCAN',
      label: `Scanner (${provider.name}) arrêté sur erreur`,
      result: 'ERROR',
      detail: error instanceof Error ? error.message : String(error),
    });
  });

  return { stop: () => controller.abort() };
}
