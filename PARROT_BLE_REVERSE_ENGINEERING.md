# Rapport de rétro-ingénierie BLE — Parrot Flower Power / Parrot Pot (APK 4.6.2)

> Document autonome regroupant l'intégralité d'une analyse statique (décompilation apktool + jadx, lecture
> de code, pas de capture BLE réelle) menée sur l'APK Android officiel Parrot Flower Power v4.6.2, dans le
> but d'identifier le protocole BLE du Parrot Pot pour un bridge Node.js/TypeScript.
>
> **Statut : source de vérité prioritaire sur ce sujet**, au-dessus des déductions faites depuis WatchFlower —
> cette analyse provient directement du code source officiel Parrot (non obfusqué), pas d'une
> réimplémentation tierce.

---

## 1. Vérification d'intégrité de l'APK

Deux APK téléchargés depuis deux sources différentes pour la même version (4.6.2) :

- `Parrot+Flower+Power_4.6.2_apkcombo.com.apk`
- `Parrot+Flower+Power_4.6.2_APKPure.apk`

**Hash SHA-256** (identique pour les deux fichiers) :
`8304940564c4f9876b43911dac7e44765e836943cf979952a26e3d47fb52ccef`
→ Les deux fichiers sont bit-à-bit identiques.

**Certificat de signature** (`META-INF/CERT.RSA`, identique dans les deux APK) :

| Champ                 | Valeur                                                                          |
| --------------------- | ------------------------------------------------------------------------------- |
| SHA-256 de `CERT.RSA` | `dc65f8a2bf377881e6ec611e072cce86a3d6ae1a015fbd04299cde849e8c0518`              |
| Subject / Issuer      | `C=FR, ST=France, L=Paris, O=Parrot, OU=Parrot, CN=Parrot Mykonos` (auto-signé) |
| Serial                | `1314357138 (0x4e577f92)`                                                       |
| Validité              | 26 août 2011 → 29 mai 2066                                                      |
| Algorithme            | SHA1withRSA (v1/JAR signing)                                                    |
| Clé                   | RSA 2048 bits                                                                   |

**Verdict** : hash identiques, certificat cohérent avec l'éditeur légitime (Parrot SA). Rien de suspect.
Analyse poursuivie sur `Parrot+Flower+Power_4.6.2_apkcombo.com.apk`.

---

## 2. TL;DR — characteristic d'irrigation

**Characteristic d'irrigation manuelle : `39e1F906-84a8-11e2-afba-0002a5d5c51b` (`UUID_WATERING_CMD`)**,
sur le service `39e1F900-84a8-11e2-afba-0002a5d5c51b` (`WATERING_SERVICE_UUID`, aussi annoncé en
advertisement BLE pour identifier un Parrot Pot). **Niveau de confiance : certain** (lecture directe de
code non obfusqué, pas de déduction indirecte).

L'app y écrit `[0x08, 0x00]` (uint16 little-endian, valeur `BleConfig.WATER_PLANT_TIME = 8`) via
`writeCharacteristic` en mode _write with response_ (`WRITE_TYPE_DEFAULT`), ce qui déclenche un arrosage
manuel immédiat.

**Pour piloter l'arrosage depuis un bridge Node.js/TypeScript** : se connecter au service
`39e1F900-84a8-11e2-afba-0002a5d5c51b`, écrire `[0x08, 0x00]` (ou une autre valeur uint16 LE si la durée est
paramétrable côté firmware — non confirmé, à vérifier empiriquement) sur la characteristic
`39e1F906-84a8-11e2-afba-0002a5d5c51b`, avec write-with-response.

Limite importante : la confiance "certain" porte sur _ce que fait l'app_, pas sur _ce qu'accepte le
firmware_ (le firmware pourrait rejeter une valeur uint16 différente de 8, ou au contraire accepter
n'importe quelle durée). Seul un test réel sur un Parrot Pot physique (ou une capture HCI snoop / nRF
Connect) peut le confirmer.

