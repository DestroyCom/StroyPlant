# Deep dive — History/Upload, config write sequences, sensor formulas

Complement to `PARROT_BLE_REVERSE_ENGINEERING.md`, covering the 5 points from the 2026-07-27
priority list (blockers for Batches 2, 6, 7, plus two non-blocking bonus points).

---

## 1. History/Upload protocol — verdict: **the binary format of a sample is NOT decoded on the app side**

### What is properly handled locally: the transport (framing + handshake)

Full sequence, `DownloadHistory.java`:

1. **Context read** (mandatory before any download): `START_TIME`, `CURRENT_SESSION_START_INDEX`,
   then `CURRENT_SESSION_ID`, `CURRENT_SESSION_PERIOD`, `NB_ENTRIES`, `LAST_ENTRY_INDEX` (History
   service `39e1FC00-...`). Start index calculation:
   `startIndex = (lastEntryIndex - nbEntries) + 1`, adjusted against the last index already known on
   the "server" side (`serverSessionStartIndex`, stored in the local DB via `current_history_index`).
2. **Transfer start** (`startDownloadHistory`, line 242):
   ```java
   taskHandler.setCharacteristic(HawaiiUUID.HISTORY_SERVICE_UUID, HawaiiUUID.UUID_TRANSFER_START_INDEX_VALUE,
       ByteData.uInt32ToByteArray(startIndex));           // 39e1FC03, uint32 LE
   taskHandler.setCharacteristicNotification(HawaiiUUID.UPLOAD_SERVICE_UUID, HawaiiUUID.UUID_TX_BUFFER, true);   // 39e1FB01
   taskHandler.setCharacteristicNotification(HawaiiUUID.UPLOAD_SERVICE_UUID, HawaiiUUID.UUID_TX_STATUS_VALUE, true); // 39e1FB02
   setRxStatus(RxStatus.RX_STATUS_RECEIVING, taskHandler);  // write 39e1FB03 = 0x01 (enum ordinal)
   ```
3. **Frame reception** (`onCharacteristicDataReceived`): each notification on `UUID_TX_BUFFER`
   (`39e1FB01`) is added to the buffer (`HistoryBuffer.addToBuffer`). Frame format:
   - `uint16 LE` (first 2 bytes) = **frame index**.
   - If `frameIndex == 0`: the next 4 bytes (`uint32 LE`, offset 2) = **total size of the history
     file in bytes** (`mHistoryFileSize`). This frame 0 is a header frame, not data.
   - Otherwise: the rest of the frame (`value[2:]`) is a raw chunk of the history buffer, stored in a
     `SparseArray<byte[]>` indexed by `frameIndex`.
   - `HistoryBuffer.getByteArray()` concatenates the frames in order `1, 2, 3, ...` until reaching
     `mHistoryFileSize` bytes (truncates the last fragment if needed).
4. **Status handshake** on `UUID_TX_STATUS_VALUE` (`39e1FB02`, notify, a single byte = index in the
   `TxStatus` enum: `IDLE=0`, `TRANSFERRING=1`, `WAITING_ACK=2`):
   - `TX_STATUS_TRANSFERRING`: nothing to do, reception in progress.
   - `TX_STATUS_WAITING_ACK`: the app must verify the integrity of the buffer received so far
     (`HistoryBuffer.checkBuffer()` = no missing frame in the sequence) then write to
     `UUID_RX_STATUS_VALUE` (`39e1FB03`) either `RX_STATUS_ACK` (`0x02`) or `RX_STATUS_NACK` (`0x03`)
     (values = ordinal of the `RxStatus { STANDBY, RECEIVING, ACK, NACK, CANCEL, ERROR }` enum).
   - `TX_STATUS_IDLE`: transfer finished, the device is back to idle → end of download.
5. **End**: check `historyData.length == historyBuffer.getFileSize()`, save to the local DB
   (`DatabaseManager.saveSampleHistory`), increment `current_history_index` for the next session.

This protocol (frame 0 = header with total size, subsequent frames = `[uint16 index][payload]`,
ack/nack on a separate characteristic) **is entirely reproducible in Node.js/TypeScript** — it's a
generic file transfer protocol over BLE, independent of the content.

### What is NOT handled locally: the format of an individual sample

The reassembled buffer (`historyData`, a raw `byte[]`) is **never deserialized into structured
objects on the app side**. Direct proof — `DatabaseManager.saveSampleHistory()`:

```java
// SensorsDB/DatabaseManager.java:636-656
historyCV.put(SensorsDBHelper.COLUMN_SAMPLE, Base64.encodeToString(historyData, 0));
// ... just stored as base64 as-is in SQLite (table_samples), no parsing of individual fields
```

