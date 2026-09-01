import type { PlantDrCalibration, PlantDrWriteValues } from '../ble/parrot/plantDr.js';
import type { WateringConfigRaw, WateringConfigWriteValues } from '../ble/parrot/wateringConfig.js';

export type DeviceKind = 'PARROT_POT' | 'XIAOMI_LYWSD03MMC';

export interface ParrotPotReading {
  // Independently optional since the 2026-09-01 fa07 outage (docs/superpowers/specs/
  // 2026-09-01-parrot-fa07-independent-decode-fix.md): a truncated/malformed GATT buffer on any
  // one of these must not discard the other two — each is decoded and persisted best-effort, like
  // every other sensor field in this interface.
  soilMoisturePercent?: number;
  temperatureC?: number;
  luminosity?: number;
  waterTankLevelPercent?: number;
  // Plant Dr STATUS_FLAGS (Batch 6, docs/STROYPLANT_SPEC.md section 7.11) — firmware-computed
  // soil/reservoir/probe state. Best-effort (never used by the official app's live mode, behavior
  // not guaranteed on every firmware revision).
  isDrySoil?: boolean;
  isWetSoil?: boolean;
  isEmptyTank?: boolean;
  // A reading taken while the probe isn't in the soil doesn't represent a plant state — the Health
  // Engine excludes it from rolling-baseline calculations (docs/STROYPLANT_SPEC.md section 7.3).
  isInAir?: boolean;

  // Raw sensor debug log (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-
  // and-raw-sensor-log-design.md) — persisted verbatim into RawSensorLog, never used directly for
  // scoring except soilConductivityRaw (see health/soilConductivityCalibration.ts). Deliberately NOT
  // computed into a "fertility" value here anymore — that interpretation now happens at read time,
  // using a per-device calibration that improves as more history accumulates, not at write time
  // against a fixed global constant.
  lightRaw?: number;
  soilConductivityRaw?: number;
  soilTempRaw?: number;
  airTempRaw?: number;
  soilMoistureRaw?: number;
  eaRaw?: number;
  ecbRaw?: number;
  ecPorousRaw?: number;
  watVwcIrr?: number;
  watVwcCmd?: number;
  watNIrr?: number;
  watPumpDutyCycle?: number;
  watVwcIrrEco?: number;
  watVwcCmdEco?: number;
  watNIrrEco?: number;
  watMode?: number;
  watTimeSlotStart?: number;
  watTimeSlotDurr?: number;
  watVacationStart?: number;
  watVacationEnd?: number;
  algorithmStatus?: number;
  plantDrStatusFlagsRaw?: number;
  plantDrDryN?: number;
  plantDrDryVwcRaw?: number;
  plantDrWetN?: number;
  plantDrWetVwcRaw?: number;
  plantDrConfigId?: number;
  plantDrNextWateringDate?: number;
  plantDrNextEmptyTankDate?: number;
  plantDrFullTankAutonomy?: number;
  calibrationDataBlobHex?: string;
  colorRaw?: number;
}

export interface XiaomiReading {
  temperatureC: number;
  humidityPercent: number;
  batteryPercent?: number;

  // Raw sensor debug log — same rationale as ParrotPotReading above.
  tempRaw?: number;
  humidityRaw?: number;
  voltageRawMv?: number;
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

  // Device-side autonomous watering (docs/superpowers/specs/2026-08-30-parrot-device-side-
  // autonomous-watering-design.md), Parrot Pot only. Same "dumb provider" pattern as Plant Dr
  // above — backend/src/wateringConfigPush.ts decides eligibility, does the read-modify-write, and
  // computes CONFIG_ID via computeWateringConfigId(); providers just read/write the 13 f900
  // characteristics in order, CONFIG_ID last.
  readWateringConfig(deviceId: string): Promise<WateringConfigRaw>;
  writeWateringConfig(deviceId: string, values: WateringConfigWriteValues): Promise<void>;
}