**Pourquoi cette confiance est justifiée** : le code Java de l'app **n'est pas obfusqué** (pas de
ProGuard/R8 sur les noms dans le package `ble`) — les classes s'appellent littéralement `WaterThePlant`,
`WriteWateringConfig`, `HawaiiUUID.UUID_WATERING_CMD`, etc. Aucune remontée d'appel depuis un nom obfusqué
type `a.java`/`b()` n'a été nécessaire.

---

## 3. Tableau complet des UUID BLE

Toutes les constantes viennent de `com.parrot.flowerpower.android.ble.service.HawaiiUUID`.
Base UUID custom Parrot : `39e1xxxx-84a8-11e2-afba-0002a5d5c51b`.

Confiance : **certain** = usage confirmé par du code qui appelle
`writeCharacteristic`/`readCharacteristic`/`setCharacteristicNotification` sur cet UUID précis.
**probable** = UUID présent dans une table de service cohérente mais pas vu directement utilisé dans le
code lu.

### Service Watering (`HAWAII_WATER_DEVICE` = `39e1F900-...`) — le service Parrot Pot

C'est l'UUID annoncé en advertisement BLE et utilisé comme filtre de scan pour reconnaître un Parrot Pot
(par opposition à un simple capteur Flower Power, filtré via `HAWAII_SENSOR` = `39e1FA00-...`) :

```java
// BleScanTask.java:534
if (HawaiiUUID.HAWAII_WATER_DEVICE_UUID.equals(discoveredUuid) || HawaiiUUID.HAWAII_SENSOR_UUID.equals(discoveredUuid)) {
```

| Characteristic UUID                    | Constante                        | Usage déduit                                                           | Confiance   |
| -------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- | ----------- |
| `39e1F906-84a8-11e2-afba-0002a5d5c51b` | `UUID_WATERING_CMD`              | **Écriture = déclenche l'arrosage manuel**                             | **Certain** |
| `39e1F901-...`                         | `UUID_WATERING_CONFIG_ID`        | Write — ID de config, écrit en dernier pour valider la config watering | Certain     |
| `39e1F902-...`                         | `UUID_WATERING_PLANT_ID`         | Write — ID de plante associé                                           | Certain     |
| `39e1F903-...`                         | `UUID_WATERING_VWC_IRR`          | Write — seuil d'humidité (VWC) déclenchant l'irrigation                | Certain     |
| `39e1F904-...`                         | `UUID_WATERING_VWC_CMD`          | Write — VWC cible visée après irrigation                               | Certain     |
| `39e1F905-...`                         | `UUID_WATERING_N_IRR`            | Write — nombre max d'irrigations                                       | Certain     |
| `39e1F907-...`                         | `UUID_WATERING_TANK_LEVEL`       | Notify — niveau du réservoir d'eau                                     | Certain     |
| `39e1F908-...`                         | `UUID_WATERING_PUMP_DUTY_CYCLE`  | Lecture — duty cycle de la pompe                                       | Probable    |
| `39e1F90A/0B/0C-...`                   | `*_ECO`                          | Write — variantes "éco" des seuils VWC/N_IRR                           | Certain     |
| `39e1F90D-...`                         | `UUID_WATERING_MODE`             | Write (uint8) — mode d'arrosage (0=off, 1=auto)                        | Certain     |
| `39e1F90E-...` / `...0F`               | `TIME_SLOT_START` / `DURATION`   | Write — plage horaire autorisée pour arroser                           | Certain     |
| `39e1F910-...` / `...11`               | `VACATION_START` / `END`         | Write (uint32, timestamp) — mode vacances                              | Certain     |
| `39e1F912-...`                         | `UUID_WATERING_ALGORITHM_STATUS` | Write (uint8) — active/désactive l'algorithme d'auto-arrosage          | Certain     |

