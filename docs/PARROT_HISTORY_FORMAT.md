# Flower Power / Parrot Pot history binary format — found in romi/flower-power

> Source: https://github.com/romi/flower-power (GPL-3.0, Sony CSL, Doug Boari & P. Hanappe, 2022).
> The conversion functions (`convert_temperature`, `convert_soil_moisture`, `convert_sunlight`)
> originally come from https://github.com/Parrot-Developers/node-flower-power/blob/master/index.js
> (MIT license). The memory structure of the binary history file is documented in this project
> based on https://github.com/BuBuaBu/flower-power-history.
>
> **Status: very promising lead, not yet confirmed for the Parrot Pot specifically.** This code
> targets the Flower Power (sensor only, no watering). The Parrot Pot shares the same family of
> BLE services (same UUIDs `39e1fa00`/`fc00`/`fb00`/`fd00`) but probably has a different entry
> structure (more fields). To be verified empirically before implementing in production.

## Header format (16 bytes, confirmed and applicable as-is)

```python
header = data[:16]
(dummy, num_entries, last_entry_time, first_entry_index,
 last_entry_index, session_id, period) = struct.unpack(">HHIHHHH", header)
```

**Encoding: BIG-ENDIAN** (`>` in the Python struct format), not little-endian. Fields:

- `dummy`: uint16, unclear role (padding or flag)
- `num_entries`: uint16
- `last_entry_time`: uint32 — timestamp of the last entry
- `first_entry_index`: uint16
- `last_entry_index`: uint16
- `session_id`: uint16
- `period`: uint16 — sampling period

Total: 2+2+4+2+2+2+2 = **16 bytes**, exactly the hypothesis already deduced arithmetically from the real Parrot Pot dump (`6044 − 16 = 6028 = 274 × 22`).

## Entry format — Flower Power: 12 bytes, NOT confirmed identical for Parrot Pot

```python
frame = data[offset:offset+12]
(air_temp, light, soil_ec, soil_temp, soil_vwc, battery) = struct.unpack(">HHHHHH", frame)
```

6 raw **big-endian uint16** fields (not float32, contrary to what we had tested):
`air_temp, light, soil_ec, soil_temp, soil_vwc, battery`. Each raw value must then go through a
conversion formula (see below) to produce a usable physical unit.

**For the Parrot Pot**: our real dump gives 22 bytes/entry (274 entries, 6044 bytes, 16-byte
header → 6028/274 = exactly 22). 22 bytes / 2 = **11 uint16 fields**, probably the 6 Flower Power
fields plus ~5 additional fields specific to the Pot (reservoir level, pump state, Plant Dr
flags, etc. — unconfirmed, to be deduced by the next empirical verification).

## Entry timestamp (reconstruction, applicable as-is)

```python
startup_time = current_time_system - device_time_read_from_clock_service
record_timestamp = startup_time + (last_entry_time - (last_entry_index - index) * period)
```

Requires having read the device's system time via the Clock service (`39e1fd01`, already in our
spec) at connection time, in order to calculate the `startup_time` offset.

## Conversion formulas (raw uint16 values → physical units)

```python
import math

def convert_temperature(raw):
    value = (0.00000003044 * raw**3.0
             - 0.00008038 * raw**2.0
             + 0.1149 * raw
             - 30.449999999999999)
    if value < -10.0:
        value = -10.0
    elif value > 55.0:
        value = 55.0
    return value  # °C

def convert_soil_moisture(raw):
    soil_moisture = (0.0000000010698 * raw**4.0
                      - 0.00000152538 * raw**3.0
                      + 0.000866976 * raw**2.0
                      - 0.169422 * raw
                      + 11.4293)
    soil_moisture = 100.0 * (0.0000045 * soil_moisture**3.0
                              - 0.00055 * soil_moisture**2.0
                              + 0.0292 * soil_moisture
                              - 0.053)
    return soil_moisture  # %

def convert_sunlight(raw):
    return 0.08640000000000001 * (192773.17000000001 * raw**-1.0606619)  # mol/m²/day
```

These formulas independently confirm the `mol/m²/day` unit found previously for luminosity
(consistent with `node-flower-power`).

## UUIDs confirmed by this code (consistent with our two other reference documents)

```python
LIVE_SERVICE = "39e1fa00-84a8-11e2-afba-0002a5d5c51b"
LIVE_SERVICE_LED = "39e1fa07-84a8-11e2-afba-0002a5d5c51b"
CLOCK_SERVICE = "39e1fd00-84a8-11e2-afba-0002a5d5c51b"
CLOCK_SERVICE_TIME = "39e1fd01-84a8-11e2-afba-0002a5d5c51b"
HISTORY_SERVICE = "39e1fc00-84a8-11e2-afba-0002a5d5c51b"
HISTORY_SERVICE_ENTRIES_NUMBER = "39e1fc01-..."
HISTORY_SERVICE_LAST_ENTRY_INDEX = "39e1fc02-..."
HISTORY_SERVICE_TRANSFER_START_INDEX = "39e1fc03-..."
HISTORY_SERVICE_SESSION_ID = "39e1fc04-..."
HISTORY_SERVICE_SESSION_START_INDEX = "39e1fc05-..."
HISTORY_SERVICE_SESSION_PERIOD = "39e1fc06-..."
UPLOAD_SERVICE = "39e1fb00-84a8-11e2-afba-0002a5d5c51b"
UPLOAD_SERVICE_TX_BUFFER = "39e1fb01-..."
UPLOAD_SERVICE_TX_STATUS = "39e1fb02-..."
UPLOAD_SERVICE_RX_STATUS = "39e1fb03-..."
```

Note: `HISTORY_SERVICE_SESSION_START_INDEX` (`39e1fc05`) and `HISTORY_SERVICE_SESSION_PERIOD`
(`39e1fc06`) were not characterized with certainty in our initial decompilation document —
confirmed here by independent working code.

## Next step (targeted empirical verification, not a new open-ended loop)

Reuse the dump already downloaded (no new BLE needed):

1. Parse the header with `>HHIHHHH` (16 bytes) — should match `num_entries=274`,
   `period=900` already known otherwise, immediate cross-validation.
2. Decode each 22-byte entry as 11 × big-endian uint16 (`>11H` or `>HHHHHHHHHHH`).
3. Apply `convert_temperature`/`convert_soil_moisture`/`convert_sunlight` on the most likely
   candidate positions (by analogy with the Flower Power order: air temp, light,
   conductivity, soil temp, soil VWC, battery — then test the 5 additional fields one by one).
4. Compare the values obtained for the last entry of the dump with the known live log at the same time.
