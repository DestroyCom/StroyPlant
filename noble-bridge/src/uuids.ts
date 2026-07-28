// Source of truth: docs/PARROT_BLE_REVERSE_ENGINEERING.md + docs/PARROT_BLE_DEEP_DIVE.md (repo root
// of StroyPlant). Duplicated from backend/src/ble/parrot/uuids.ts — this process is deployed
// independently (native macOS, outside Docker), no module sharing with the backend.

export const UUIDS = {
  live: {
    measurePeriod: '39e1fa06-84a8-11e2-afba-0002a5d5c51b',
    soilMoisturePercent: '39e1fa09-84a8-11e2-afba-0002a5d5c51b',
    temperatureC: '39e1fa0a-84a8-11e2-afba-0002a5d5c51b',
    luminosity: '39e1fa0b-84a8-11e2-afba-0002a5d5c51b',
    // "Soil conductivity" candidates (docs/STROYPLANT_SPEC.md section 8) — never used by the
    // official Parrot Pot app, read best-effort to determine empirically which one corresponds
    // to the "Soil conductivity" CSV column.
    soilConductivityEcb: '39e1fa0d-84a8-11e2-afba-0002a5d5c51b',
    soilConductivityEcPorous: '39e1fa0e-84a8-11e2-afba-0002a5d5c51b',
  },
  watering: {
    trigger: '39e1f906-84a8-11e2-afba-0002a5d5c51b',
    waterTankLevel: '39e1f907-84a8-11e2-afba-0002a5d5c51b',
  },
} as const;

export const WATER_TRIGGER_PAYLOAD = Buffer.from([0x08, 0x00]);
export const PARROT_POT_NAME_PREFIX = 'Parrot pot';

// Xiaomi LYWSD03MMC — validated empirically over a real GATT connection (see
// backend/src/ble/xiaomi/uuids.ts for validation detail). NOT the passive advertisement (encrypted
// as MiBeacon on stock firmware).
export const XIAOMI_DATA_SERVICE_UUID = 'ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6';
export const XIAOMI_TEMP_HUMIDITY_CHARACTERISTIC_UUID = 'ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6';
export const LYWSD03MMC_NAME = 'LYWSD03MMC';
