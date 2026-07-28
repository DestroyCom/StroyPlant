// Parrot manufacturer data in the advertisement — see docs/STROYPLANT_SPEC.md section 7.1 for the
// ongoing correlation protocol (not executed yet, requires physical access to the devices).
//
// Confirmed by a real capture on the the production server's 2 Parrot Pots (2026-07-28): Bluetooth SIG Company ID
// Parrot SA = 0x0043, 3-byte payload (NOT 1 as the official PDF's "flags" table initially
// suggested — that table is scoped to firmwares < 1.1, the Parrot Pot VE0.29.1 is probably not
// covered). Example observed: `01 23 03` / `01 23 23` — first 2 bytes identical between devices
// (probably a static firmware/hardware version identifier), 3rd byte variable (flags candidate,
// UNCONFIRMED).
//
// Deliberately NO bit-level interpretation here as long as the correlation protocol
// (STROYPLANT_SPEC.md section 7.1) hasn't produced a reproducible result — only return the
// raw payload, never force an unverified mapping.
export const PARROT_BLUETOOTH_SIG_COMPANY_ID = 0x0043;

export function extractParrotManufacturerPayload(manufacturerData: Record<string, unknown> | undefined): Buffer | undefined {
  if (!manufacturerData) return undefined;
  const raw = manufacturerData[String(PARROT_BLUETOOTH_SIG_COMPANY_ID)];
  if (raw == null) return undefined;
  return Buffer.from(raw as ArrayLike<number>);
}
