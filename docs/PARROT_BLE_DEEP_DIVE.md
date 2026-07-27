# Analyse approfondie — History/Upload, séquences de config, formules capteurs

Complément à `PARROT_BLE_REVERSE_ENGINEERING.md`, couvrant les 5 points de la liste de priorités du
2026-07-27 (bloquants pour les Lots 2, 6, 7, et deux points bonus non bloquants).

---

## 1. Protocole History/Upload — verdict : **le format binaire d'un échantillon n'est PAS décodé côté app**

### Ce qui est bien géré localement : le transport (framing + handshake)

Séquence complète, `DownloadHistory.java` :

1. **Lecture de contexte** (obligatoire avant tout téléchargement) : `START_TIME`, `CURRENT_SESSION_START_INDEX`,
   puis `CURRENT_SESSION_ID`, `CURRENT_SESSION_PERIOD`, `NB_ENTRIES`, `LAST_ENTRY_INDEX` (service History
   `39e1FC00-...`). Calcul de l'index de départ :
   `startIndex = (lastEntryIndex - nbEntries) + 1`, ajusté par rapport au dernier index déjà connu côté
   "serveur" (`serverSessionStartIndex`, stocké en DB locale via `current_history_index`).
2. **Démarrage du transfert** (`startDownloadHistory`, ligne 242) :
   ```java
   taskHandler.setCharacteristic(HawaiiUUID.HISTORY_SERVICE_UUID, HawaiiUUID.UUID_TRANSFER_START_INDEX_VALUE,
       ByteData.uInt32ToByteArray(startIndex));           // 39e1FC03, uint32 LE
   taskHandler.setCharacteristicNotification(HawaiiUUID.UPLOAD_SERVICE_UUID, HawaiiUUID.UUID_TX_BUFFER, true);   // 39e1FB01
   taskHandler.setCharacteristicNotification(HawaiiUUID.UPLOAD_SERVICE_UUID, HawaiiUUID.UUID_TX_STATUS_VALUE, true); // 39e1FB02
   setRxStatus(RxStatus.RX_STATUS_RECEIVING, taskHandler);  // write 39e1FB03 = 0x01 (ordinal de l'enum)
   ```
3. **Réception des frames** (`onCharacteristicDataReceived`) : chaque notification sur `UUID_TX_BUFFER`
   (`39e1FB01`) est ajoutée au buffer (`HistoryBuffer.addToBuffer`). Format de frame :
   - `uint16 LE` (2 premiers octets) = **index de la frame**.
   - Si `frameIndex == 0` : les 4 octets suivants (`uint32 LE`, offset 2) = **taille totale du fichier
     d'historique en octets** (`mHistoryFileSize`). Cette frame 0 est une frame d'en-tête, pas de données.
   - Sinon : le reste de la frame (`value[2:]`) est un morceau brut du buffer d'historique, stocké dans une
     `SparseArray<byte[]>` indexée par `frameIndex`.
   - `HistoryBuffer.getByteArray()` concatène les frames dans l'ordre `1, 2, 3, ...` jusqu'à atteindre
     `mHistoryFileSize` octets (tronque le dernier fragment si besoin).
