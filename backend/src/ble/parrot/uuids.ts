// Source of truth: docs/PARROT_BLE_REVERSE_ENGINEERING.md + docs/PARROT_BLE_DEEP_DIVE.md (repo root).
// Custom Parrot base UUID: 39e1xxxx-84a8-11e2-afba-0002a5d5c51b.

// Real GATT service containing the watering characteristics (f901-f912) — also the UUID advertised
// in the advertisement to identify a Parrot Pot (as opposed to a plain Flower Power sensor).
export const WATERING_SERVICE_UUID = '39e1f900-84a8-11e2-afba-0002a5d5c51b';
// Real "Live" GATT service containing the sensor characteristics (fa06, fa09, fa0a, fa0b) —
// present on EVERY Parrot device (Pot or plain Flower Power), also the UUID advertised
// in the advertisement by a plain Flower Power that doesn't have the Watering service.
export const SENSOR_SERVICE_UUID = '39e1fa00-84a8-11e2-afba-0002a5d5c51b';

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
    // "Calibrated Ecb"/"Calibrated Ec porous" — two candidates for soil conductivity, never
    // documented before PARROT_OFFICIAL_BLE_SPEC.md (official Parrot spec). The decompiled official
    // Parrot Pot app never subscribes to them live (docs/STROYPLANT_SPEC.md section 8) — we read
    // them anyway to accumulate real data and empirically determine which one corresponds
    // to the WatchFlower CSV's "Soil conductivity" (the official spec itself doesn't settle it).
    // Neither one is used by the Health Engine yet until this is confirmed.
    soilConductivityEcb: '39e1fa0d-84a8-11e2-afba-0002a5d5c51b',
    soilConductivityEcPorous: '39e1fa0e-84a8-11e2-afba-0002a5d5c51b',
  },
  watering: {
    trigger: '39e1f906-84a8-11e2-afba-0002a5d5c51b', // write [0x08, 0x00] (uint16 LE), write-with-response
    waterTankLevel: '39e1f907-84a8-11e2-afba-0002a5d5c51b', // notify, uint8 %
  },
} as const;

export const WATER_TRIGGER_PAYLOAD = Buffer.from([0x08, 0x00]);

export const PARROT_POT_NAME_PREFIX = 'Parrot pot';