Code de la characteristic d'arrosage manuel :

```java
// WaterThePlant.java — déclenchée par la commande interne COMMAND_WATER_PLANT (106)
public class WaterThePlant extends BaseTask {
    public void run(@NonNull BleTaskHandler taskHandler) {
        taskHandler.setCharacteristic(
            HawaiiUUID.WATERING_SERVICE_UUID,      // 39e1F900-84a8-11e2-afba-0002a5d5c51b
            HawaiiUUID.UUID_WATERING_CMD,          // 39e1F906-84a8-11e2-afba-0002a5d5c51b
            ByteData.uInt16ToByteArray(8));        // valeur écrite : 0x08 0x00 (little-endian)
    }
}
```

- `8` = constante `BleConfig.WATER_PLANT_TIME = 8` (probablement une durée en secondes, câblée en dur).
- `ByteData.uInt16ToByteArray` encode en **little-endian** : `array[0] = value & 0xFF`, `array[1] = (value >> 8) & 0xFF`.
- Écriture via `BluetoothGatt.writeCharacteristic()` avec `characteristic.setWriteType(2)`
  (`WRITE_TYPE_DEFAULT` = write with response) — voir `BleTaskHandler.setCharacteristic()`.

### Service Plant Dr (`PLANT_DR_SERVICE_UUID` = `39e1FD80-...`) — algorithme d'irrigation automatique avancé

| Characteristic           | Constante                                     | Usage                                    | Confiance |
| ------------------------ | --------------------------------------------- | ---------------------------------------- | --------- |
| `39e1FD81-...`           | `UUID_PLANT_DR_CONFIG_ID`                     | Write — validation config                | Certain   |
| `39e1FD82-...` / `...83` | `DRY_N` / `DRY_VWC`                           | Write — point de calibration "sec"       | Certain   |
| `39e1FD84-...` / `...85` | `WET_N` / `WET_VWC`                           | Write — point de calibration "humide"    | Certain   |
| `39e1FD86-...`           | `STATUS_FLAGS`                                | Notify — flags de statut de l'algorithme | Certain   |
| `39e1FD87-...` / `...88` | `NEXT_WATERING_DATE` / `NEXT_EMPTY_TANK_DATE` | Notify                                   | Certain   |
| `39e1FD89-...`           | `FULL_TANK_AUTONOMY`                          | Notify                                   | Certain   |

### Service Live (`LIVE_SERVICE_UUID` = `39e1fa00-...`) — mesures temps réel des capteurs

| Characteristic       | Constante                           | Usage                                                  | Confiance |
| -------------------- | ----------------------------------- | ------------------------------------------------------ | --------- |
| `39e1fa01-...`       | `UUID_LIVE_LIGHT_SENSOR`            | Notify — capteur de lumière brut                       | Certain   |
| `39e1fa02-...`       | `UUID_LIVE_SOIL_EC`                 | Notify — conductivité électrique du sol                | Certain   |
| `39e1fa03-...`       | `UUID_LIVE_SOIL_TEMPERATURE`        | Notify                                                 | Certain   |
| `39e1fa04-...`       | `UUID_LIVE_AIR_TEMPERATURE`         | Notify                                                 | Certain   |
| `39e1fa05-...`       | `UUID_LIVE_SOIL_PERCENT_VWC`        | Notify — % humidité du sol                             | Certain   |
| `39e1fa06-...`       | `UUID_LIVE_MEASURE_PERIOD`          | Write (uint8) — période d'échantillonnage en mode live | Certain   |
| `39e1fa07-...`       | `UUID_LIVE_LED_STATE`               | Notify/Write                                           | Probable  |
| `39e1fa09-...`       | `UUID_LIVE_VMC_VALUE`               | Notify                                                 | Certain   |
| `39e1fa0a-...`       | `UUID_LIVE_TEMPERATURE_VALUE`       | Notify                                                 | Certain   |
| `39e1fa0b-...`       | `UUID_LIVE_LIGHT_VALUE`             | Notify                                                 | Certain   |
| `39e1fa0f/10/11-...` | `LIGHT_RED/GREEN/BLUE_SENSOR_VALUE` | Notify                                                 | Probable  |