4. **Handshake de statut** sur `UUID_TX_STATUS_VALUE` (`39e1FB02`, notify, un seul octet = index dans l'enum
   `TxStatus` : `IDLE=0`, `TRANSFERRING=1`, `WAITING_ACK=2`) :
   - `TX_STATUS_TRANSFERRING` : rien à faire, en cours de réception.
   - `TX_STATUS_WAITING_ACK` : l'app doit vérifier l'intégrité du buffer reçu jusqu'ici
     (`HistoryBuffer.checkBuffer()` = aucune frame manquante dans la séquence) puis écrire sur
     `UUID_RX_STATUS_VALUE` (`39e1FB03`) soit `RX_STATUS_ACK` (`0x02`) soit `RX_STATUS_NACK` (`0x03`)
     (valeurs = ordinal de l'enum `RxStatus { STANDBY, RECEIVING, ACK, NACK, CANCEL, ERROR }`).
   - `TX_STATUS_IDLE` : transfert terminé, le device est revenu au repos → fin du téléchargement.
5. **Fin** : vérification `historyData.length == historyBuffer.getFileSize()`, sauvegarde en DB locale
   (`DatabaseManager.saveSampleHistory`), incrément de `current_history_index` pour la prochaine session.

Ce protocole (frame 0 = header avec taille totale, frames suivantes = `[uint16 index][payload]`, ack/nack
sur characteristic séparée) **est entièrement reproductible en Node.js/TypeScript** — c'est un protocole de
transfert de fichier générique par-dessus BLE, indépendant du contenu.

### Ce qui n'est PAS géré localement : le format d'un échantillon individuel

Le buffer réassemblé (`historyData`, un `byte[]` brut) n'est **jamais désérialisé en objets structurés côté
app**. Preuve directe — `DatabaseManager.saveSampleHistory()` :

```java
// SensorsDB/DatabaseManager.java:636-656
historyCV.put(SensorsDBHelper.COLUMN_SAMPLE, Base64.encodeToString(historyData, 0));
// ... juste stocké en base64 tel quel dans SQLite (table_samples), aucun parsing de champs individuels
```

Et surtout — **l'app envoie ce blob brut, encore en base64, directement au cloud Parrot pour qu'il le
décode côté serveur** :

```java
// SyncService.java:1216 — construction de la requête d'upload
jsonUpload.put("buffer_base64", this.mSample.sample);   // le blob base64 brut, non interprété
// ...
// SyncService.java:1233
WebServicesManagerThread.uploadSamples(accessToken, uploads, sessions, userConfigVersion, ...);
// → POST vers Constants.API_URL + "sensor_data/v8/sample"  (WebServicesManagerThread.java:81)
```

**Conclusion : le firmware du Parrot Pot encode ses échantillons historisés dans un format binaire dont la
structure (nombre de champs, ordre, taille, encodage) n'est décrite nulle part dans le code Android.**
C'est l'API cloud Parrot (`sensor_data/v8/sample`) qui sait interpréter `buffer_base64` — logique
propriétaire côté serveur, invisible depuis l'APK. Aucune classe cliente ne fait ce travail (pas de
"parser" local, pas de mode offline qui afficherait l'historique sans compte cloud).

**Impact concret sur le Lot 2** : le format ne peut pas être obtenu par cette voie de rétro-ingénierie
statique. Deux options restent ouvertes :

- **Capture BLE réelle** (nRF Connect / HCI snoop) pendant une synchro avec l'app officielle, puis comparer
  le buffer capturé aux valeurs affichées dans l'app à ce moment précis (température, VWC, etc. du moment)
  pour déduire empiriquement l'agencement des champs — probablement des enregistrements de taille fixe
  répétés (le fait que `mHistoryFileSize` soit un multiple prévisible et que `NB_ENTRIES`/`LAST_ENTRY_INDEX`
  soient des compteurs d'entrées le suggère fortement), mais la taille et l'ordre exacts des champs restent
  à déterminer empiriquement.
- **Contourner l'historique** : si le besoin réel du Lot 2 est juste d'avoir des séries temporelles, on peut
  ignorer le service History/Upload et **polling périodique des characteristics Live** (`39e1fa09/0a/0b`,
  voir section 3) pour reconstituer un historique côté bridge — on perd la rétro-compatibilité (pas de
  données pendant les périodes de déconnexion), mais ça évite un protocole non documenté.

---

## 2. Séquences d'écriture de configuration

### `WriteWateringConfig` — ordre exact des écritures (`WriteWateringConfig.java:82-94`)

```
1.  UUID_WATERING_PLANT_ID          (39e1F902)  uint16 LE
2.  UUID_WATERING_VWC_IRR           (39e1F903)  uint16 LE = round(vwc_irr     * 10)
3.  UUID_WATERING_VWC_CMD           (39e1F904)  uint16 LE = round(vwc_cmd     * 10)
4.  UUID_WATERING_N_IRR             (39e1F905)  uint16 LE
5.  UUID_WATERING_VWC_IRR_ECO       (39e1F90A)  uint16 LE = round(vwc_irr_eco * 10)
6.  UUID_WATERING_VWC_CMD_ECO       (39e1F90B)  uint16 LE = round(vwc_cmd_eco * 10)
7.  UUID_WATERING_N_IRR_ECO         (39e1F90C)  uint16 LE
8.  UUID_WATERING_TIME_SLOT_START   (39e1F90E)  uint16 LE
9.  UUID_WATERING_TIME_SLOT_DURATION(39e1F90F)  uint16 LE
10. UUID_WATERING_VACATION_START    (39e1F910)  uint32 LE
11. UUID_WATERING_VACATION_END      (39e1F911)  uint32 LE
12. UUID_WATERING_MODE              (39e1F90D)  uint8
13. UUID_WATERING_CONFIG_ID         (39e1F901)  uint16 LE  ← écrit EN DERNIER, c'est le "commit"
```

**Important** : avant d'écrire, l'app **lit d'abord la config actuelle du device** (`handler.getWateringConfig(...)`
pour VWC*IRR, VWC_CMD, N_IRR, \*\_ECO, TIME_SLOT*\_, VACATION\_\_) dans un objet `PlantConfig`, puis modifie
seulement les champs concernés par le nouveau `user_watering_mode` (0=off, 1/3=vwc perso, 2=éco) avant de
tout réécrire. **C'est un pattern read-modify-write, pas un write-only** — un bridge qui voudrait juste
changer un seul paramètre (ex. le mode) devrait faire pareil : lire l'état actuel de toutes les
characteristics du service Watering, ne modifier que ce qui change, puis réécrire les 13 characteristics
dans cet ordre en terminant par `CONFIG_ID`.

### La characteristic `CONFIG_ID` n'est pas un simple identifiant — c'est un **checksum XOR de validation**

Découverte clé dans `PlantConfig.getWateringConfigId()` (`entities/PlantConfig.java:55-57`) — l'expression
Java, très imbriquée, est en réalité un simple **XOR de tous les champs de la config**, chacun tronqué en
16 bits (XOR étant associatif/commutatif, l'ordre d'écriture dans le code n'a pas d'importance
mathématique) :

```
watering_config_id (uint16) =
    (int16) plant_id
  ^ (int16) round(vwc_irr * 10)
  ^ (int16) round(vwc_cmd * 10)
  ^ (int16) n_irr
  ^ (int16) round(vwc_irr_eco * 10)
  ^ (int16) round(vwc_cmd_eco * 10)
  ^ (int16) n_irr_eco
  ^ (int16) watering_time_slot_start
  ^ (int16) watering_time_slot_duration
  ^ (int16) (watering_vacation_start & 0xFFFF)         // moitié basse du uint32
  ^ (int16) (watering_vacation_start >>> 16)           // moitié haute du uint32
  ^ (int16) (watering_vacation_end   & 0xFFFF)
  ^ (int16) (watering_vacation_end   >>> 16)
  ^ (int16) watering_mode
```

C'est très probablement une **checksum de validation firmware** : le device doit reconnaître la même valeur
XOR calculée à partir des characteristics qu'il vient de recevoir avant d'appliquer la config (sinon il la
rejette silencieusement, ou considère l'écriture "en cours" comme non commit). **Un bridge doit recalculer
et écrire cette valeur exacte après avoir écrit les 12 autres characteristics**, avec la même troncature
int16 et le même découpage low/high 16 bits pour les deux timestamps 32 bits.

### `WritePlantDrConfig` — même pattern, formule plus simple

Ordre (`WritePlantDrConfig.java:31-35`) : `DRY_N` (39e1FD82) → `DRY_VWC` (39e1FD83) → `WET_N` (39e1FD84) →
`WET_VWC` (39e1FD85) → **`CONFIG_ID`** (39e1FD81, écrit en dernier).

Formule du checksum (`PlantConfig.getPDConfigId()`, `entities/PlantConfig.java:60-62`) :

```
pd_config_id (uint16) = (int16) dryN ^ (int16) round(dryVwc * 10) ^ (int16) wetN ^ (int16) round(wetVwc * 10)
```

### `SetWateringAlgorithmStatus` (write `39e1F912` = `UUID_WATERING_ALGORITHM_STATUS`)

Payload : **1 octet** (`ByteData.uInt8ToByteArray(value)`), valeur bornée côté app entre **0 et 6 inclus**
(`BleService.java:778` : `value < 0 || 6 < value` → refus côté client). Seule valeur réellement observée
dans le code UI (`PlantDetailsMaintenanceController.java`, méthode `reInitWatering()`) : **`0` = réinitialiser
l'algorithme d'auto-arrosage** (utilisé après une "maintenance" — vidange/nettoyage du bac). Les valeurs
1 à 6 sont acceptées par la validation côté client mais **aucun appelant dans le code lu n'écrit autre chose
que 0** — leur signification exacte (probablement des bits de statut similaires à ceux lus en notification
sur la même characteristic) reste à confirmer, soit en creusant plus, soit par sniffing.

---

## 3. Formules de conversion des capteurs — verdict : **pas de formule côté app, le firmware envoie déjà les valeurs physiques**

Résultat inattendu mais très net : les trois characteristics utilisées par le "mode live" de l'app
(`BleTaskHandler.startLive()`) ne sont **pas** les characteristics "brutes" `39e1fa01` à `39e1fa05`, mais
trois characteristics **différentes**, déjà en unités physiques :

```java
// Tasks/BleTaskHandler.java:616-625 — parsing des characteristics live
case LIVE_VMC_VALUE:          // 39e1fa09
    this.mDevice.setCurrent_vmc_value(ByteData.getFloat(byteArray));
case LIVE_LIGHT_VALUE:        // 39e1fa0b
    this.mDevice.setCurrent_light_value(ByteData.getFloat(byteArray));
case LIVE_TEMPERATURE_VALUE:  // 39e1fa0a
    this.mDevice.setCurrent_temperature_value(ByteData.getFloat(byteArray));
```

`ByteData.getFloat()` (`Utils/ByteData.java:12-16`) :

```java
public static float getFloat(byte[] byteArray) {
    return ByteBuffer.wrap(byteArray).order(ByteOrder.LITTLE_ENDIAN).getFloat(0);
}
```

→ **IEEE 754 float 32 bits, little-endian, 4 octets** — le device fait déjà toute la conversion en interne
(calibration comprise) et expose directement des flottants en unités finales : `LIVE_VMC_VALUE` = % VWC,
`LIVE_TEMPERATURE_VALUE` = °C, `LIVE_LIGHT_VALUE` = probablement mol/m²/jour ou lux (unité exacte non
confirmée dans le code, mais c'est un flottant final, pas une valeur brute de capteur).

**Aucune formule de conversion n'existe côté app** pour la bonne raison qu'**aucune n'est nécessaire** — le
firmware a déjà fait le travail. C'est plus fiable que n'importe quelle formule tierce (WatchFlower ou
autre) : **il suffit de lire un `float32 LE` directement sur ces trois characteristics**.

Point important pour la cohérence du dashboard : les characteristics `39e1fa01` à `39e1fa05` (`LIGHT_SENSOR`,
`SOIL_EC`, `SOIL_TEMPERATURE`, `AIR_TEMPERATURE`, `SOIL_PERCENT_VWC` — probablement des valeurs de capteur
brutes, non calibrées) **existent dans `HawaiiUUID.java` mais ne sont jamais souscrites par
`BleTaskHandler.startLive()`** (voir `CHARACTERISTICS_LIVE_SERVICE` dans `HawaiiUUID.java`, qui ne contient
que `LIVE_MEASURE_PERIOD`, `LIVE_VMC_VALUE`, `LIVE_TEMPERATURE_VALUE`, `LIVE_LIGHT_VALUE`). Elles semblent
être un vestige d'un protocole antérieur (peut-être le premier capteur Flower Power, avant l'ajout du calcul
firmware) — **à ignorer pour un bridge visant le Parrot Pot actuel**, sauf si un sniffing réel montre
qu'elles notifient aussi sur le device physique (auquel cas ce seraient des doublons bruts, utiles pour du
diagnostic mais pas pour l'affichage).

**Recommandation pour le Lot 1** : lire/notifier uniquement `39e1fa09` (VWC %), `39e1fa0a` (température °C),
`39e1fa0b` (lumière), toutes trois en `float32 LE` — pas besoin de formule de calibration séparée.

---

## 4. Bits de `STATUS_FLAGS` (`39e1FD86`, `UUID_PLANT_DR_STATUS_FLAGS`)

Décodage trouvé dans `HawaiiDevice.parsePlantDrStatusFlags()` (`entities/HawaiiDevice.java:649-655`) — la
characteristic est un **seul octet**, lu en notification (souscrite dans `BleTaskHandler.startLive()`), avec
4 bits significatifs sur les 8 :

```java
private void parsePlantDrStatusFlags(byte flags) {
    this.isDrySoil    = (flags & 1) != 0;   // bit 0
    this.isWetSoil    = (flags & 2) != 0;   // bit 1
    this.isEmptyTank  = (flags & 4) != 0;   // bit 2
    this.isInAir      = (flags & 8) != 0;   // bit 3
    this.flagLowWater = this.isEmptyTank;   // alias : "réservoir bas" = "réservoir vide"
}
```

| Bit | Masque | Champ         | Signification                                                                         |
| --- | ------ | ------------- | ------------------------------------------------------------------------------------- |
| 0   | `0x01` | `isDrySoil`   | Sol détecté sec (déclencheur probable de l'algorithme d'auto-arrosage)                |
| 1   | `0x02` | `isWetSoil`   | Sol détecté humide/saturé                                                             |
| 2   | `0x04` | `isEmptyTank` | Réservoir d'eau vide (= `flagLowWater`, l'alerte "réservoir bas" affichée dans l'app) |
| 3   | `0x08` | `isInAir`     | Capteur hors sol / pas de contact avec la terre (pot mal planté ou sonde retirée)     |
| 4-7 | —      | —             | Non utilisés dans le code lu — probablement réservés/toujours à 0                     |

**Nuance importante** : `isDrySoil` et `isWetSoil` ne sont **pas mutuellement exclusifs dans le code** (deux
bits indépendants) — un état "ni sec ni humide" (les deux bits à 0) est probablement l'état "normal/optimal".
Aucune classe ne semble combiner ces flags avec `WATERING_ALGORITHM_STATUS` (`39e1F912`, voir section 2) —
ce sont deux characteristics distinctes, l'une pour l'état courant du sol/réservoir, l'autre pour le statut
de l'algorithme lui-même. Suffisant pour construire un statut dashboard du type "sol sec, réservoir OK,
sonde en terre" directement depuis cet octet, sans dépendre d'un calcul serveur.

---

## 5. Codes d'erreur/statut GATT (`HawaiiBleConstants.java`)

Le fichier ne définit **aucun code custom au niveau GATT** — les constantes `GATT_*` (`GATT_SUCCESS`,
`GATT_INSUF_AUTHENTICATION`, `GATT_CONNECTION_TIMEOUT = 8`, etc., avec `getGattStatusName(int)`) sont une
**recopie exhaustive des codes de statut standards du stack Bluetooth Android/Bluedroid** (les mêmes valeurs
que celles renvoyées par `BluetoothGattCallback.onCharacteristicWrite(..., int status)` etc.). Rien de
spécifique au Parrot Pot ici — un bridge Node.js (`noble`/`@abandonware/noble` ou équivalent) reçoit déjà ces
codes nativement depuis la stack BLE de l'OS ; il suffit de les logguer/mapper pour un message d'erreur
lisible plutôt que de les redéfinir. Les valeurs les plus utiles à surveiller pour ne pas avaler une erreur
silencieusement :

| Code       | Nom                                                | Signification pratique                                                                                                                                                              |
| ---------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`        | `GATT_SUCCESS`                                     | OK                                                                                                                                                                                  |
| `8`        | `GATT_CONNECTION_TIMEOUT`                          | Device hors de portée / venait de s'éteindre pendant l'opération                                                                                                                    |
| `3`        | `GATT_WRITE_NOT_PERMITTED`                         | Écriture refusée — utile si jamais on écrit sur la mauvaise characteristic ou avec le mauvais write-type                                                                            |
| `5` / `15` | `GATT_INSUFFICIENT_AUTHENTICATION` / `_ENCRYPTION` | Pairing/bonding requis avant d'écrire — à vérifier si le Parrot Pot exige un appairage préalable pour le service Watering                                                           |
| `133`      | `GATT_ERROR`                                       | Erreur générique très fréquente sur Android/BlueZ après une déconnexion mal gérée — souvent un signe qu'il faut fermer et rouvrir la connexion GATT plutôt que réessayer l'écriture |
| `62`       | `GATT_CONN_FAILED_TO_BE_ESTABLISHED`               | Échec d'établissement de connexion                                                                                                                                                  |

En plus des codes GATT bas niveau, deux autres familles de constantes existent dans le même fichier, **propres
au protocole applicatif interne de l'app** (IPC entre l'UI et `BleService`, pas le protocole BLE lui-même —
un bridge autonome n'en a pas besoin, elles ne concernent que l'architecture interne Android de l'app) :

- `ERROR_*` (2301-2307) : erreurs applicatives (`ERROR_DEVICE_DISCONNECTED`, `ERROR_COLLECTING_HISTORY`...).
- `getBTStatusName(int)` : bitmask combinable d'état Bluetooth système (`BLUETOOTH_STATUS_NO_BLE=1`,
  `_ON=2`, `_OFF=4`, `BLUETOOTH_LOCATION_NO_ACCESS=8`, `BLUETOOTH_LOCATION_OFF=16` — reflète les permissions
  de localisation Android requises pour scanner en BLE, sans rapport avec le device lui-même).

**Conclusion** : rien à récupérer ici d'utile en dehors des codes GATT standards, déjà bien connus des libs
BLE Node.js — pas de logique d'erreur spécifique au Parrot Pot à répliquer.
