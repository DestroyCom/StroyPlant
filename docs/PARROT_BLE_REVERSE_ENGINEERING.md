# BLE reverse-engineering report — Parrot Flower Power / Parrot Pot (APK 4.6.2)

> Standalone document gathering the entirety of a static analysis (apktool + jadx decompilation, code
> reading, no real BLE capture) performed on the official Parrot Flower Power Android APK v4.6.2, with
> the goal of identifying the Parrot Pot BLE protocol for a Node.js/TypeScript bridge.
>
> **Status: priority source of truth on this topic**, above deductions made from WatchFlower —
> this analysis comes directly from the official Parrot source code (not obfuscated), not from a
> third-party reimplementation.

---

## 1. APK integrity verification

Two APKs downloaded from two different sources for the same version (4.6.2):

- `Parrot+Flower+Power_4.6.2_apkcombo.com.apk`
- `Parrot+Flower+Power_4.6.2_APKPure.apk`

**SHA-256 hash** (identical for both files):
`8304940564c4f9876b43911dac7e44765e836943cf979952a26e3d47fb52ccef`
→ The two files are bit-for-bit identical.

**Signing certificate** (`META-INF/CERT.RSA`, identical in both APKs):

| Field                 | Value                                                                           |
| --------------------- | -------------------------------------------------------------------------------- |
| SHA-256 of `CERT.RSA` | `dc65f8a2bf377881e6ec611e072cce86a3d6ae1a015fbd04299cde849e8c0518`              |
| Subject / Issuer      | `C=FR, ST=France, L=Paris, O=Parrot, OU=Parrot, CN=Parrot Mykonos` (self-signed) |
| Serial                | `1314357138 (0x4e577f92)`                                                        |
| Validity              | August 26, 2011 → May 29, 2066                                                    |
| Algorithm             | SHA1withRSA (v1/JAR signing)                                                     |
| Key                   | RSA 2048 bits                                                                    |

**Verdict**: identical hashes, certificate consistent with the legitimate publisher (Parrot SA).
Nothing suspicious. Analysis continued on `Parrot+Flower+Power_4.6.2_apkcombo.com.apk`.

---

## 2. TL;DR — irrigation characteristic

**Manual irrigation characteristic: `39e1F906-84a8-11e2-afba-0002a5d5c51b` (`UUID_WATERING_CMD`)**,
on the service `39e1F900-84a8-11e2-afba-0002a5d5c51b` (`WATERING_SERVICE_UUID`, also advertised in
BLE advertisement to identify a Parrot Pot). **Confidence level: certain** (direct reading of
non-obfuscated code, no indirect deduction).

The app writes `[0x08, 0x00]` to it (uint16 little-endian, value `BleConfig.WATER_PLANT_TIME = 8`)
via `writeCharacteristic` in _write with response_ mode (`WRITE_TYPE_DEFAULT`), which triggers an
immediate manual watering.

**To trigger watering from a Node.js/TypeScript bridge**: connect to the service
`39e1F900-84a8-11e2-afba-0002a5d5c51b`, write `[0x08, 0x00]` (or another uint16 LE value if the
duration is configurable on the firmware side — unconfirmed, to be verified empirically) to the
characteristic `39e1F906-84a8-11e2-afba-0002a5d5c51b`, with write-with-response.

Important limitation: the "certain" confidence applies to _what the app does_, not to _what the
firmware accepts_ (the firmware might reject a uint16 value other than 8, or conversely accept any
duration). Only a real test on a physical Parrot Pot (or an HCI snoop / nRF Connect capture) can
confirm this.

**Why this confidence is justified**: the app's Java code **is not obfuscated** (no ProGuard/R8 on
the names in the `ble` package) — the classes are literally named `WaterThePlant`,
`WriteWateringConfig`, `HawaiiUUID.UUID_WATERING_CMD`, etc. No call chain tracing from an obfuscated
name like `a.java`/`b()` was ever needed.

---

## 3. Full table of BLE UUIDs

All constants come from `com.parrot.flowerpower.android.ble.service.HawaiiUUID`.
Custom Parrot base UUID: `39e1xxxx-84a8-11e2-afba-0002a5d5c51b`.

Confidence: **certain** = usage confirmed by code that calls
`writeCharacteristic`/`readCharacteristic`/`setCharacteristicNotification` on this exact UUID.
**probable** = UUID present in a consistent service table but not directly seen used in the read
code.

