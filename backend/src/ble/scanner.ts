import { log } from '../logger.js';
import type { DeviceKind, DeviceProvider, DiscoveredDevice, SensorReading } from '../providers/types.js';
import type { ConnectionQueue } from './connectionQueue.js';

export interface ScannerCallbacks {
  onDeviceSeen: (device: DiscoveredDevice) => Promise<void>;
  onReading: (deviceId: string, kind: DeviceKind, reading: SensorReading) => Promise<void>;
}

// Polling interval for Parrot Pot sensors (GATT connection via the connectionQueue). No value
// mandated by the spec for Batch 1 (which only covers reading capture — scoring/alerting cadence
// is a Health Engine concern, Batch 4) — 5 minutes is a reasonable default, adjustable via
// PARROT_POLL_INTERVAL_MS.
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
      // The device upsert MUST complete before any reading write (foreign key) —
      // never run the two in parallel.
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

    // Passive case (no currently known device actually is one — see comment on
    // DiscoveredDevice.reading in providers/types.ts): the reading is already in the advertisement.
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

    // Both Parrot Pot AND Xiaomi LYWSD03MMC require a GATT connection (see
    // docs/STROYPLANT_SPEC.md section 3 correction) — so they share the same sequential queue,
    // only one GATT connection at a time regardless of device type.
    const last = lastPolled.get(device.id) ?? 0;
    if (Date.now() - last < pollIntervalMs) return;
    lastPolled.set(device.id, Date.now()); // marked before execution so it isn't re-queued while a reading is already in flight

    connectionQueue.run(async () => {
      try {
        const reading = await provider.readSensors(device.id, device.kind);
        await callbacks.onReading(device.id, device.kind, reading);
      } catch (error) {
        // Never swallow an error silently (docs/STROYPLANT_SPEC.md section 7.1).
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
      label: `Scanner (${provider.name}) stopped on error`,
      result: 'ERROR',
      detail: error instanceof Error ? error.message : String(error),
    });
  });

  return { stop: () => controller.abort() };
}
