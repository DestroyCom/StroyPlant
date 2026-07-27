// Source de vérité : PARROT_BLE_REVERSE_ENGINEERING.md + PARROT_BLE_DEEP_DIVE.md (racine du repo
// StroyPlant). Dupliqué depuis backend/src/ble/parrot/uuids.ts — ce process est déployé
// indépendamment (natif macOS, hors Docker), pas de partage de module avec le backend.

export const UUIDS = {
  live: {
    measurePeriod: '39e1fa06-84a8-11e2-afba-0002a5d5c51b',
    soilMoisturePercent: '39e1fa09-84a8-11e2-afba-0002a5d5c51b',
    temperatureC: '39e1fa0a-84a8-11e2-afba-0002a5d5c51b',
    luminosity: '39e1fa0b-84a8-11e2-afba-0002a5d5c51b',
  },
  watering: {
    trigger: '39e1f906-84a8-11e2-afba-0002a5d5c51b',
    waterTankLevel: '39e1f907-84a8-11e2-afba-0002a5d5c51b',
  },
} as const;

export const WATER_TRIGGER_PAYLOAD = Buffer.from([0x08, 0x00]);
export const PARROT_POT_NAME_PREFIX = 'Parrot pot';
