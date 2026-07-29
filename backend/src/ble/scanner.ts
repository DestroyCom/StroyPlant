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

// Backoff for restarting provider.scan() after it throws (2026-07-29 production incident: a
// single transient "Resource Not Ready" — BlueZ mid-power-cycle, see restartAdapter() in
// node-ble/index.ts — killed scan() forever, since nothing relaunched it; every device then
// silently stopped syncing until the process was manually restarted). Capped exponential backoff,
// reset once a scan run has stayed up long enough to be considered healthy again.
const SCAN_RESTART_BASE_DELAY_MS = 5_000;
const SCAN_RESTART_MAX_DELAY_MS = 60_000;
const SCAN_HEALTHY_UPTIME_MS = 60_000;

export function startScanner(
  provider: DeviceProvider,
  callbacks: ScannerCallbacks,
  connectionQueue: ConnectionQueue,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
) {
  const controller = new AbortController();
  const lastPolled = new Map<string, number>();

  // Shared by the scanner's own discovery-driven polling (throttled per pollIntervalMs) and
  // devices.forceSyncAll (manual, bypasses the throttle) — same connectionQueue-serialized read +
  // persistence path either way, so a manual sync is never a second, divergent code path.
  const pollDeviceNow = (deviceId: string, kind: DeviceKind) => {
    lastPolled.set(deviceId, Date.now());
    return connectionQueue.run(async () => {
      try {
        const reading = await provider.readSensors(deviceId, kind);
        await callbacks.onReading(deviceId, kind, reading);
      } catch (error) {
        // Never swallow an error silently (docs/STROYPLANT_SPEC.md section 7.1).
        log({
          direction: 'READ',
          label: 'Poll readSensors failed',
          deviceId,
          result: 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    });
  };

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
    // marked before execution (pollDeviceNow does this too) so the device isn't re-queued while a
    // reading is already in flight
    pollDeviceNow(device.id, device.kind);
  };

  async function runScanLoop() {
    let delayMs = SCAN_RESTART_BASE_DELAY_MS;
    while (!controller.signal.aborted) {
      const startedAt = Date.now();
      try {
        await provider.scan(onDiscovered, controller.signal);
        if (controller.signal.aborted) return;
        // provider.scan() is documented to run until `signal` aborts, so a clean return before
        // that means the provider gave up — treat it the same as a thrown error (fall through to
        // the backoff/restart below) rather than exiting the loop silently.
        throw new Error('provider.scan() returned without the abort signal firing');
      } catch (error) {
        if (controller.signal.aborted) return;
        log({
          direction: 'SCAN',
          label: `Scanner (${provider.name}) stopped on error — restarting in ${delayMs}ms`,
          result: 'ERROR',
          detail: error instanceof Error ? error.message : String(error),
        });
      }

      delayMs =
        Date.now() - startedAt >= SCAN_HEALTHY_UPTIME_MS ? SCAN_RESTART_BASE_DELAY_MS : Math.min(delayMs * 2, SCAN_RESTART_MAX_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  void runScanLoop();

  return { stop: () => controller.abort(), pollDeviceNow };
}
