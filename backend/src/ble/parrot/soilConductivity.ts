// Soil conductivity ("fertility index" on WatchFlower/the official app) — decoded from the RAW
// `39e1fa02` characteristic (uint16 LE), NOT from the "calibrated" `39e1fa0d`/`0e` characteristics
// this project originally tried (docs/PARROT_OFFICIAL_BLE_SPEC.md's own "new, unconfirmed"
// candidates). Confirmed via real production logs (2026-07-30): `39e1fa0d`/`0e` are unreadable
// ("Characteristic not available") on both real Parrot Pots — they simply don't exist on this
// firmware. `39e1fa02` is the one the reverse-engineering doc marks "Certain", and turns out to be
// exactly what WatchFlower's own real Parrot Pot driver reads
// (github.com/emericg/WatchFlower, src/devices/device_parrotpot.cpp,
// `serviceDetailsDiscovered_live()`), with the linear mapping below — empirically tuned by that
// project against real hardware ("no soil: 2036", "max observed: 1747"), not guessed by us.
const RAW_MIN = 1500; // maps to the top of the output range (most conductive observed)
const RAW_MAX = 2036; // maps to 0 (no soil / driest observed)
const OUTPUT_MAX = 1000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

// Same output scale WatchFlower stores directly against its own CSV's "Soil conductivity" column
// (μS/cm) — no further unit conversion needed to compare against PlantProfile.soilConductivityMin/
// MaxUsCm.
export function decodeSoilConductivityRaw(buf: Buffer): number {
  const raw = clamp(buf.readUInt16LE(0), RAW_MIN, RAW_MAX);
  // Inverted: a higher raw ADC reading means LESS conductive soil.
  return ((RAW_MAX - raw) / (RAW_MAX - RAW_MIN)) * OUTPUT_MAX;
}
