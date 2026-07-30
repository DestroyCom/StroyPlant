# Health Engine — how the health scoring works

This document explains in detail how the `backend/src/health/` module (Batch 4) works. It
complements `docs/STROYPLANT_SPEC.md` section 7.3 (which sets the requirements) by documenting the
algorithm actually implemented and the choices made during implementation.

## The problem to solve

A sensor returns raw numbers (soil moisture at 22%, temperature at 24°C...). The Health
Engine turns this into a useful judgment: _is this good for this plant, right now?_

Two difficulties make this non-trivial:

1. **"Good" depends on the species.** 22% moisture is perfect for a cactus, catastrophic for a
   fern. So we need to know which plant is in which pot.
2. **Pots will already be in soil at startup**, with plants already in place — it's impossible to
   do a controlled calibration ("probe in air", "dry soil", "saturated soil") without disturbing
   an existing plant, for almost all devices. The system must therefore learn on its own, by
   observing, rather than depending on an initial calibration step.

The solution combines **two complementary sources of information**:

| Source                             | Nature                          | Role                                                  |
| ---------------------------------- | ------------------------------- | ----------------------------------------------------- |
| Species database (WatchFlower CSV) | Absolute, generic, 3404 plants  | Coarse safety net: detect a completely aberrant value |
| Per-device rolling baseline        | Relative, personalized, learned | Refine the judgment over time, specific to THIS pot   |

Today (this batch), only the first source is actually used to judge `ok`/`too_low`/
`too_high`. The second (baseline) is currently used for **trend detection** (progressive
degradation) rather than for computing the status itself — see "What isn't done yet" at the bottom
of the page.

## Source #1 — the species database (`PlantProfile`)