### Watering service (`HAWAII_WATER_DEVICE` = `39e1F900-...`) — the Parrot Pot service

This is the UUID advertised in the BLE advertisement and used as a scan filter to recognize a
Parrot Pot (as opposed to a plain Flower Power sensor, filtered via `HAWAII_SENSOR` = `39e1FA00-...`):

```java
// BleScanTask.java:534
if (HawaiiUUID.HAWAII_WATER_DEVICE_UUID.equals(discoveredUuid) || HawaiiUUID.HAWAII_SENSOR_UUID.equals(discoveredUuid)) {
```

| Characteristic UUID                    | Constant                          | Inferred usage                                                          | Confidence  |
| --------------------------------------- | --------------------------------- | ------------------------------------------------------------------------ | ----------- |
| `39e1F906-84a8-11e2-afba-0002a5d5c51b` | `UUID_WATERING_CMD`               | **Write = triggers manual watering**                                    | **Certain** |
| `39e1F901-...`                         | `UUID_WATERING_CONFIG_ID`         | Write — config ID, written last to validate the watering config          | Certain     |
| `39e1F902-...`                         | `UUID_WATERING_PLANT_ID`          | Write — associated plant ID                                              | Certain     |
| `39e1F903-...`                         | `UUID_WATERING_VWC_IRR`           | Write — moisture (VWC) threshold triggering irrigation                   | Certain     |
| `39e1F904-...`                         | `UUID_WATERING_VWC_CMD`           | Write — target VWC aimed for after irrigation                            | Certain     |
| `39e1F905-...`                         | `UUID_WATERING_N_IRR`             | Write — max number of irrigations                                        | Certain     |
| `39e1F907-...`                         | `UUID_WATERING_TANK_LEVEL`        | Notify — water reservoir level                                           | Certain     |
| `39e1F908-...`                         | `UUID_WATERING_PUMP_DUTY_CYCLE`   | Read — pump duty cycle                                                   | Probable    |
| `39e1F90A/0B/0C-...`                   | `*_ECO`                           | Write — "eco" variants of the VWC/N_IRR thresholds                       | Certain     |
| `39e1F90D-...`                         | `UUID_WATERING_MODE`              | Write (uint8) — watering mode (0=off, 1=auto)                            | Certain     |
| `39e1F90E-...` / `...0F`               | `TIME_SLOT_START` / `DURATION`    | Write — allowed time window for watering                                 | Certain     |
| `39e1F910-...` / `...11`               | `VACATION_START` / `END`          | Write (uint32, timestamp) — vacation mode                                | Certain     |
| `39e1F912-...`                         | `UUID_WATERING_ALGORITHM_STATUS`  | Write (uint8) — enables/disables the auto-watering algorithm             | Certain     |

Manual watering characteristic code:

```java
// WaterThePlant.java — triggered by the internal COMMAND_WATER_PLANT command (106)
public class WaterThePlant extends BaseTask {
    public void run(@NonNull BleTaskHandler taskHandler) {
        taskHandler.setCharacteristic(
            HawaiiUUID.WATERING_SERVICE_UUID,      // 39e1F900-84a8-11e2-afba-0002a5d5c51b
            HawaiiUUID.UUID_WATERING_CMD,          // 39e1F906-84a8-11e2-afba-0002a5d5c51b
            ByteData.uInt16ToByteArray(8));        // value written: 0x08 0x00 (little-endian)
    }
}
```

- `8` = constant `BleConfig.WATER_PLANT_TIME = 8` (probably a duration in seconds, hardcoded).
- `ByteData.uInt16ToByteArray` encodes as **little-endian**: `array[0] = value & 0xFF`, `array[1] = (value >> 8) & 0xFF`.
- Written via `BluetoothGatt.writeCharacteristic()` with `characteristic.setWriteType(2)`
  (`WRITE_TYPE_DEFAULT` = write with response) — see `BleTaskHandler.setCharacteristic()`.

### Plant Dr service (`PLANT_DR_SERVICE_UUID` = `39e1FD80-...`) — advanced automatic irrigation algorithm