Activation des notifications (mode live) :

```java
// BleTaskHandler.java:1073-1084
setCharacteristicNotification(HawaiiUUID.LIVE_SERVICE_UUID, HawaiiUUID.UUID_LIVE_LIGHT_VALUE, true);
setCharacteristicNotification(HawaiiUUID.LIVE_SERVICE_UUID, HawaiiUUID.UUID_LIVE_TEMPERATURE_VALUE, true);
setCharacteristicNotification(HawaiiUUID.LIVE_SERVICE_UUID, HawaiiUUID.UUID_LIVE_VMC_VALUE, true);
setCharacteristicNotification(HawaiiUUID.WATERING_SERVICE_UUID, HawaiiUUID.UUID_WATERING_TANK_LEVEL, true);
```

### Service History (`39e1FC00-...`) et Upload (`39e1FB00-...`)

| Characteristic       | Constante                               | Usage                                  | Confiance |
| -------------------- | --------------------------------------- | -------------------------------------- | --------- |
| `39e1FC01-...`       | `UUID_NB_ENTRIES_VALUE`                 | Read                                   | Certain   |
| `39e1FC02-...`       | `UUID_LAST_ENTRY_INDEX_VALUE`           | Read/Write                             | Certain   |
| `39e1FC03-...`       | `UUID_TRANSFER_START_INDEX_VALUE`       | Write                                  | Certain   |
| `39e1FC04/05/06-...` | `CURRENT_SESSION_ID/START_INDEX/PERIOD` | Read                                   | Certain   |
| `39e1FB01-...`       | `UUID_TX_BUFFER`                        | Notify — buffer de données historisées | Certain   |
| `39e1FB02-...`       | `UUID_TX_STATUS_VALUE`                  | Notify                                 | Certain   |
| `39e1FB03-...`       | `UUID_RX_STATUS_VALUE`                  | Write                                  | Certain   |

### Service Device Config (`39e1FE00-...`)

| Characteristic | Constante               | Usage                                 | Confiance |
| -------------- | ----------------------- | ------------------------------------- | --------- |
| `39e1FE01-...` | `UUID_CALIBRATION_DATA` | Read                                  | Certain   |
| `39e1FE03-...` | `UUID_DEVICE_NAME`      | Write (string) — renommer l'appareil  | Certain   |
| `39e1FE04-...` | `UUID_COLOR`            | Read                                  | Certain   |
| `39e1FE05-...` | `UUID_TANK_CAPACITY`    | Write (uint8) — capacité du réservoir | Certain   |
| `39e1FE06-...` | `UUID_IS_AVAILABLE`     | Write (uint8) — flag "disponible"     | Certain   |

### Service Clock (`39e1FD00-...`)

| Characteristic | Constante         | Usage          | Confiance |
| -------------- | ----------------- | -------------- | --------- |
| `39e1FD01-...` | `UUID_START_TIME` | Write (uint32) | Certain   |
| `39e1FD02-...` | `UUID_UTC_TIME`   | Write (uint32) | Certain   |

### Service OAD / mise à jour firmware (`AIR_DOWNLOAD_SERVICE_UUID` = `F000FFC0-0451-4000-B000-000000000000`)

Base UUID **différente** du reste (format TI OAD standard, pas le préfixe custom `39e1`).

```java
// FirmwareUpdate.java:57,97
this.taskHandler.setCharacteristic(HawaiiUUID.AIR_DOWNLOAD_SERVICE_UUID, HawaiiUUID.UUID_OAD_IMAGE_NOTIFY, header);
this.taskHandler.setCharacteristic(HawaiiUUID.AIR_DOWNLOAD_SERVICE_UUID, HawaiiUUID.UUID_OAD_IMAGE_BLOCK, dataBuffer, ...);
```

