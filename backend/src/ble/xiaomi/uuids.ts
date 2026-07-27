// Validé empiriquement en connexion GATT réelle contre un LYWSD03MMC (2026-07-27, voir session) —
// mêmes UUID que ceux documentés par WatchFlower (docs/lywsd03mmc-ble-api.md +
// src/devices/device_hygrotemp_square.cpp). Ce n'est PAS l'annonce passive (chiffrée en MiBeacon
// sur firmware stock, voir docs/STROYPLANT_SPEC.md section 3 — hypothèse initiale invalidée) : il faut
// se connecter en GATT, comme pour le Parrot Pot, et souscrire aux notifications.
export const DATA_SERVICE_UUID = 'ebe0ccb0-7a0a-4b0c-8a1a-6ff2997da3a6';
export const TEMP_HUMIDITY_CHARACTERISTIC_UUID = 'ebe0ccc1-7a0a-4b0c-8a1a-6ff2997da3a6';

export const LYWSD03MMC_NAME = 'LYWSD03MMC';
