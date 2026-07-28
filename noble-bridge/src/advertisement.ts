// Duplicated from backend/src/ble/parrot/advertisement.ts (independently deployed process, no
// module sharing with the backend — same convention as uuids.ts).
//
// Confirmed by real capture on the production server's 2 Parrot Pots (2026-07-28): Bluetooth SIG Company ID
// Parrot SA = 0x0043, 3-byte payload (NOT 1 as initially suggested by the "flags" table in the
// official PDF, scoped to firmwares < 1.1). See docs/STROYPLANT_SPEC.md section 7.1 for the
// detail and the ongoing correlation protocol (not yet executed).
//
// Deliberately NOT bit-interpreting here — only return the raw payload.
export const PARROT_BLUETOOTH_SIG_COMPANY_ID = 0x0043;

// noble exposes `manufacturerData` as a RAW Buffer including the Company ID up front (2 bytes LE),
// unlike BlueZ/node-ble which already extracts it as a dict key (see the node-ble provider on the
// backend side) — two different conventions depending on the library, each verified separately in
// their respective sources, not assumed identical.
export function extractParrotManufacturerPayload(manufacturerData: Buffer | undefined): Buffer | undefined {
  if (!manufacturerData || manufacturerData.length < 2) return undefined;
  const companyId = manufacturerData.readUInt16LE(0);
  if (companyId !== PARROT_BLUETOOTH_SIG_COMPANY_ID) return undefined;
  return manufacturerData.subarray(2);
}