| Characteristic | Constante               | Usage                                | Confiance |
| -------------- | ----------------------- | ------------------------------------ | --------- |
| `F000FFC1-...` | `UUID_OAD_IMAGE_NOTIFY` | Write — header du firmware à flasher | Certain   |
| `F000FFC2-...` | `UUID_OAD_IMAGE_BLOCK`  | Write — blocs du firmware            | Certain   |

### Services BLE SIG standards

| Service            | UUID                                   | Characteristics                                                                                                         |
| ------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Device Information | `0000180a-0000-1000-8000-00805f9b34fb` | Serial Number (`00002a25`), Firmware Revision (`00002a26`), Bootloader Version (`00002a27`, réutilisation non standard) |
| Battery Service    | `0000180f-0000-1000-8000-00805f9b34fb` | Battery Level (`00002a19`)                                                                                              |
| Descriptor CCCD    | `00002902-0000-1000-8000-00805f9b34fb` | Utilisé par `setCharacteristicNotification()`                                                                           |

### Types d'appareils

Le code distingue deux types d'appareils (`HawaiiDevice.getDeviceType()`), via l'UUID de service annoncé :

- **Type "sensor"** (Flower Power classique) → service annoncé `HAWAII_SENSOR` (`39e1FA00-...`), pas de
  service Watering exposé.
- **Type "Parrot Pot"** → service annoncé `HAWAII_WATER_DEVICE` (`39e1F900-...`), expose le service
  Watering complet + Plant Dr.

---

## 4. Arborescence des classes BLE (package `com.parrot.flowerpower.android.ble`)

Code **non obfusqué** : tous les noms de classes/méthodes sont explicites.

### `ble/` (racine)

- `BleConfig.java` — constantes de timing (timeouts) et `WATER_PLANT_TIME = 8`.

### `ble/Receivers/`

- `BluetoothStateReceiver.java` — relance `BleService` si le Bluetooth système change d'état.
- `BootUpReceiver.java` — relance `BleService` au démarrage du téléphone.
- `WakeUpReceiver.java` — réveil périodique du service en tâche de fond (via alarme).
- `CallBackBroadcastReceiver.java` / `OnCallBackReceiver.java` — callback interne générique par broadcast.

### `ble/SensorsDB/`

- `DatabaseManager.java` (822 lignes) — façade CRUD : devices, comptes, tâches en attente, historique.
- `SensorsDBHelper.java` — `SQLiteOpenHelper`, schéma de la base locale.

### `ble/service/` (cœur du protocole)

- `BleService.java` (2009 lignes) — `Service` Android central : reçoit les commandes UI (`COMMAND_*`),
  gère le cycle de vie GATT, route chaque commande vers la `Task` correspondante (ex.
  `COMMAND_WATER_PLANT` → `new WaterThePlant(...)`, ligne 427 ; `COMMAND_SET_WATERING_CONFIG` →
  `new WriteWateringConfig(...)`, ligne 480).
- `BleCommandsHandler.java` — singleton quasi vide, semble être du code mort.
- `HawaiiUUID.java` — table de référence de tous les UUID (voir section 3).
- `HawaiiBleConstants.java` (495 lignes) — commandes internes (`COMMAND_WATER_PLANT = 106`, etc.), codes
  d'erreur, codes de statut GATT, masques de flags.

### `ble/service/Tasks/` (une classe = une action GATT)

- `BaseTask.java` / `BaseTaskInterface.java` / `BaseTaskHandlerThread.java` — classes abstraites communes.
- `BleTaskHandler.java` (2089 lignes) — **implémentation concrète du client GATT** : détient le
  `BluetoothGatt`, expose `setCharacteristic()` (write), `getDeviceData()` (read),
  `setCharacteristicNotification()` (notify), gère les callbacks `BluetoothGattCallback` et la file
  d'attente synchronisée des écritures.
