// Device-side autonomous watering config (f900 service), Batch "device-side autonomous
// watering". See docs/superpowers/specs/2026-08-30-parrot-device-side-autonomous-watering-
// design.md. Unlike Plant Dr's fd8x block, no checksum/commit field is involved here — each
// characteristic in f900 is independently writable, confirmed by the sniffing captures showing
// no composite validation value anywhere in that service.

// Values as they must be written to the device — providers stay "dumb", they just encode+write
// these in the required order (see writeWateringConfig in each provider), f908 written last.
export interface WateringConfigEnableValues {
  vwcIrrRaw: number; // already ×10, e.g. 32.0% -> 320 (f903, trigger threshold)
  vwcCmdRaw: number; // already ×10 (f904, target/consigne)
  nIrr: number; // raw 15-minute units, written as-is (f905, anti-repeat delay) — this is the same
  // value stored in PlantProfile.irrigateCalibrationSampleCount, misnamed at Parrot-plant-database
  // import time: real sniffing (2026-08-29) showed it's a delay preset (e.g. 384 = 4 days), not a
  // calibration sample count.
}

export type WateringConfigWrite = { mode: 'enable'; values: WateringConfigEnableValues } | { mode: 'disable' };

// Live-read shape (f903/f904/f905/f908), returned by readWateringConfig. `algorithmEnabled` is
// f908 decoded as a boolean (1 -> true, 0 -> false).
export interface WateringConfigRaw {
  vwcIrrRaw: number | null;
  vwcCmdRaw: number | null;
  nIrr: number | null;
  algorithmEnabled: boolean | null;
}

export function buildWateringConfigEnableValues(vwcIrrPercent: number, vwcCmdPercent: number, nIrr: number): WateringConfigEnableValues {
  return {
    vwcIrrRaw: Math.round(vwcIrrPercent * 10),
    vwcCmdRaw: Math.round(vwcCmdPercent * 10),
    nIrr,
  };
}
