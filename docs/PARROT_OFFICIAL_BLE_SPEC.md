# Official Parrot BLE spec (Flower Power) — most reliable source available

> Source: "Bluetooth Low Energy Interface Specification", official Parrot document,
> still accessible at https://developer.parrot.com/docs/FlowerPower/FlowerPower-BLE.pdf
> (the active Parrot developer portal, not the dead old domain `flowerpowerdev.parrot.com`) or as
> FlowerPower-BLE.pdf directly in the repository.
> **Status: source of truth #1 for everything it covers** — this is Parrot's original
> engineering documentation, above any third-party decompilation or reconstruction.
> This document targets the Flower Power (sensor only); the Parrot Pot adds extra services
> (Watering, Plant Dr — see the other reference files) but shares the same base.

## What this document settles for good

### Luminosity unit — 100% confirmed, no residual uncertainty left

The `0xFA0B` characteristic is officially documented as **"calibrated DLI"** (Daily Light
Integral). This unambiguously confirms the `mol/m²/day` unit already inferred from
`node-flower-power` — the mismatch with the WatchFlower label ("µmole.m⁻².s⁻¹") is therefore
indeed a WatchFlower error/imprecision, not the official source. Stop mentioning this uncertainty
as "unresolved" in the other documents.

### Official "live" conversion formulas (raw ADC → voltage)

| UUID     | Description | Official formula                 |
| -------- | ----------- | --------------------------------- |
| `0xFA01` | Light       | raw value as-is                  |
| `0xFA02` | Soil EC     | `(raw_value × 3.3) / (2¹¹−1)`    |
| `0xFA03` | Soil Temp   | `(raw_value × 3.3) / (2¹¹−1)`    |
| `0xFA04` | Air Temp    | `(raw_value × 3.3) / (2¹¹−1)`    |
| `0xFA05` | Soil VWC    | `(raw_value × 3.3) / (2¹¹−1)`    |

Note: this converts an 11-bit ADC into a voltage (0–3.3V), **not directly into a final
physical unit** — an additional calibration step is needed on top of it (consistent with the
polynomial formulas found in `romi/flower-power`, which probably apply to this voltage or to
the raw value directly, to be verified). **For StroyPlant, ignore this path**: use the already
calibrated characteristics below directly, which make this step unnecessary.

### Already calibrated characteristics (float32, ready to use) — new entries found

| UUID     | Description                | Type    | StroyPlant usage                                                                          |
| -------- | --------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `0xFA09` | Calibrated VWC             | float32 | Soil moisture — already in our spec                                                       |
| `0xFA0A` | Calibrated air temperature | float32 | Temperature — already in our spec                                                         |
| `0xFA0B` | **Calibrated DLI**         | float32 | Luminosity, `mol/m²/day` — confirmed above                                                |
| `0xFA0C` | Calibrated Ea              | float32 | **New, not yet in our spec**                                                              |
| `0xFA0D` | Calibrated Ecb             | float32 | **New — likely candidate for "soil conductivity" (CSV column)**                           |
| `0xFA0E` | Calibrated Ec porous       | float32 | **New — other conductivity candidate, still to determine which one matches the CSV column** |

**Action to take**: determine which of `0xFA0D`/`0xFA0E` matches the "Soil
conductivity" metric of the `watchflower_plantdb.csv` CSV (probably Ecb — soil electrical
conductivity — rather than Ec porous, which seems to be a different measurement related to
porosity, but to be confirmed).

### History Service — official bit-widths of the context characteristics (LE, precise)

| UUID     | Description                 | Type                              |
| -------- | ---------------------------- | ---------------------------------- |
| `0xFC01` | Nb entries                  | **U16** little-endian             |
| `0xFC02` | Last entry Index            | **U32** little-endian             |
| `0xFC03` | Transfer Start Index        | **U32** little-endian, Read/Write |
| `0xFC04` | Current Session ID          | **U16** little-endian             |
| `0xFC05` | Current Session Start Index | **U32** little-endian             |
| `0xFC06` | Current Session Period      | **U16** little-endian             |

