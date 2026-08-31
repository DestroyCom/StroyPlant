// Device-side autonomous watering config (f900 service), Batch "device-side autonomous
// watering". See docs/superpowers/specs/2026-08-30-parrot-device-side-autonomous-watering-
// design.md and docs/superpowers/specs/2026-08-31-parrot-ble-full-capture-reanalysis.md.
//
// CORRECTED 2026-08-31 — the original comment here ("no checksum/commit field is involved") was
// wrong. `docs/PARROT_BLE_DEEP_DIVE.md` section 2 already documented, from the decompiled official
// app (`PlantConfig.getWateringConfigId()`, `entities/PlantConfig.java:55-57`), that `f901`
// (CONFIG_ID) is an **XOR-16 validation checksum** over the other 12 characteristics, written
// LAST — the same pattern already implemented and hardware-validated for the Plant Dr service
// (`plantDr.ts`'s `computePlantDrConfigId`), just never wired up here. Independently re-derived
// and verified twice this session against real PacketLogger captures (9/9 real config batches
// across 2 separate re-analyses, including this project's own 3 vectors below — zero mismatches).
// This is very likely the root cause of the persistence mystery documented in
// [[project_autonomous_watering_f903_f904_revert]]: a write that never recomputes/writes a
// correct CONFIG_ID leaves the device's own validation inconsistent, so the firmware silently
// keeps the last config it did accept.

// All 12 non-checksum characteristics of the f900 "Watering" service, in the exact order the
// official app writes them (`WriteWateringConfig.java:82-94`) — CONFIG_ID (f901) is computed from
// these and always written last, never part of this struct itself.
export interface WateringConfigFields {
  plantId: number; // f902, uint16 — read-modify-write like every other field here, meaning unconfirmed
  vwcIrrRaw: number; // f903, uint16, already ×10 — trigger threshold
  vwcCmdRaw: number; // f904, uint16, already ×10 — target/consigne
  nIrr: number; // f905, uint16 — anti-repeat delay, same value as PlantProfile.irrigateCalibrationSampleCount
  vwcIrrEcoRaw: number; // f90a, uint16, already ×10 — eco-mode trigger threshold, always 0 in every capture so far
  vwcCmdEcoRaw: number; // f90b, uint16, already ×10 — eco-mode target, always 0 so far
  nIrrEco: number; // f90c, uint16 — eco-mode delay, always 0 so far
  timeSlotStart: number; // f90e, uint16 — minutes, role not fully confirmed
  timeSlotDuration: number; // f90f, uint16 — minutes, role not fully confirmed
  vacationStart: number; // f910, uint32 — always 0 so far
  vacationEnd: number; // f911, uint32 — always 0 so far
  mode: number; // f90d, uint8 — 0=off/manual, 1=auto (2="vacation" per homebridge-parrot-flower, never observed)
}

export interface WateringConfigWriteValues extends WateringConfigFields {
  configId: number; // f901, computed by computeWateringConfigId(), written last
}

// Live-read shape, all 13 characteristics of the f900 service. `algorithmEnabled` is `mode === 1`
// decoded as a boolean, kept for the existing call sites that only care about on/off.
export interface WateringConfigRaw extends WateringConfigFields {
  algorithmEnabled: boolean;
  configId: number;
}

function toInt16(value: number): number {
  return (value << 16) >> 16;
}

// `PlantConfig.getWateringConfigId()` (`docs/PARROT_BLE_DEEP_DIVE.md` section 2,
// `entities/PlantConfig.java:55-57`) — XOR of all 12 fields, each truncated to int16; the two
// uint32 fields (vacationStart/vacationEnd) are split into low/high 16-bit halves first. XOR is
// associative/commutative so field order here doesn't matter mathematically, only for the write
// order on the wire (see CFG_WRITE_ORDER below).
//
// Verified against 9 real captured config batches across 2 independent re-analyses of
// docs/ble-captures/ (perfect_drop, plant_sitter, manuel, custom, live, workout, plus 3 more from
// 15_full_sniff_30_aout_soir.pklg sessions #8/#31×2) — 9/9 exact matches, zero exceptions. See
// wateringConfig.test.ts for the vectors.
export function computeWateringConfigId(fields: WateringConfigFields): number {
  const vacStartLow = fields.vacationStart & 0xffff;
  const vacStartHigh = (fields.vacationStart >>> 16) & 0xffff;
  const vacEndLow = fields.vacationEnd & 0xffff;
  const vacEndHigh = (fields.vacationEnd >>> 16) & 0xffff;
  return (
    (toInt16(fields.plantId) ^
      toInt16(fields.vwcIrrRaw) ^
      toInt16(fields.vwcCmdRaw) ^
      toInt16(fields.nIrr) ^
      toInt16(fields.vwcIrrEcoRaw) ^
      toInt16(fields.vwcCmdEcoRaw) ^
      toInt16(fields.nIrrEco) ^
      toInt16(fields.timeSlotStart) ^
      toInt16(fields.timeSlotDuration) ^
      toInt16(vacStartLow) ^
      toInt16(vacStartHigh) ^
      toInt16(vacEndLow) ^
      toInt16(vacEndHigh) ^
      toInt16(fields.mode)) &
    0xffff
  );
}

export function buildWateringConfigWriteValues(fields: WateringConfigFields): WateringConfigWriteValues {
  return { ...fields, configId: computeWateringConfigId(fields) };
}

// Read-modify-write (`docs/PARROT_BLE_DEEP_DIVE.md` section 2: the official app always reads the
// device's current config first, only changes the fields a given action actually concerns, then
// rewrites all 12 + CONFIG_ID) — merges the given overrides onto whatever's currently on the
// device rather than guessing/zeroing fields this project doesn't independently control
// (plantId, eco thresholds, time slot, vacation window).
export function mergeWateringConfigOverrides(
  current: WateringConfigFields,
  overrides: Partial<WateringConfigFields>,
): WateringConfigFields {
  return { ...current, ...overrides };
}

export function buildWateringConfigEnableFields(
  vwcIrrPercent: number,
  vwcCmdPercent: number,
  nIrr: number,
): Pick<WateringConfigFields, 'vwcIrrRaw' | 'vwcCmdRaw' | 'nIrr' | 'mode'> {
  return {
    vwcIrrRaw: Math.round(vwcIrrPercent * 10),
    vwcCmdRaw: Math.round(vwcCmdPercent * 10),
    nIrr,
    mode: 1,
  };
}