| Characteristic            | Constant                                       | Usage                                     | Confidence |
| -------------------------- | ----------------------------------------------- | ------------------------------------------- | ---------- |
| `39e1FD81-...`            | `UUID_PLANT_DR_CONFIG_ID`                       | Write — config validation                  | Certain    |
| `39e1FD82-...` / `...83`  | `DRY_N` / `DRY_VWC`                             | Write — "dry" calibration point             | Certain    |
| `39e1FD84-...` / `...85`  | `WET_N` / `WET_VWC`                             | Write — "wet" calibration point             | Certain    |
| `39e1FD86-...`            | `STATUS_FLAGS`                                  | Notify — algorithm status flags             | Certain    |
| `39e1FD87-...` / `...88`  | `NEXT_WATERING_DATE` / `NEXT_EMPTY_TANK_DATE`   | Notify                                      | Certain    |
| `39e1FD89-...`            | `FULL_TANK_AUTONOMY`                            | Notify                                      | Certain    |

### Live service (`LIVE_SERVICE_UUID` = `39e1fa00-...`) — real-time sensor measurements

| Characteristic        | Constant                             | Usage                                                    | Confidence |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------- | ---------- |
| `39e1fa01-...`        | `UUID_LIVE_LIGHT_SENSOR`              | Notify — raw light sensor                                    | Certain    |
| `39e1fa02-...`        | `UUID_LIVE_SOIL_EC`                   | Notify — soil electrical conductivity                        | Certain    |
| `39e1fa03-...`        | `UUID_LIVE_SOIL_TEMPERATURE`          | Notify                                                       | Certain    |
| `39e1fa04-...`        | `UUID_LIVE_AIR_TEMPERATURE`           | Notify                                                       | Certain    |
| `39e1fa05-...`        | `UUID_LIVE_SOIL_PERCENT_VWC`          | Notify — soil moisture %                                     | Certain    |
| `39e1fa06-...`        | `UUID_LIVE_MEASURE_PERIOD`            | Write (uint8) — sampling period in live mode                 | Certain    |
| `39e1fa07-...`        | `UUID_LIVE_LED_STATE`                 | Notify/Write                                                 | Probable   |
| `39e1fa09-...`        | `UUID_LIVE_VMC_VALUE`                 | Notify                                                       | Certain    |
| `39e1fa0a-...`        | `UUID_LIVE_TEMPERATURE_VALUE`         | Notify                                                       | Certain    |
| `39e1fa0b-...`        | `UUID_LIVE_LIGHT_VALUE`               | Notify                                                       | Certain    |
| `39e1fa0f/10/11-...`  | `LIGHT_RED/GREEN/BLUE_SENSOR_VALUE`   | Notify                                                       | Probable   |

Notification activation (live mode):

```java
// BleTaskHandler.java:1073-1084
setCharacteristicNotification(HawaiiUUID.LIVE_SERVICE_UUID, HawaiiUUID.UUID_LIVE_LIGHT_VALUE, true);
setCharacteristicNotification(HawaiiUUID.LIVE_SERVICE_UUID, HawaiiUUID.UUID_LIVE_TEMPERATURE_VALUE, true);
setCharacteristicNotification(HawaiiUUID.LIVE_SERVICE_UUID, HawaiiUUID.UUID_LIVE_VMC_VALUE, true);
setCharacteristicNotification(HawaiiUUID.WATERING_SERVICE_UUID, HawaiiUUID.UUID_WATERING_TANK_LEVEL, true);
```

### History service (`39e1FC00-...`) and Upload service (`39e1FB00-...`)

| Characteristic        | Constant                                  | Usage                                    | Confidence |
| ---------------------- | -------------------------------------------- | ------------------------------------------ | ---------- |
| `39e1FC01-...`        | `UUID_NB_ENTRIES_VALUE`                    | Read                                       | Certain    |
| `39e1FC02-...`        | `UUID_LAST_ENTRY_INDEX_VALUE`              | Read/Write                                 | Certain    |
| `39e1FC03-...`        | `UUID_TRANSFER_START_INDEX_VALUE`          | Write                                      | Certain    |
| `39e1FC04/05/06-...`  | `CURRENT_SESSION_ID/START_INDEX/PERIOD`    | Read                                       | Certain    |
| `39e1FB01-...`        | `UUID_TX_BUFFER`                           | Notify — history data buffer               | Certain    |
| `39e1FB02-...`        | `UUID_TX_STATUS_VALUE`                     | Notify                                     | Certain    |
| `39e1FB03-...`        | `UUID_RX_STATUS_VALUE`                     | Write                                      | Certain    |