These individual characteristics are **little-endian** (consistent with the rest of the
standard GATT protocol). Do not confuse this with the content of the buffer reassembled via the
Upload service, which uses a different encoding (see below).

### Upload transport protocol — confirmed identical to what we already had

- Frame 0 (header): 2-byte index (**big-endian**, always 0) + 4-byte total file size
  (**big-endian**) + 14 reserved bytes (20-byte frame total, standard MTU size)
- Subsequent frames: 2-byte index (**big-endian**) + up to 18 bytes of payload
- The transmitter (device) sends in groups of 128 notifications before waiting for an ACK
- The receiver (our backend) must handle: possible duplicate frames, frames received out of
  order (never more than 4 positions apart within a group)
- Timeout: 3 failures to receive a group → abort; more than 1 second waiting for a frame → error
- **The internal format of a sample INSIDE this reassembled buffer is NOT documented in this
  official spec either** — the document explicitly confirms that the received data is sent
  as-is to the server for processing, never decoded client-side. This confirms what we already
  knew from Android decompilation: `romi/flower-power` remains the best lead available for this
  specific point, but remains a third-party reconstruction, not a Parrot confirmation.

### 1-second disconnect timeout — officially confirmed (double source now)

The document explicitly states that this delay was "arbitrarily decided" at 1 second. This
confirms the same data point already present in our spec (section 8), initially sourced via
WatchFlower.

### Official connection strategy — event-driven, not blind polling

The official app only connects to the device in 3 precise cases:

1. The "unread entries" flag is set in the advertisement (new history data available)
2. The "move detected" flag is set (sensor moved)
3. The user manually starts a live session

**Recommendation for Batch 1 (BLE layer)**: parse the advertisement flags (see below) before
deciding whether a GATT connection is needed, rather than connecting at a fixed interval
unconditionally — saves the device's battery, consistent with the spirit of the official
protocol.

### Advertisement flags format (Appendix B)

A flags byte in the advertisement data:

| Bit | Meaning                                                                       |
| --- | ------------------------------------------------------------------------------ |
| 0   | Unread entries — new history data pending                                    |
| 1   | Move detected — sensor moved since last reading                              |
| 2   | Starting — device started less than 3 minutes ago, never connected since     |
| 3-7 | Reserved                                                                       |

### Device Information Service UUIDs — clarified (0x180A)

| UUID     | Description                            | Type        |
| -------- | ---------------------------------------- | ----------- |
| `0x2A23` | System ID                              | 8 bytes    |
| `0x2A25` | Serial Number                          | UTF8 String |
| `0x2A26` | Firmware revision                      | UTF8 String |
| `0x2A27` | Hardware revision (Bootloader version) | UTF8 String |

### Calibration Service (Flower Power base, `39e1FE00`) — the Parrot Pot extends it with FE05/FE06 already documented elsewhere

| UUID     | Description                                          | Type                                |
| -------- | ------------------------------------------------------ | ------------------------------------ |
| `0xFE01` | Calibration data                                     | Array of U16 LE                     |
| `0xFE02` | "Force bond" — reading it triggers iOS pairing        | Dummy byte                          |
| `0xFE03` | Name                                                 | UTF8 String, R/W                    |
| `0xFE04` | Color                                                | U16 LE, enum 1-7 (Pantone colors)   |

## What this document does NOT settle (still relies on other sources)

- The exact binary format of a history sample inside the reassembled buffer —
  still unofficial, see `PARROT_HISTORY_FORMAT_ROMI.md` for the best reconstruction
  available (third-party, not confirmed by Parrot).
- Anything specific to the Parrot Pot (Watering, Plant Dr) — this document only covers the
  base Flower Power, see `PARROT_BLE_REVERSE_ENGINEERING.md` and `PARROT_BLE_DEEP_DIVE.md`.
