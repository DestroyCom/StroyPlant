# Health Engine — how the health scoring works

This document explains in detail how the `backend/src/health/` module (Batch 4) works. It
complements `docs/STROYPLANT_SPEC.md` section 7.3 (which sets the requirements) by documenting the
algorithm actually implemented and the choices made during implementation.

## The problem to solve

A sensor returns raw numbers (soil moisture at 22%, temperature at 24°C...). The Health
Engine turns this into a useful judgment: *is this good for this plant, right now?*

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

- **Parrot Pot**: soil moisture, temperature, luminosity, soil conductivity (`soilConductivityEcPorous`).
- **Xiaomi LYWSD03MMC**: temperature, humidity.

*(Soil pH exists in `PlantProfile` but isn't measured by any current device. Reserved for
possible future device types, Batch 9.)*

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

*Why a standard deviation as the threshold and not a fixed percentage?* Because normal
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
- **Soil conductivity scoring — CSV mapping not empirically confirmed.** `Reading` collects two
  candidate raw values (`soilConductivityEcb`, `soilConductivityEcPorous` — characteristics
  `39e1fa0d`/`0e`, confirmed by the official Parrot PDF but never read by the official app
  itself, see `docs/STROYPLANT_SPEC.md` section 8). `soilConductivityEcPorous` is wired into
  `computeDeviceHealth` (compared against `soilConductivityMinUsCm`/`MaxUsCm` from the CSV) based
  on soil science research (METER Group, 30MHz): "Ec porous" (pore water EC) is the value the
  horticultural industry calls "soil conductivity" by default, as opposed to "Ecb" (bulk EC,
  raw, kept in the database for diagnostics but never used in scoring). **No real data has been
  collected yet to validate this choice** — only synthetic mock values at the time of this
  decision. An empirical correlation protocol is planned
  (`docs/STROYPLANT_SPEC.md` section 7.1) but not yet executed (requires physical access to the
  devices) — to be revalidated once real readings are available.
- **No soil pH scoring**: the CSV contains this range but no current device measures it.

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