- `BleScanTask.java` (600 lignes) — scan BLE, filtre par `HAWAII_WATER_DEVICE_UUID` ou `HAWAII_SENSOR_UUID`.
- **`WaterThePlant.java`** — déclenche l'arrosage manuel (write `UUID_WATERING_CMD`).
- **`WriteWateringConfig.java`** (157 lignes) — écrit toute la config d'irrigation automatique.
- `WritePlantDrConfig.java` — écrit la config de calibration "Plant Dr".
- `SetWateringAlgorithmStatus.java` — active/désactive l'algorithme d'auto-arrosage.
- `SetH2OCapacity.java` — configure la capacité du réservoir.
- `WriteAvailableFlag.java` — marque le device disponible/indisponible.
- `ChangeDeviceName.java` — renomme l'appareil.
- `ReadSensorInfo.java` — lit les infos statiques du device.
- `LiveMode.java` — active le mode live (notifications temps réel).
- `DownloadHistory.java` (327 lignes) — téléchargement de l'historique de mesures.
- `FirmwareUpdate.java` (274 lignes) — mise à jour firmware via protocole OAD.

### `ble/service/Utils/`

- `ByteData.java` (155 lignes) — (dé)sérialisation uint8/16/32 **little-endian** vers/depuis `byte[]`.
- `HawaiiScanRecord.java` (225 lignes) — parsing du scan record BLE brut.
- `HistoryBuffer.java` — réassemblage des fragments d'historique.
- `RxStatus.java` / `TxStatus.java` — enums de statut du protocole d'upload.
- `Utility.java` — programmation de l'alarme périodique de réveil.

### `ble/service/entities/`

- `HawaiiDevice.java` (981 lignes) — modèle métier d'un appareil apparié.
- `PlantConfig.java` (176 lignes) — config d'irrigation d'une plante, sérialisable.
- `ExpertConfig.java` — variante "expert" de la config de plante.
- `PendingTask.java` — commande GATT différée à rejouer après reconnexion.
- `SampleHistory.java` — une mesure historisée (`Parcelable`).
- `Account.java` — email + flags utilisateur.
- `BleNotificationData.java` — enveloppe (UUID + payload) pour une notification GATT reçue.

---

## 5. Librairies natives

```
lib/
└── armeabi/
    └── libhunspell.so
```

Une seule lib native, une seule architecture (`armeabi`, legacy 32 bits). **`libhunspell.so`** est
Hunspell, un correcteur orthographique open-source — sans rapport avec le BLE, probablement utilisé sur un
champ de saisie (nom de plante/appareil). Aucune analyse binaire n'a été effectuée dessus (hors sujet).

**Conclusion : aucune logique BLE n'est déléguée à du code natif.** Toute la pile GATT (scan, connexion,
découverte de services, lecture/écriture/notification, encodage des payloads) est en Java pur au-dessus de
l'API Android standard (`android.bluetooth.BluetoothGatt` / `BluetoothGattCallback`). Pas besoin de
désassemblage Ghidra/IDA : tout est déjà lisible dans le bytecode décompilé.

---

## 6. Limites de l'analyse

- Analyse **statique uniquement** (décompilation apktool/jadx) : aucune capture BLE réelle (HCI snoop / nRF
  Connect) n'a été effectuée. La confiance "certain" porte sur _ce que fait l'application_, pas sur _ce que
  valide/accepte le firmware du device_ — un test réel sur un Parrot Pot physique reste recommandé avant
  intégration en prod, en particulier pour la valeur exacte acceptée par `UUID_WATERING_CMD`.
- `libhunspell.so` n'a pas été désassemblée (confirmé hors sujet BLE).
- Aucun serveur cloud Parrot n'a été contacté durant cette analyse.