And more importantly — **the app sends this raw blob, still base64, directly to the Parrot cloud
for it to be decoded server-side**:

```java
// SyncService.java:1216 — building the upload request
jsonUpload.put("buffer_base64", this.mSample.sample);   // the raw base64 blob, uninterpreted
// ...
// SyncService.java:1233
WebServicesManagerThread.uploadSamples(accessToken, uploads, sessions, userConfigVersion, ...);
// → POST to Constants.API_URL + "sensor_data/v8/sample"  (WebServicesManagerThread.java:81)
```

**Conclusion: the Parrot Pot firmware encodes its historized samples in a binary format whose
structure (number of fields, order, size, encoding) is not described anywhere in the Android code.**
It's the Parrot cloud API (`sensor_data/v8/sample`) that knows how to interpret `buffer_base64` —
proprietary server-side logic, invisible from the APK. No client class does this work (no local
"parser", no offline mode that would display history without a cloud account).

**Concrete impact on Batch 2**: the format cannot be obtained through this static reverse-engineering
route. Two options remain open:

- **Real BLE capture** (nRF Connect / HCI snoop) during a sync with the official app, then compare
  the captured buffer to the values displayed in the app at that exact moment (temperature, VWC,
  etc. at the time) to empirically deduce the field layout — probably fixed-size records repeated
  (the fact that `mHistoryFileSize` is a predictable multiple, and that `NB_ENTRIES`/`LAST_ENTRY_INDEX`
  are entry counters, strongly suggests this), but the exact size and order of the fields remain
  to be determined empirically.
- **Bypass history entirely**: if the actual need for Batch 2 is just to have time series, we can
  ignore the History/Upload service and **periodically poll the Live characteristics**
  (`39e1fa09/0a/0b`, see section 3) to reconstruct a history on the bridge side — we lose backward
  compatibility (no data during disconnection periods), but this avoids an undocumented protocol.

---

## 2. Configuration write sequences

### `WriteWateringConfig` — exact write order (`WriteWateringConfig.java:82-94`)

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
13. UUID_WATERING_CONFIG_ID         (39e1F901)  uint16 LE  ← written LAST, it's the "commit"
```

**Important**: before writing, the app **first reads the device's current config**
(`handler.getWateringConfig(...)` for VWC*IRR, VWC_CMD, N_IRR, \*\_ECO, TIME_SLOT*\_, VACATION\_\_)
into a `PlantConfig` object, then only modifies the fields concerned by the new
`user_watering_mode` (0=off, 1/3=custom VWC, 2=eco) before rewriting everything. **This is a
read-modify-write pattern, not write-only** — a bridge that wants to change just one parameter (e.g.
the mode) would need to do the same: read the current state of all the Watering service
characteristics, only modify what changes, then rewrite all 13 characteristics in this order,
ending with `CONFIG_ID`.

### The `CONFIG_ID` characteristic is not a simple identifier — it's an **XOR validation checksum**

Key discovery in `PlantConfig.getWateringConfigId()` (`entities/PlantConfig.java:55-57`) — the
Java expression, very nested, is actually a simple **XOR of all the config fields**, each truncated
to 16 bits (since XOR is associative/commutative, the write order in the code doesn't matter
mathematically):

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
  ^ (int16) (watering_vacation_start & 0xFFFF)         // low half of the uint32
  ^ (int16) (watering_vacation_start >>> 16)           // high half of the uint32
  ^ (int16) (watering_vacation_end   & 0xFFFF)
  ^ (int16) (watering_vacation_end   >>> 16)
  ^ (int16) watering_mode
```

This is very likely a **firmware validation checksum**: the device must recognize the same XOR
value computed from the characteristics it just received before applying the config (otherwise it
silently rejects it, or considers the write "in progress" as not committed). **A bridge must
recompute and write this exact value after writing the other 12 characteristics**, with the same
int16 truncation and the same low/high 16-bit splitting for the two 32-bit timestamps.

### `WritePlantDrConfig` — same pattern, simpler formula

Order (`WritePlantDrConfig.java:31-35`): `DRY_N` (39e1FD82) → `DRY_VWC` (39e1FD83) → `WET_N` (39e1FD84) →
`WET_VWC` (39e1FD85) → **`CONFIG_ID`** (39e1FD81, written last).

Checksum formula (`PlantConfig.getPDConfigId()`, `entities/PlantConfig.java:60-62`):

```
pd_config_id (uint16) = (int16) dryN ^ (int16) round(dryVwc * 10) ^ (int16) wetN ^ (int16) round(wetVwc * 10)
```

