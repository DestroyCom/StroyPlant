// Validated empirically over a real GATT connection against a LYWSD03MMC (2026-07-27, see session) —
// same UUIDs as those documented by WatchFlower (docs/lywsd03mmc-ble-api.md +
// src/devices/device_hygrotemp_square.cpp). This is NOT the passive advertisement (encrypted as
// MiBeacon on stock firmware, see docs/STROYPLANT_SPEC.md section 3 — initial assumption invalidated):
// you have to connect via GATT, like the Parrot Pot, and subscribe to notifications.
export const DATA_SERVICE_UUID = 'ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6';
export const TEMP_HUMIDITY_CHARACTERISTIC_UUID = 'ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6';

export const LYWSD03MMC_NAME = 'LYWSD03MMC';