### Device Config service (`39e1FE00-...`)

| Characteristic | Constant                | Usage                                  | Confidence |
| --------------- | ------------------------ | ----------------------------------------- | ---------- |
| `39e1FE01-...` | `UUID_CALIBRATION_DATA` | Read                                     | Certain    |
| `39e1FE03-...` | `UUID_DEVICE_NAME`      | Write (string) — rename the device       | Certain    |
| `39e1FE04-...` | `UUID_COLOR`            | Read                                     | Certain    |
| `39e1FE05-...` | `UUID_TANK_CAPACITY`    | Write (uint8) — reservoir capacity       | Certain    |
| `39e1FE06-...` | `UUID_IS_AVAILABLE`     | Write (uint8) — "available" flag         | Certain    |

### Clock service (`39e1FD00-...`)

| Characteristic | Constant          | Usage           | Confidence |
| --------------- | ------------------ | ----------------- | ---------- |
| `39e1FD01-...` | `UUID_START_TIME` | Write (uint32)   | Certain    |
| `39e1FD02-...` | `UUID_UTC_TIME`    | Write (uint32)   | Certain    |

### OAD service / firmware update (`AIR_DOWNLOAD_SERVICE_UUID` = `F000FFC0-0451-4000-B000-000000000000`)

**Different** base UUID from the rest (standard TI OAD format, not the custom `39e1` prefix).

```java
// FirmwareUpdate.java:57,97
this.taskHandler.setCharacteristic(HawaiiUUID.AIR_DOWNLOAD_SERVICE_UUID, HawaiiUUID.UUID_OAD_IMAGE_NOTIFY, header);
this.taskHandler.setCharacteristic(HawaiiUUID.AIR_DOWNLOAD_SERVICE_UUID, HawaiiUUID.UUID_OAD_IMAGE_BLOCK, dataBuffer, ...);
```

| Characteristic | Constant                | Usage                                  | Confidence |
| --------------- | ------------------------ | ----------------------------------------- | ---------- |
| `F000FFC1-...` | `UUID_OAD_IMAGE_NOTIFY` | Write — header of the firmware to flash  | Certain    |
| `F000FFC2-...` | `UUID_OAD_IMAGE_BLOCK`  | Write — firmware blocks                  | Certain    |

### Standard BLE SIG services

| Service            | UUID                                   | Characteristics                                                                                                          |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Device Information  | `0000180a-0000-1000-8000-00805f9b34fb`   | Serial Number (`00002a25`), Firmware Revision (`00002a26`), Bootloader Version (`00002a27`, non-standard reuse)         |
| Battery Service     | `0000180f-0000-1000-8000-00805f9b34fb`   | Battery Level (`00002a19`)                                                                                               |
| CCCD Descriptor     | `00002902-0000-1000-8000-00805f9b34fb`   | Used by `setCharacteristicNotification()`                                                                                |

### Device types

The code distinguishes two device types (`HawaiiDevice.getDeviceType()`), via the advertised service
UUID:

- **"sensor" type** (classic Flower Power) → advertised service `HAWAII_SENSOR` (`39e1FA00-...`), no
  Watering service exposed.
- **"Parrot Pot" type** → advertised service `HAWAII_WATER_DEVICE` (`39e1F900-...`), exposes the
  full Watering service + Plant Dr.

---

## 4. BLE class tree (package `com.parrot.flowerpower.android.ble`)

Code **not obfuscated**: all class/method names are explicit.

### `ble/` (root)

- `BleConfig.java` — timing constants (timeouts) and `WATER_PLANT_TIME = 8`.

### `ble/Receivers/`

- `BluetoothStateReceiver.java` — restarts `BleService` when the system Bluetooth state changes.
- `BootUpReceiver.java` — restarts `BleService` on phone boot.
- `WakeUpReceiver.java` — periodic background wake-up of the service (via alarm).
- `CallBackBroadcastReceiver.java` / `OnCallBackReceiver.java` — generic internal callback via broadcast.

### `ble/SensorsDB/`

- `DatabaseManager.java` (822 lines) — CRUD facade: devices, accounts, pending tasks, history.
- `SensorsDBHelper.java` — `SQLiteOpenHelper`, local DB schema.

### `ble/service/` (core of the protocol)