**Where it comes from**: the `assets/plants/watchflower_plantdb.csv` file from the open-source
[WatchFlower](https://github.com/emericg/WatchFlower) project (the one StroyPlant replaces). 3404 plants,
each with min/max ranges for: soil moisture, soil conductivity, soil pH, temperature,
humidity, luminosity (in lux and in mmol).

**How it's imported**: `pnpm import:species` (or `make import-species`) downloads this CSV at
runtime — **the file is never committed to StroyPlant**, because it's under the GPLv3 license
(the WatchFlower repo's license) and redistributing third-party data in a public repo under
a different license is a gray area we'd rather avoid. The download URL is pinned to a specific
Git commit (not `master`), so a later re-import doesn't silently change the data version. The
script (`backend/src/health/importSpeciesProfiles.ts`) parses the CSV (`;` delimiter, empirically
verified to have no quoting/escaping, so a simple line split is enough) and does an `upsert` per
species (name = unique key) into the `PlantProfile` table — re-running the import doesn't
duplicate anything, it just updates.

**The `0;0` trap**: in this CSV, a `MIN=0 / MAX=0` range doesn't mean "from 0 to 0" — it
means "this data doesn't exist for this plant" (e.g. soil pH is often not filled in for
succulents). The script systematically converts `0;0` to `null;null` — without this safeguard, the
scoring engine would flag a false "too high" alert on any positive measurement.

**Assigning to a device**: each `Device` has an optional `plantProfileId` (`PUT
/api/devices/:id/plant-profile`). Optional and non-blocking — a device with no assigned profile
simply never gets scored (`status: 'no_profile'`), which doesn't block anything else in the app.

## Source #2 — the per-device rolling baseline

**The idea**: instead of relying solely on a generic species range (which may not exactly
match THIS pot, THIS soil, THIS microclimate), the system looks at the device's own recent
history to spot **drift** — a trend that degrades over time, even if the instantaneous value
stays within bounds.

**Calculation window**: configurable via `HEALTH_BASELINE_WINDOW_DAYS` (default 14 days). Each
call to `GET /api/devices/:id/health` reloads the readings from the last N days from the database.

**"Warm-up" period**: as long as a device doesn't have at least `HEALTH_WARMUP_MIN_DAYS`
(default 3 days) of history, the returned global status is `warming_up` rather than an actual
judgment. Reason: without this, a device that was just added would show an alert from its very
first reading, based solely on a generic species range that may not match the pot's reality —
it's better to wait for a bit of perspective. Values and comparisons are still computed and
returned during warm-up (useful for debugging/testing), only the global status changes.

## The calculation, step by step (`computeDeviceHealth` in `src/health/scoring.ts`)

For each parameter relevant to the device type:

- **Parrot Pot**: soil moisture, temperature, luminosity, soil conductivity/fertility index (`soilConductivityUsCm`).
- **Xiaomi LYWSD03MMC**: temperature, humidity.

_(Soil pH exists in `PlantProfile` but isn't measured by any current device. Reserved for
possible future device types, Batch 9.)_

### 1. Short rolling average, not just the instantaneous value

A single isolated reading is never judged on its own (too sensitive to measurement noise). We
take the average of readings from **the last hour**. If there's no reading in the last hour
(infrequent polling, or device not seen recently), we fall back to the average of the last 5
known readings, regardless of how old they are.

### 2. Comparison to the species range

If the assigned profile has a defined range for this parameter (not `null;null`), the average
value is compared:

- below the minimum → `too_low`
- above the maximum → `too_high`
- in between → `ok`

If the range is `null;null` (not applicable for this species, e.g. pH for a cactus) → status `n/a`,
no judgment made on this parameter.

**Special case — luminosity (unit conversion)**: the Parrot Pot firmware (`39e1fa0b`)
returns luminosity in **mol/m²/day** (DLI, Daily Light Integral — confirmed via the official
`Parrot-Developers/node-flower-power` library, see `docs/STROYPLANT_SPEC.md` section 8), whereas
the WatchFlower CSV expresses its "Light MIN/MAX" ranges in **mmol/m²/day**. The read value is
therefore multiplied by 1000 before any comparison — and it's this converted value (not the raw
one) that is returned in the API response, so that the value and the species range are always in
the same unit on the consumer side (frontend, MCP...). Before this unit was confirmed,
luminosity was deliberately excluded from the comparison — that's no longer the case.

### 3. Trend detection

On the parameter most revealing of progressive water shortage — soil moisture for the Parrot
Pot, humidity for the Xiaomi (which has no soil probe) — we compare:

- the average of the **last 3 days** (`recentMean`)
- to the average of the **rest of the** baseline **window** (`olderMean`, i.e. days 4 to 14, for
  example)

If `recentMean` has dropped by more than one standard deviation compared to `olderMean` →
`degrading`. If it has increased by as much → `improving`. Otherwise → `stable`. (`unknown` if
there isn't enough data on either side of the 3-day threshold — the typical case right after
warm-up, when all the history is too recent.)

_Why a standard deviation as the threshold and not a fixed percentage?_ Because normal
variability differs from one device to another (a pot with regular automatic watering has a more
stable baseline than a pot watered manually and irregularly) — a threshold relative to the
device's own past variability avoids triggering a trend alert on normal noise for THAT particular
pot, while staying sensitive on a pot that's usually very stable.

### 4. Global status

`warning` if at least one parameter is `too_low` or `too_high`, otherwise `ok` (unless still in
`warming_up`, which takes precedence over everything else except `no_profile`).

## What isn't done yet (known limitations, not bugs)

- **The rolling baseline isn't yet used to compute the `ok`/`too_low`/`too_high` status itself**,
  only the trend. The "coarse safety net" (species range) and the "personalized refinement"
  (baseline) described in section 7.3 of the spec aren't fully combined yet — that's the logical
  next step once we've observed real behavior on production devices long enough to validate that
  the current trend logic is relevant.
- **No `STATUS_FLAGS.isInAir` filtering** (probe out of soil): this flag comes from the Plant Dr
  service of the Parrot Pot, which isn't implemented yet (Batch 6). Today, a reading taken while
  the probe is poorly planted or removed pollutes the calculations like any other reading. To be
  fixed once Batch 6 is done — not added preemptively, to avoid an unnecessary DB column in the
  meantime.
- **No score persisted in the database**: each call to `GET /api/devices/:id/health` recomputes
  everything on the fly from the stored `Reading` records. Deliberate: there's no cron
  infrastructure in the project yet (the scanner runs in a loop but nothing else), and Batch 5
  (auto-watering scheduler) will actually need it for its pump anti-spam logic — adding a
  persistence mechanism now would have been over-engineering for a need that doesn't exist yet.
- **No soil pH scoring**: the CSV contains this range but no current device measures it.

## Soil conductivity / fertility index — history (resolved 2026-07-30)

Originally (Batch 4/6) this project read the "calibrated" `39e1fa0d`/`0e` characteristics
("Ecb"/"Ec porous" — new, undocumented before `docs/PARROT_OFFICIAL_BLE_SPEC.md`, and never read
by the official Parrot app itself). Confirmed via real production logs (`docker logs stroyplant`,
24h window, both real Parrot Pots `A0:14:3D:CD:A0:73` and `A0:14:3D:CD:A3:D3`) to be **unreadable
100% of the time** (`Characteristic not available`) — they simply don't exist on this firmware
revision's GATT table. DestCom's `todo.md` flagged this as "missing soil fertility index"; the
initial investigation confirmed the gap but stopped short of a fix pending validation.

**Root cause found by reading WatchFlower's actual Parrot Pot driver**
(`github.com/emericg/WatchFlower`, `src/devices/device_parrotpot.cpp`,
`serviceDetailsDiscovered_live()`): the real, shipped driver never reads `fa0d`/`fa0e` at all — it
reads the RAW `39e1fa02` characteristic (`UUID_LIVE_SOIL_EC`, marked "Certain" in
`docs/PARROT_BLE_REVERSE_ENGINEERING.md`, part of the same `39e1fa00` sensor service as soil
moisture/temperature/luminosity) and applies an empirically-tuned linear mapping: clamp the raw
uint16 to `[1500, 2036]`, then map `2036 → 0` / `1500 → 1000` (higher raw ADC = less conductive
soil). This directly explains the 100% failure rate — this project was reading characteristics
that don't exist on real hardware, while a confirmed-present one sat right next to the
characteristics we already read successfully every poll.

Fixed by switching to `39e1fa02` (`backend/src/ble/parrot/soilConductivity.ts`'s
`decodeSoilConductivityRaw`, duplicated in `noble-bridge/src/parrot.ts` per that package's own
duplication convention). The old `soilConductivityEcb`/`soilConductivityEcPorous` `Reading` columns
are gone, replaced by a single `soilConductivityUsCm` — this is now `computeDeviceHealth`'s
`soilConductivityUsCm` parameter, compared against the CSV's `soilConductivityMinUsCm`/`MaxUsCm`
range exactly as before, with no separate unit conversion needed (WatchFlower stores this same
0-1000-ish mapped value directly against its own CSV column). Label in the frontend:
"Fertilité du sol" (`frontend/src/lib/format.ts`).

**Cross-check against the official app's own decompiled source** (DestCom's own
`parrot-pot-debug/analyse/decoded_jadx`, not just this project's summarized docs) — worth doing
before trusting a third-party (WatchFlower) driver, since `CLAUDE.md` section 9's source hierarchy
puts our own decompilation above WatchFlower for exactly this kind of question.
`HawaiiUUID.java` confirms `UUID_LIVE_SOIL_EC` (`fa02`) is a named constant with a
`CHARACTERISTIC_TYPES` entry, but it's absent from `CHARACTERISTICS_LIVE_SERVICE` (the set the
official app actually subscribes to) for both the Flower Power and Parrot Pot device types — and a
repo-wide grep found `SOIL_EC` referenced nowhere else in the app's logic. This isn't a _contrary_
signal to WatchFlower (the official app doesn't touch it either way, positive or negative) — just
confirmation the official app itself gives zero empirical evidence on whether real Pot hardware
implements this characteristic. Also compared WatchFlower's Flower Power driver
(`device_flowerpower.cpp`): same `fa02` UUID, but a **different** formula (`raw / 1.771`, plain
linear) than the Parrot Pot driver's clamp+inverted-map — confirms WatchFlower calibrates
per-device-model rather than reusing one formula, so using the Pot-specific file/formula (not
Flower Power's) was the right choice.

**Empirically confirmed on real hardware (2026-07-30)**: briefly stopped the production
`stroyplant` container, ran a disposable one-off container from the same image (`docker run
--entrypoint node`, same D-Bus/network mounts) against the real Parrot Pots.
Result: `fa02`**does respond** — raw uint16 LE =`757`(alongside a successful sanity-check read
of the already-known-good`fa09`/VMC characteristic, 30.96%, plausible). This settles the "does it
even exist on real Pot firmware" question the official app's silence couldn't answer.

**New open question, distinct from the existence question above**: `757` falls _below_
WatchFlower's assumed calibration window (`[1500, 2036]`) — with the current clamp+map formula,
this reading clamps to the very top of the 0-1000 output scale. This doesn't invalidate the fix
(the characteristic genuinely exists and returns a real ADC value), but suggests WatchFlower's
community-tuned constants (from their own tested units) may not transfer exactly to this specific
hardware/soil. **Not corrected from this single data point** — one reading isn't enough to derive a
new calibration curve, and guessing new constants from n=1 would repeat the same mistake this whole
investigation was trying to avoid. Needs the same kind of longitudinal empirical protocol already
used elsewhere in this project (e.g. readings before/after a known fertilizer event, across both
real pots over time) before touching `ble/parrot/soilConductivity.ts`'s constants.

## API

- `GET /api/plant-profiles?search=<text>` — search by name (max 20 results), to associate a
  species with a device.
- `PUT /api/devices/:id/plant-profile` — body `{ "plantProfileId": number | null }`. `null`
  unassigns.
- `GET /api/devices/:id/health` — returns:
  ```json
  {
    "status": "ok" | "warning" | "warming_up" | "no_profile",
    "parameters": {
      "soilMoisturePercent": { "value": 24.3, "status": "ok", "speciesRange": [15, 60] },
      "temperatureC": { "value": 21.1, "status": "ok", "speciesRange": [12, 32] }
    },
    "trend": "stable" | "degrading" | "improving" | "unknown"
  }
  ```

## Configuration (`backend/.env`)

```
HEALTH_BASELINE_WINDOW_DAYS=14   # baseline/trend window
HEALTH_WARMUP_MIN_DAYS=3         # minimum days before leaving "warming_up" status
```

## How to test

1. `pnpm import:species` (downloads and imports the 3404 profiles — idempotent, can be re-run).
2. Assign a profile to a device: `PUT /api/devices/<id>/plant-profile` with
   `{ "plantProfileId": <id> }` (found via `GET /api/plant-profiles?search=Monstera` for example).
3. `GET /api/devices/<id>/health` — with `BLE=mock`, the `MOCK-POT-DECLINE` device simulates
   moisture that gradually drops (see `backend/src/providers/mock/index.ts`), designed
   specifically to observe an `ok` → `warning`/`too_low` transition over time.
