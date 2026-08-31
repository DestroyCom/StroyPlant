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
// Calibration service (Flower Power base, shared by the Parrot Pot) — only `fe01` (raw factory
// calibration blob, no known decode) and `fe04` (color) are read; confirmed dead-end for our
// purposes (docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-and-raw-sensor-
// log-design.md), logged raw for the debug table only.
export const CALIBRATION_SERVICE_UUID = '39e1fe00-84a8-11e2-afba-0002a5d5c51b';

export const UUIDS = {
  live: {
    // UUID_LIVE_MEASURE_PERIOD — write 1 (uint8) before reading/subscribing to fa09/0a/0b, otherwise
    // the firmware doesn't refresh its values (readings silently frozen). Write 0 at the end of the
    // session. See docs/STROYPLANT_SPEC.md section 8.
    measurePeriod: '39e1fa06-84a8-11e2-afba-0002a5d5c51b',
    // float32 LE, already calibrated by the firmware, no conversion formula needed.
    // Confirmed via real BLE sniffing of the official app on real hardware (2026-08-29,
    // docs/superpowers/specs/2026-08-29-parrot-official-app-ble-sniffing-findings.md) — fa07 rises
    // in real time during an actual watering, fa09 rises/falls in real time under a controlled
    // heat stimulus. Previously assumed fa09=moisture/fa0a=temperature (this project's own docs
    // and the transcribed official PDF both said so); both were wrong, swapped here after two
    // independent real-hardware confirmations. fa0b (luminosity) unchanged — not re-verified this
    // pass, fa0a itself is confirmed light-reactive (not luminosity's official slot) and unused.
    soilMoisturePercent: '39e1fa07-84a8-11e2-afba-0002a5d5c51b',
    temperatureC: '39e1fa09-84a8-11e2-afba-0002a5d5c51b',
    luminosity: '39e1fa0b-84a8-11e2-afba-0002a5d5c51b',
    // Soil conductivity (fertility index) — RAW characteristic, confirmed "Certain" in
    // docs/PARROT_BLE_REVERSE_ENGINEERING.md. This project originally tried the "calibrated"
    // fa0d/fa0e characteristics instead (see git history) — confirmed via real production logs
    // (2026-07-30) to simply not exist on real Parrot Pot firmware ("Characteristic not
    // available", 100% of polls, both real units). fa02 is what WatchFlower's own real Parrot Pot
    // driver reads (github.com/emericg/WatchFlower, device_parrotpot.cpp) — see
    // ble/parrot/soilConductivity.ts for the decode formula.
    soilConductivityRaw: '39e1fa02-84a8-11e2-afba-0002a5d5c51b',
    // Raw (uncalibrated) characteristics — vestigial per the official app (never subscribed to),
    // logged for the raw sensor debug table only (docs/superpowers/specs/2026-07-31-...).
    lightRaw: '39e1fa01-84a8-11e2-afba-0002a5d5c51b',
    soilTempRaw: '39e1fa03-84a8-11e2-afba-0002a5d5c51b',
    airTempRaw: '39e1fa04-84a8-11e2-afba-0002a5d5c51b',
    soilMoistureRaw: '39e1fa05-84a8-11e2-afba-0002a5d5c51b',
    // "Calibrated" Ea/Ecb/EcPorous — confirmed "Characteristic not available" on both real Parrot
    // Pots (docs/HEALTH_ENGINE.md). Still attempted every poll and logged raw (null expected).
    eaCal: '39e1fa0c-84a8-11e2-afba-0002a5d5c51b',
    ecbCal: '39e1fa0d-84a8-11e2-afba-0002a5d5c51b',
    ecPorousCal: '39e1fa0e-84a8-11e2-afba-0002a5d5c51b',
  },
  watering: {
    // KEPT AS f906 — see docs/superpowers/specs/2026-08-29-parrot-official-app-ble-sniffing-findings.md
    // for the full story. The official app's "ARROSAGE" button reproducibly writes [0x0a, 0x00] to
    // f90c (39e1f90c), confirmed 7+ times via real BLE sniffing — but writing the exact same bytes
    // to f90c from a bare standalone script (both via node-ble/BlueZ on the real production server
    // AND via @abandonware/noble/CoreBluetooth on the Mac, with the official app closed and
    // StroyPlant's own backend stopped to rule out any interference) gets an ATT-level write
    // acknowledgment but produces NO physical watering. f906 remains what StroyPlant actually uses
    // — a real, working mechanism for months of production waterings, despite its own GATT
    // declaration showing Read+Notify only (no Write bit) on real hardware. Leading hypothesis for
    // f90c's silent no-op: the device may require an actual BLE bond/pairing or an app-specific
    // authentication sequence before honoring this specific write, not verifiable with the tooling
    // available this session. Do not switch to f90c without resolving this first.
    trigger: '39e1f906-84a8-11e2-afba-0002a5d5c51b', // write [0x08, 0x00] (uint16 LE), write-with-response
    waterTankLevel: '39e1f907-84a8-11e2-afba-0002a5d5c51b', // notify, uint8 %
    // XOR-16 validation checksum over the other 12 watering-service characteristics, written LAST
    // — see computeWateringConfigId() (wateringConfig.ts) and
    // docs/superpowers/specs/2026-08-31-parrot-ble-full-capture-reanalysis.md. Confirmed from the
    // decompiled official app (docs/PARROT_BLE_DEEP_DIVE.md section 2,
    // `PlantConfig.getWateringConfigId()`), same pattern as `plantDr.configId` below.
    configId: '39e1f901-84a8-11e2-afba-0002a5d5c51b',
    plantId: '39e1f902-84a8-11e2-afba-0002a5d5c51b', // uint16, read-modify-write, meaning unconfirmed
    vwcIrr: '39e1f903-84a8-11e2-afba-0002a5d5c51b',
    vwcCmd: '39e1f904-84a8-11e2-afba-0002a5d5c51b',
    nIrr: '39e1f905-84a8-11e2-afba-0002a5d5c51b',
    pumpDutyCycle: '39e1f908-84a8-11e2-afba-0002a5d5c51b',
    vwcIrrEco: '39e1f90a-84a8-11e2-afba-0002a5d5c51b',
    vwcCmdEco: '39e1f90b-84a8-11e2-afba-0002a5d5c51b',
    // Confirmed via real BLE sniffing to be the official app's actual manual-watering write target
    // (write [0x0a, 0x00]) — but see the comment on `trigger` above: writing this from our own code
    // does NOT produce a real watering, unlike the app. Kept under its CSV-import name (nIrrEco)
    // since that's still its best-known role for our own read/log purposes; `trigger` stays f906.
    nIrrEco: '39e1f90c-84a8-11e2-afba-0002a5d5c51b',
    mode: '39e1f90d-84a8-11e2-afba-0002a5d5c51b',
    timeSlotStart: '39e1f90e-84a8-11e2-afba-0002a5d5c51b',
    timeSlotDurr: '39e1f90f-84a8-11e2-afba-0002a5d5c51b',
    vacationStart: '39e1f910-84a8-11e2-afba-0002a5d5c51b',
    vacationEnd: '39e1f911-84a8-11e2-afba-0002a5d5c51b',
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
    nextWateringDate: '39e1fd87-84a8-11e2-afba-0002a5d5c51b',
    nextEmptyTankDate: '39e1fd88-84a8-11e2-afba-0002a5d5c51b',
    fullTankAutonomy: '39e1fd89-84a8-11e2-afba-0002a5d5c51b',
  },
  calibration: {
    dataBlob: '39e1fe01-84a8-11e2-afba-0002a5d5c51b',
    color: '39e1fe04-84a8-11e2-afba-0002a5d5c51b',
  },
} as const;

export const WATER_TRIGGER_PAYLOAD = Buffer.from([0x08, 0x00]);

export const PARROT_POT_NAME_PREFIX = 'Parrot pot';
