import type { PlantDrCalibration, PlantDrWriteValues } from '../ble/parrot/plantDr.js';

export type DeviceKind = 'PARROT_POT' | 'XIAOMI_LYWSD03MMC';

export interface ParrotPotReading {
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent?: number;
  // Two raw candidates for "Soil conductivity" (WatchFlower CSV) — see
  // docs/STROYPLANT_SPEC.md section 8 and ble/parrot/uuids.ts. Optional: the reading can fail
  // silently without failing the whole read (the official app never uses them,
  // their actual behavior on the Parrot Pot firmware isn't guaranteed).
  soilConductivityEcb?: number;
  soilConductivityEcPorous?: number;
  // Plant Dr STATUS_FLAGS (Batch 6, docs/STROYPLANT_SPEC.md section 7.11) — firmware-computed
  // soil/reservoir/probe state. Best-effort like the conductivity fields above (never used by the
  // official app's live mode, behavior not guaranteed on every firmware revision).
  isDrySoil?: boolean;
  isWetSoil?: boolean;
  isEmptyTank?: boolean;
  // A reading taken while the probe isn't in the soil doesn't represent a plant state — the Health
  // Engine excludes it from rolling-baseline calculations (docs/STROYPLANT_SPEC.md section 7.3).
  isInAir?: boolean;
}

export interface XiaomiReading {
  temperatureC: number;
  humidityPercent: number;
  batteryPercent?: number;
}

export type SensorReading = { kind: 'PARROT_POT'; data: ParrotPotReading } | { kind: 'XIAOMI_LYWSD03MMC'; data: XiaomiReading };

// A single BLE advertisement/discovery event. `reading` stays undefined in practice today — both
// Parrot Pot AND Xiaomi LYWSD03MMC require an active GATT connection to read sensors (the Xiaomi
// stock-firmware advertisement is encrypted MiBeacon, not plaintext — see docs/STROYPLANT_SPEC.md
// section 3 correction). Kept optional for a future passive-capable device (e.g. Xiaomi flashed
// with pvvx custom firmware in an unencrypted advertising mode).
export interface DiscoveredDevice {
  id: string; // MAC address, uppercase colon-separated — stable identifier across all 3 providers
  kind: DeviceKind;
  name?: string;
  rssi?: number;
  reading?: SensorReading;
  // Parrot Pot only — raw manufacturer data payload (hex), see ble/parrot/advertisement.ts.
  // Deliberately left uninterpreted (see docs/STROYPLANT_SPEC.md section 7.1, correlation protocol
  // not executed yet) — logged for diagnostics, never used to decide a connection.
  advertisementPayloadHex?: string;
}

export type DeviceAction = 'water';

export interface DeviceProvider {
  readonly name: string;

  // Starts continuous BLE discovery. Resolves once `signal` aborts (or the provider stops on its own
  // after an unrecoverable error, which it reports by throwing). Never silently swallows scan errors.
  scan(onDiscovered: (device: DiscoveredDevice) => void, signal: AbortSignal): Promise<void>;

  // Connects in GATT (Parrot Pot or Xiaomi LYWSD03MMC — both require a connection) and reads
  // sensors. Callers are responsible for serializing calls to this method (see
  // ble/connectionQueue.ts) — providers do not queue internally. `kind` is passed by the caller
  // (already known from discovery) since a provider can't always infer device type from id alone.
  readSensors(deviceId: string, kind: DeviceKind): Promise<SensorReading>;

  // Streams live sensor samples (real GATT notify on the Parrot Pot, best-effort on the Xiaomi —
  // see docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md) until `signal` aborts.
  // Resolves cleanly on abort. Throws on any unrecoverable failure (GATT error, unexpected
  // disconnect) — callers must treat a thrown error as the session having ended abnormally, never
  // retry it themselves (a live session that already streamed real samples must not silently
  // restart from scratch). `onSample` is awaited before the provider processes the next
  // notification, so persistence (which it triggers) never races itself.
  subscribeLive(
    deviceId: string,
    kind: DeviceKind,
    onSample: (reading: SensorReading) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void>;

  triggerAction(deviceId: string, action: DeviceAction): Promise<void>;

  // Plant Dr device-side calibration (Batch 6, docs/STROYPLANT_SPEC.md section 7.11), Parrot Pot
  // only. Providers are "dumb" here — the checksum/encoding logic lives once in
  // ble/parrot/plantDr.ts, callers pass already-computed write values.
  readPlantDrCalibration(deviceId: string): Promise<PlantDrCalibration>;
  writePlantDrCalibration(deviceId: string, values: PlantDrWriteValues): Promise<void>;
}