### `SetWateringAlgorithmStatus` (write `39e1F912` = `UUID_WATERING_ALGORITHM_STATUS`)

Payload: **1 byte** (`ByteData.uInt8ToByteArray(value)`), value bounded on the app side between **0
and 6 inclusive** (`BleService.java:778`: `value < 0 || 6 < value` → rejected client-side). Only
value actually observed in the UI code (`PlantDetailsMaintenanceController.java`, method
`reInitWatering()`): **`0` = reset the auto-watering algorithm** (used after a "maintenance"
operation — draining/cleaning the tank). Values 1 to 6 are accepted by client-side validation but
**no caller in the read code writes anything other than 0** — their exact meaning (probably status
bits similar to those read via notification on the same characteristic) remains to be confirmed,
either by digging further or via sniffing.

---

## 3. Sensor conversion formulas — verdict: **no formula on the app side, the firmware already sends physical values**

Unexpected but very clear result: the three characteristics used by the app's "live mode"
(`BleTaskHandler.startLive()`) are **not** the "raw" characteristics `39e1fa01` through `39e1fa05`,
but three **different** characteristics, already in physical units:

```java
// Tasks/BleTaskHandler.java:616-625 — parsing of the live characteristics
case LIVE_VMC_VALUE:          // 39e1fa09
    this.mDevice.setCurrent_vmc_value(ByteData.getFloat(byteArray));
case LIVE_LIGHT_VALUE:        // 39e1fa0b
    this.mDevice.setCurrent_light_value(ByteData.getFloat(byteArray));
case LIVE_TEMPERATURE_VALUE:  // 39e1fa0a
    this.mDevice.setCurrent_temperature_value(ByteData.getFloat(byteArray));
```

`ByteData.getFloat()` (`Utils/ByteData.java:12-16`):

```java
public static float getFloat(byte[] byteArray) {
    return ByteBuffer.wrap(byteArray).order(ByteOrder.LITTLE_ENDIAN).getFloat(0);
}
```

→ **IEEE 754 32-bit float, little-endian, 4 bytes** — the device already does all the conversion
internally (including calibration) and directly exposes floats in final units: `LIVE_VMC_VALUE` = %
VWC, `LIVE_TEMPERATURE_VALUE` = °C, `LIVE_LIGHT_VALUE` = **DLI (Daily Light Integral),
mol/m²/day** — unit confirmed unambiguously by the official Parrot engineering PDF
(`docs/PARROT_OFFICIAL_BLE_SPEC.md`, characteristic literally documented as "calibrated DLI"). This
decompiled code alone did not give the unit (just a final float, not a raw sensor value); see
`docs/STROYPLANT_SPEC.md` section 8 for the detail of the confirmation.

**No conversion formula exists on the app side** for the good reason that **none is needed** — the
firmware has already done the work. This is more reliable than any third-party formula (WatchFlower
or other): **it's enough to read a `float32 LE` directly on these three characteristics**.

Important point for dashboard consistency: the characteristics `39e1fa01` through `39e1fa05`
(`LIGHT_SENSOR`, `SOIL_EC`, `SOIL_TEMPERATURE`, `AIR_TEMPERATURE`, `SOIL_PERCENT_VWC` — probably raw,
uncalibrated sensor values) **exist in `HawaiiUUID.java` but are never subscribed to by
`BleTaskHandler.startLive()`** (see `CHARACTERISTICS_LIVE_SERVICE` in `HawaiiUUID.java`, which only
contains `LIVE_MEASURE_PERIOD`, `LIVE_VMC_VALUE`, `LIVE_TEMPERATURE_VALUE`, `LIVE_LIGHT_VALUE`). They
seem to be a leftover from an earlier protocol (perhaps the original Flower Power sensor, before the
firmware computation was added) — **to be ignored for a bridge targeting the current Parrot Pot**,
unless real sniffing shows they also notify on the physical device (in which case they'd be raw
duplicates, useful for diagnostics but not for display).

**Recommendation for Batch 1**: read/notify only `39e1fa09` (VWC %), `39e1fa0a` (temperature °C),
`39e1fa0b` (light), all three as `float32 LE` — no separate calibration formula needed.

---

## 4. `STATUS_FLAGS` bits (`39e1FD86`, `UUID_PLANT_DR_STATUS_FLAGS`)

Decoding found in `HawaiiDevice.parsePlantDrStatusFlags()` (`entities/HawaiiDevice.java:649-655`) —
the characteristic is a **single byte**, read via notification (subscribed in
`BleTaskHandler.startLive()`), with 4 significant bits out of 8:

