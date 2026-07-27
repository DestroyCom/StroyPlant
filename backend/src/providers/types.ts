export type DeviceKind = 'PARROT_POT' | 'XIAOMI_LYWSD03MMC';

export interface ParrotPotReading {
  soilMoisturePercent: number;
  temperatureC: number;
  luminosity: number;
  waterTankLevelPercent?: number;
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

  triggerAction(deviceId: string, action: DeviceAction): Promise<void>;
}