- `BleService.java` (2009 lines) — central Android `Service`: receives UI commands (`COMMAND_*`),
  manages the GATT lifecycle, routes each command to the corresponding `Task` (e.g.
  `COMMAND_WATER_PLANT` → `new WaterThePlant(...)`, line 427; `COMMAND_SET_WATERING_CONFIG` →
  `new WriteWateringConfig(...)`, line 480).
- `BleCommandsHandler.java` — near-empty singleton, appears to be dead code.
- `HawaiiUUID.java` — reference table of all UUIDs (see section 3).
- `HawaiiBleConstants.java` (495 lines) — internal commands (`COMMAND_WATER_PLANT = 106`, etc.), error
  codes, GATT status codes, flag masks.

### `ble/service/Tasks/` (one class = one GATT action)

- `BaseTask.java` / `BaseTaskInterface.java` / `BaseTaskHandlerThread.java` — common abstract classes.
- `BleTaskHandler.java` (2089 lines) — **concrete implementation of the GATT client**: holds the
  `BluetoothGatt`, exposes `setCharacteristic()` (write), `getDeviceData()` (read),
  `setCharacteristicNotification()` (notify), handles the `BluetoothGattCallback` callbacks and the
  synchronized write queue.
- `BleScanTask.java` (600 lines) — BLE scan, filtered by `HAWAII_WATER_DEVICE_UUID` or `HAWAII_SENSOR_UUID`.
- **`WaterThePlant.java`** — triggers manual watering (write to `UUID_WATERING_CMD`).
- **`WriteWateringConfig.java`** (157 lines) — writes the entire automatic irrigation config.
- `WritePlantDrConfig.java` — writes the "Plant Dr" calibration config.
- `SetWateringAlgorithmStatus.java` — enables/disables the auto-watering algorithm.
- `SetH2OCapacity.java` — configures the reservoir capacity.
- `WriteAvailableFlag.java` — marks the device available/unavailable.
- `ChangeDeviceName.java` — renames the device.
- `ReadSensorInfo.java` — reads the device's static info.
- `LiveMode.java` — enables live mode (real-time notifications).
- `DownloadHistory.java` (327 lines) — downloads the measurement history.
- `FirmwareUpdate.java` (274 lines) — firmware update via the OAD protocol.

### `ble/service/Utils/`

- `ByteData.java` (155 lines) — uint8/16/32 (de)serialization **little-endian** to/from `byte[]`.
- `HawaiiScanRecord.java` (225 lines) — parsing of the raw BLE scan record.
- `HistoryBuffer.java` — reassembly of history fragments.
- `RxStatus.java` / `TxStatus.java` — upload protocol status enums.
- `Utility.java` — scheduling of the periodic wake-up alarm.

### `ble/service/entities/`

- `HawaiiDevice.java` (981 lines) — business model of a paired device.
- `PlantConfig.java` (176 lines) — a plant's irrigation config, serializable.
- `ExpertConfig.java` — "expert" variant of the plant config.
- `PendingTask.java` — deferred GATT command to replay after reconnection.
- `SampleHistory.java` — a historized measurement (`Parcelable`).
- `Account.java` — email + user flags.
- `BleNotificationData.java` — envelope (UUID + payload) for a received GATT notification.

---

## 5. Native libraries

```
lib/
└── armeabi/
    └── libhunspell.so
```

A single native lib, a single architecture (`armeabi`, legacy 32-bit). **`libhunspell.so`** is
Hunspell, an open-source spell checker — unrelated to BLE, probably used on a text input field
(plant/device name). No binary analysis was performed on it (out of scope).

**Conclusion: no BLE logic is delegated to native code.** The entire GATT stack (scan, connection,
service discovery, read/write/notification, payload encoding) is pure Java on top of the standard
Android API (`android.bluetooth.BluetoothGatt` / `BluetoothGattCallback`). No need for
Ghidra/IDA disassembly: everything is already readable in the decompiled bytecode.

---

## 6. Analysis limitations

- **Static analysis only** (apktool/jadx decompilation): no real BLE capture (HCI snoop / nRF
  Connect) was performed. The "certain" confidence applies to _what the application does_, not to
  _what the device's firmware validates/accepts_ — a real test on a physical Parrot Pot remains
  recommended before production integration, especially for the exact value accepted by
  `UUID_WATERING_CMD`.
- `libhunspell.so` was not disassembled (confirmed out of scope for BLE).
- No Parrot cloud server was contacted during this analysis.
