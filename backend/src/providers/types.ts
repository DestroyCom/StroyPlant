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

// A single BLE advertisement/discovery event. `reading` is populated directly for passively-advertised
// devices (Xiaomi pvvx firmware broadcasts sensor data in the advertisement itself, no GATT connection
// needed) and left undefined for devices that require a GATT connection to read sensors (Parrot Pot).
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

  // Connects to a Parrot Pot (GATT) and reads its live sensors. Callers are responsible for
  // serializing calls to this method (see ble/connectionQueue.ts) — providers do not queue internally.
  readSensors(deviceId: string): Promise<SensorReading>;

  triggerAction(deviceId: string, action: DeviceAction): Promise<void>;
}
