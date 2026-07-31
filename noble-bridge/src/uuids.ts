// Source of truth: docs/PARROT_BLE_REVERSE_ENGINEERING.md + docs/PARROT_BLE_DEEP_DIVE.md (repo root
// of StroyPlant). Duplicated from backend/src/ble/parrot/uuids.ts — this process is deployed
// independently (native macOS, outside Docker), no module sharing with the backend.

export const UUIDS = {
  live: {
    measurePeriod: '39e1fa06-84a8-11e2-afba-0002a5d5c51b',
    soilMoisturePercent: '39e1fa09-84a8-11e2-afba-0002a5d5c51b',
    temperatureC: '39e1fa0a-84a8-11e2-afba-0002a5d5c51b',
    luminosity: '39e1fa0b-84a8-11e2-afba-0002a5d5c51b',
    // Soil conductivity (fertility index) — RAW characteristic, same one WatchFlower's own Parrot
    // Pot driver reads (github.com/emericg/WatchFlower, device_parrotpot.cpp). parrot.ts only reads
    // and forwards this raw uint16 (no decode formula here anymore) — interpretation now happens at
    // read time in the backend, per device calibration (backend/src/health/
    // soilConductivityCalibration.ts, docs/superpowers/specs/2026-07-31-soil-conductivity-self-
    // calibration-and-raw-sensor-log-design.md).
    soilConductivityRaw: '39e1fa02-84a8-11e2-afba-0002a5d5c51b',
    lightRaw: '39e1fa01-84a8-11e2-afba-0002a5d5c51b',
    soilTempRaw: '39e1fa03-84a8-11e2-afba-0002a5d5c51b',
    airTempRaw: '39e1fa04-84a8-11e2-afba-0002a5d5c51b',
    soilMoistureRaw: '39e1fa05-84a8-11e2-afba-0002a5d5c51b',
  },
  watering: {
    trigger: '39e1f906-84a8-11e2-afba-0002a5d5c51b',
    waterTankLevel: '39e1f907-84a8-11e2-afba-0002a5d5c51b',
  },
  // Plant Dr service (Batch 6, docs/STROYPLANT_SPEC.md section 7.11).
  plantDr: {
    configId: '39e1fd81-84a8-11e2-afba-0002a5d5c51b',
    dryN: '39e1fd82-84a8-11e2-afba-0002a5d5c51b',
    dryVwc: '39e1fd83-84a8-11e2-afba-0002a5d5c51b',
    wetN: '39e1fd84-84a8-11e2-afba-0002a5d5c51b',
    wetVwc: '39e1fd85-84a8-11e2-afba-0002a5d5c51b',
    statusFlags: '39e1fd86-84a8-11e2-afba-0002a5d5c51b',
  },
} as const;

export const PLANT_DR_SERVICE_UUID = '39e1fd80-84a8-11e2-afba-0002a5d5c51b';
export const WATER_TRIGGER_PAYLOAD = Buffer.from([0x08, 0x00]);
export const PARROT_POT_NAME_PREFIX = 'Parrot pot';

// Xiaomi LYWSD03MMC — validated empirically over a real GATT connection (see
// backend/src/ble/xiaomi/uuids.ts for validation detail). NOT the passive advertisement (encrypted
// as MiBeacon on stock firmware).
export const XIAOMI_DATA_SERVICE_UUID = 'ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6';
export const XIAOMI_TEMP_HUMIDITY_CHARACTERISTIC_UUID = 'ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6';
export const LYWSD03MMC_NAME = 'LYWSD03MMC';