```java
private void parsePlantDrStatusFlags(byte flags) {
    this.isDrySoil    = (flags & 1) != 0;   // bit 0
    this.isWetSoil    = (flags & 2) != 0;   // bit 1
    this.isEmptyTank  = (flags & 4) != 0;   // bit 2
    this.isInAir      = (flags & 8) != 0;   // bit 3
    this.flagLowWater = this.isEmptyTank;   // alias: "low reservoir" = "empty reservoir"
}
```

| Bit | Mask   | Field         | Meaning                                                                              |
| --- | ------ | ------------- | ------------------------------------------------------------------------------------- |
| 0   | `0x01` | `isDrySoil`   | Soil detected dry (probable trigger for the auto-watering algorithm)                  |
| 1   | `0x02` | `isWetSoil`   | Soil detected wet/saturated                                                           |
| 2   | `0x04` | `isEmptyTank` | Water reservoir empty (= `flagLowWater`, the "low reservoir" alert shown in the app)  |
| 3   | `0x08` | `isInAir`     | Sensor out of soil / no contact with the ground (poorly planted pot or probe removed) |
| 4-7 | —      | —             | Not used in the read code — probably reserved/always 0                                |

**Important nuance**: `isDrySoil` and `isWetSoil` are **not mutually exclusive in the code** (two
independent bits) — a "neither dry nor wet" state (both bits 0) is probably the "normal/optimal"
state. No class seems to combine these flags with `WATERING_ALGORITHM_STATUS` (`39e1F912`, see
section 2) — these are two distinct characteristics, one for the current soil/reservoir state, the
other for the algorithm's own status. Sufficient to build a dashboard status like "dry soil,
reservoir OK, probe in soil" directly from this byte, without depending on a server-side
computation.

---

## 5. GATT error/status codes (`HawaiiBleConstants.java`)

The file defines **no custom code at the GATT level** — the `GATT_*` constants (`GATT_SUCCESS`,
`GATT_INSUF_AUTHENTICATION`, `GATT_CONNECTION_TIMEOUT = 8`, etc., with `getGattStatusName(int)`) are
an **exhaustive copy of the standard Android/Bluedroid Bluetooth stack status codes** (the same
values as those returned by `BluetoothGattCallback.onCharacteristicWrite(..., int status)` etc.).
Nothing Parrot Pot-specific here — a Node.js bridge (`noble`/`@abandonware/noble` or equivalent)
already receives these codes natively from the OS's BLE stack; it's just a matter of
logging/mapping them to a readable error message rather than redefining them. The most useful
values to watch to avoid silently swallowing an error:

| Code       | Name                                                | Practical meaning                                                                                                                                                                   |
| ---------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`        | `GATT_SUCCESS`                                     | OK                                                                                                                                                                                  |
| `8`        | `GATT_CONNECTION_TIMEOUT`                          | Device out of range / just powered off during the operation                                                                                                                       |
| `3`        | `GATT_WRITE_NOT_PERMITTED`                         | Write refused — useful if we ever write to the wrong characteristic or with the wrong write-type                                                                                  |
| `5` / `15` | `GATT_INSUFFICIENT_AUTHENTICATION` / `_ENCRYPTION` | Pairing/bonding required before writing — to check whether the Parrot Pot requires prior pairing for the Watering service                                                          |
| `133`      | `GATT_ERROR`                                       | Very common generic error on Android/BlueZ after a poorly handled disconnection — often a sign that the GATT connection should be closed and reopened rather than retrying the write |
| `62`       | `GATT_CONN_FAILED_TO_BE_ESTABLISHED`               | Connection establishment failure                                                                                                                                                    |

In addition to the low-level GATT codes, two other families of constants exist in the same file,
**specific to the app's internal application protocol** (IPC between the UI and `BleService`, not
the BLE protocol itself — a standalone bridge doesn't need them, they only concern the app's
internal Android architecture):

- `ERROR_*` (2301-2307): application errors (`ERROR_DEVICE_DISCONNECTED`, `ERROR_COLLECTING_HISTORY`...).
- `getBTStatusName(int)`: combinable bitmask of system Bluetooth state (`BLUETOOTH_STATUS_NO_BLE=1`,
  `_ON=2`, `_OFF=4`, `BLUETOOTH_LOCATION_NO_ACCESS=8`, `BLUETOOTH_LOCATION_OFF=16` — reflects the
  Android location permissions required to scan over BLE, unrelated to the device itself).

**Conclusion**: nothing useful to gain here beyond the standard GATT codes, already well known to
Node.js BLE libraries — no Parrot Pot-specific error logic to replicate.
