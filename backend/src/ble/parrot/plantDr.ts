// Plant Dr service (39e1FD80) — device-side dry/wet calibration algorithm, Batch 6.
// See docs/STROYPLANT_SPEC.md section 7.11 and docs/PARROT_BLE_DEEP_DIVE.md sections 2 and 4.

export interface PlantDrCalibrationPoint {
  // Raw device-internal value paired with a VWC% at calibration time. Written back to the
  // firmware as-is (int16) — its exact physical meaning (raw capacitive sensor count?) is not
  // confirmed by the decompiled source, see the calibration write path for how it's obtained.
  n: number;
  vwcPercent: number;
}

export interface PlantDrConfig {
  dry: PlantDrCalibrationPoint;
  wet: PlantDrCalibrationPoint;
}

function toInt16(value: number): number {
  return (value << 16) >> 16;
}

// `PlantConfig.getPDConfigId()` (docs/PARROT_BLE_DEEP_DIVE.md section 2) — XOR of all 4 fields,
// each truncated to int16 (VWC rounded to one decimal, i.e. *10, like the Watering config).
// Verified against a real device (2026-07-28, PARROT-A073, read-only): stored DRY_VWC=175,
// WET_VWC=225, DRY_N=WET_N=0 (factory defaults, never manually calibrated) produced the exact
// CONFIG_ID (78) this device already had — confirms both the formula and the *10 VWC encoding.
export function computePlantDrConfigId(config: PlantDrConfig): number {
  const dryN = toInt16(config.dry.n);
  const dryVwc = toInt16(Math.round(config.dry.vwcPercent * 10));
  const wetN = toInt16(config.wet.n);
  const wetVwc = toInt16(Math.round(config.wet.vwcPercent * 10));
  return (dryN ^ dryVwc ^ wetN ^ wetVwc) & 0xffff;
}

// Values as they must be written to the device (dumb providers just encode+write these, in this
// exact order, CONFIG_ID last — see WritePlantDrConfig.java order, docs/PARROT_BLE_DEEP_DIVE.md
// section 2). Checksum logic lives here only, never duplicated provider-side.
export interface PlantDrWriteValues {
  dryN: number;
  dryVwcRaw: number; // already *10, e.g. 17.5% -> 175
  wetN: number;
  wetVwcRaw: number;
  configId: number;
}

export function buildPlantDrWriteValues(config: PlantDrConfig): PlantDrWriteValues {
  return {
    dryN: config.dry.n,
    dryVwcRaw: Math.round(config.dry.vwcPercent * 10),
    wetN: config.wet.n,
    wetVwcRaw: Math.round(config.wet.vwcPercent * 10),
    configId: computePlantDrConfigId(config),
  };
}

export interface PlantDrCalibration {
  dryN: number;
  dryVwcPercent: number;
  wetN: number;
  wetVwcPercent: number;
  configId: number;
}

export interface PlantDrStatusFlags {
  isDrySoil: boolean;
  isWetSoil: boolean;
  isEmptyTank: boolean;
  isInAir: boolean;
}

// `HawaiiDevice.parsePlantDrStatusFlags()` (docs/PARROT_BLE_DEEP_DIVE.md section 4) — single byte,
// 4 significant bits, not mutually exclusive.
export function decodePlantDrStatusFlags(byte: number): PlantDrStatusFlags {
  return {
    isDrySoil: (byte & 0x01) !== 0,
    isWetSoil: (byte & 0x02) !== 0,
    isEmptyTank: (byte & 0x04) !== 0,
    isInAir: (byte & 0x08) !== 0,
  };
}
