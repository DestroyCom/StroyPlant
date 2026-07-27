// Source de vérité : PARROT_BLE_REVERSE_ENGINEERING.md + PARROT_BLE_DEEP_DIVE.md (racine du repo).
// Base UUID custom Parrot : 39e1xxxx-84a8-11e2-afba-0002a5d5c51b.

// Service GATT réel contenant les characteristics watering (f901-f912) — aussi l'UUID annoncé en
// advertisement pour identifier un Parrot Pot (par opposition à un simple capteur Flower Power).
export const WATERING_SERVICE_UUID = '39e1f900-84a8-11e2-afba-0002a5d5c51b';
// Service GATT réel "Live" contenant les characteristics de capteurs (fa06, fa09, fa0a, fa0b) —
// présent sur TOUT device Parrot (Pot ou simple Flower Power), c'est aussi l'UUID annoncé en
// advertisement par un simple Flower Power qui n'a pas le service Watering.
export const SENSOR_SERVICE_UUID = '39e1fa00-84a8-11e2-afba-0002a5d5c51b';

export const UUIDS = {
  live: {
    // UUID_LIVE_MEASURE_PERIOD — write 1 (uint8) avant de lire/souscrire fa09/0a/0b, sinon le
    // firmware ne rafraîchit pas ses valeurs (lectures figées silencieusement). Write 0 en fin de
    // session. Voir STROYPLANT_SPEC.md section 8.
    measurePeriod: '39e1fa06-84a8-11e2-afba-0002a5d5c51b',
    // Characteristics réellement utilisées par l'app officielle (PAS fa01-05, vestigiales) —
    // float32 LE, déjà calibrées par le firmware, aucune formule de conversion nécessaire.
    soilMoisturePercent: '39e1fa09-84a8-11e2-afba-0002a5d5c51b',
    temperatureC: '39e1fa0a-84a8-11e2-afba-0002a5d5c51b',
    luminosity: '39e1fa0b-84a8-11e2-afba-0002a5d5c51b',
  },
  watering: {
    trigger: '39e1f906-84a8-11e2-afba-0002a5d5c51b', // write [0x08, 0x00] (uint16 LE), write-with-response
    waterTankLevel: '39e1f907-84a8-11e2-afba-0002a5d5c51b', // notify, uint8 %
  },
} as const;

export const WATER_TRIGGER_PAYLOAD = Buffer.from([0x08, 0x00]);

export const PARROT_POT_NAME_PREFIX = 'Parrot pot';
