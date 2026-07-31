// Soil conductivity ("fertility index" on WatchFlower/the official app) — decoded from the RAW
// `39e1fa02` characteristic (uint16 LE), NOT from the "calibrated" `39e1fa0d`/`0e` characteristics
// this project originally tried (confirmed unavailable on real hardware, see
// docs/HEALTH_ENGINE.md).
//
// The clamp+inverted-map formula below is WatchFlower's own (github.com/emericg/WatchFlower,
// device_parrotpot.cpp) — empirically tuned against their own hardware, NOT validated against
// ours (real Parrot Pots read raw=775/983, both far outside WatchFlower's assumed [1500,2036]
// window, permanently pegging the old fixed-constant version of this formula at the top of the
// output scale). Cross-checked against 16 community repos + the 3 official Parrot-Developers org
// repos (2026-07-31): no alternative formula found anywhere is validated either — even WatchFlower's
// own app compares this same [0,1000]-clamped value directly against its own CSV's real µS/cm
// thresholds with no unit conversion (qml/DeviceWidget.qml, UtilsNumber.normalize) — an apparent
// scale question baked into the reference implementation itself.
//
// Since 2026-07-31 (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-and-raw-
// sensor-log-design.md), this formula's bounds are no longer WatchFlower's fixed global constants —
// they're derived per-device from real accumulated history (see
// health/soilConductivityCalibration.ts). This file only keeps the pure math, parameterized.

export interface ConductivityCalibrationBounds {
  rawMin: number; // maps to the top of the output range (most conductive observed for this device)
  rawMax: number; // maps to 0 (no soil / driest observed for this device)
}

const OUTPUT_MAX = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Extracts the raw uint16 ADC-ish value from the characteristic payload — this is what gets
// persisted (RawSensorLog.soilConductivityRaw), never the mapped output.
export function readSoilConductivityRawValue(buf: Buffer): number {
  return buf.readUInt16LE(0);
}

// Same output scale WatchFlower stores directly against its own CSV's "Soil conductivity" column
// (μS/cm) — no further unit conversion applied here, matching WatchFlower's own comparison
// (unit-scale caveat documented above). Inverted: a higher raw ADC reading means LESS conductive
// soil.
export function decodeSoilConductivityRaw(raw: number, bounds: ConductivityCalibrationBounds): number {
  const clamped = clamp(raw, bounds.rawMin, bounds.rawMax);
  return ((bounds.rawMax - clamped) / (bounds.rawMax - bounds.rawMin)) * OUTPUT_MAX;
}
