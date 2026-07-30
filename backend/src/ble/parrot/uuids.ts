// Source of truth: docs/PARROT_BLE_REVERSE_ENGINEERING.md + docs/PARROT_BLE_DEEP_DIVE.md (repo root).
// Custom Parrot base UUID: 39e1xxxx-84a8-11e2-afba-0002a5d5c51b.

// Real GATT service containing the watering characteristics (f901-f912) — also the UUID advertised
// in the advertisement to identify a Parrot Pot (as opposed to a plain Flower Power sensor).
export const WATERING_SERVICE_UUID = '39e1f900-84a8-11e2-afba-0002a5d5c51b';
// Real "Live" GATT service containing the sensor characteristics (fa06, fa09, fa0a, fa0b) —
// present on EVERY Parrot device (Pot or plain Flower Power), also the UUID advertised
// in the advertisement by a plain Flower Power that doesn't have the Watering service.
export const SENSOR_SERVICE_UUID = '39e1fa00-84a8-11e2-afba-0002a5d5c51b';
// Plant Dr service (Batch 6, docs/STROYPLANT_SPEC.md section 7.11) — device-side dry/wet
// calibration algorithm, complementary safety net alongside the backend scheduler (Batch 5).
export const PLANT_DR_SERVICE_UUID = '39e1fd80-84a8-11e2-afba-0002a5d5c51b';

export const UUIDS = {
  live: {
    // UUID_LIVE_MEASURE_PERIOD — write 1 (uint8) before reading/subscribing to fa09/0a/0b, otherwise
    // the firmware doesn't refresh its values (readings silently frozen). Write 0 at the end of the
    // session. See docs/STROYPLANT_SPEC.md section 8.
    measurePeriod: '39e1fa06-84a8-11e2-afba-0002a5d5c51b',
    // Characteristics actually used by the official app (NOT fa01-05, vestigial) —
    // float32 LE, already calibrated by the firmware, no conversion formula needed.
    soilMoisturePercent: '39e1fa09-84a8-11e2-afba-0002a5d5c51b',
    temperatureC: '39e1fa0a-84a8-11e2-afba-0002a5d5c51b',
    luminosity: '39e1fa0b-84a8-11e2-afba-0002a5d5c51b',
    // Soil conductivity (fertility index) — RAW characteristic, confirmed "Certain" in
    // docs/PARROT_BLE_REVERSE_ENGINEERING.md. This project originally tried the "calibrated"
    // fa0d/fa0e characteristics instead (see git history) — confirmed via real production logs
    // (2026-07-30) to simply not exist on real Parrot Pot firmware ("Characteristic not
    // available", 100% of polls, both real units). fa02 is what WatchFlower's own real Parrot Pot
    // driver reads (github.com/emericg/WatchFlower, device_parrotpot.cpp) — see
    // ble/parrot/soilConductivity.ts for the decode formula.
    soilConductivityRaw: '39e1fa02-84a8-11e2-afba-0002a5d5c51b',
  },
  watering: {
    trigger: '39e1f906-84a8-11e2-afba-0002a5d5c51b', // write [0x08, 0x00] (uint16 LE), write-with-response
    waterTankLevel: '39e1f907-84a8-11e2-afba-0002a5d5c51b', // notify, uint8 %
    // Write uint8, client-side bounded 0-6. Only `0` (reset after maintenance) is confirmed by the
    // decompiled code — values 1-6 are accepted but their effect on the device is NOT confirmed
    // (docs/PARROT_BLE_DEEP_DIVE.md section 2). Do not assume any value "enables" the algorithm
    // without empirical validation on real hardware first (Batch 6).
    algorithmStatus: '39e1f912-84a8-11e2-afba-0002a5d5c51b',
  },
  plantDr: {
    // Read-modify-write, written LAST — XOR validation checksum, see computePlantDrConfigId().
    configId: '39e1fd81-84a8-11e2-afba-0002a5d5c51b',
    // "Dry" calibration point. Write order: dryN -> dryVwc -> wetN -> wetVwc -> configId.
    dryN: '39e1fd82-84a8-11e2-afba-0002a5d5c51b',
    dryVwc: '39e1fd83-84a8-11e2-afba-0002a5d5c51b',
    // "Wet" calibration point.
    wetN: '39e1fd84-84a8-11e2-afba-0002a5d5c51b',
    wetVwc: '39e1fd85-84a8-11e2-afba-0002a5d5c51b',
    // Notify, single byte, 4 significant bits — see decodePlantDrStatusFlags().
    statusFlags: '39e1fd86-84a8-11e2-afba-0002a5d5c51b',
  },
} as const;

export const WATER_TRIGGER_PAYLOAD = Buffer.from([0x08, 0x00]);

export const PARROT_POT_NAME_PREFIX = 'Parrot pot';
