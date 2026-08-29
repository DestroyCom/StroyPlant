# Parrot plant database import — design

**Date:** 2026-08-29
**Status:** approved by DestCom (source priority + calibration field scope confirmed live, see decisions below)

## Context

DestCom got the official "Flower Power" iOS app (Parrot's own app, covering Flower Power/Parrot
Pot) running natively on his Apple Silicon Mac (`/Applications/Flower Power.app`, a wrapped iOS
binary). Inspecting the app bundle (no binary decompilation needed — the main executable is
FairPlay-encrypted, `cryptid=1` confirmed via `otool`, but every resource file is plain) found two
bundled JSON dumps:

- `{EN,FR,DE,...}_dump.json.zip` — a general plant encyclopedia, 8090 species (`version:
  en_20170421_4.0.8`), rich free text (planting/growth/pruning advice) and coarse ordinal
  categories (`characteristics.water`/`sun`/`fertilizer`, 1-4 scale) — not the calibrated sensor
  data.
- `scientific_data.json.zip` — the real find: one profile per species (keyed by the same `id` as
  the encyclopedia dump, 8091 entries for 8090 plants, verified 1:1 join), containing:
  `dli_min`/`dli_max` (Daily Light Integral, mol/m²/day — confirmed unit, matches the project's
  own DLI work in `health/dailyLightIntegral.ts`), `adt_min`/`adt_max` (average daily temperature,
  °C), `ec_min`/`ec_max` (soil conductivity — confirmed mS/cm by physical plausibility: 0.5-5
  µS/cm would be an absurdly low soil EC, and cross-checking *Abelia × grandiflora* against
  WatchFlower's own CSV entry for the same species — 350-2000 µS/cm vs. Parrot's 500-5000 µS/cm
  scaled ×1000 — lands in the same order of magnitude), `vwc_dry`/`vwc_wet` (volumetric water
  content %, exactly the same physical quantity as this project's own `DRY_VWC`/`WET_VWC` Plant Dr
  calibration fields, Batch 6), and `vwc_irr`/`vwc_cmd` + `_eco` variants (irrigation-trigger and
  target "command" moisture levels, normal vs. eco mode — no equivalent field exists anywhere in
  this project yet).

This is manufacturer-calibrated data for the exact sensor hardware this project already talks to,
covering 8090 species vs. the 3404 currently imported from WatchFlower's CSV
(`backend/src/health/importSpeciesProfiles.ts`).

## Two anomalies found — resolved after empirical cross-checking, discussed live with DestCom

- **`dli_max == 99` on 7240/8090 species (89.5%)**. Initial read: "clearly a sentinel." Checked
  against `characteristics.sun` (the encyclopedia dump's own 1-4 sun-tolerance category) before
  finalizing that call: **100%** of `sun=4` (full-sun) species show `dli_max=99`, but so do
  **55.7%** of `sun=1` (shade) species — a shade plant "tolerating up to 99 mol/m²/day" has no
  physiological meaning, so this isn't a real per-species measurement for at least that half.
  Reads as a coarse default assigned by sun category when no specific value was researched, not
  pure noise (it does correlate with `sun`) and not a precise number either.
- **`ec_min == -1`** — far rarer than first assumed (432/8090, ~5.3%, not the majority the initial
  phrasing implied). Highly structured: 288 of those 432 share the exact same `(water=2,
  ec_max=3)` pairing — the same "generic default for an under-researched species in this water
  category" pattern as `dli_max=99`, not an isolated flag.
- **Decision (DestCom, after seeing the cross-check above): keep the raw values, do not null
  them.** `buildParrotPlantRow` stores `dli_max`/`ec_min` unit-converted exactly as given, sentinel
  or not — `soilMoistureMinPercent`/`lightMaxMmol`/`soilConductivityMinUsCm` etc. are populated
  straight from the source with no special-casing. **Known, accepted consequence**: for the
  ~5300 affected species (dli_max sentinel ∪ ec_min sentinel), the Health Engine's range check for
  that one parameter becomes practically always-satisfied — `soilConductivityMinUsCm = -1000` is
  trivially below any real reading, `lightMaxMmol = 99000` (99 mol/day) is above any real Parrot
  Pot reading — functionally similar to nulling the constraint, but stored as if it were a literal
  threshold rather than "no constraint," which matters if this data is ever queried/audited
  directly (Prisma Studio, a future admin UI) rather than only read through the Health Engine's own
  comparison logic. Flagged here explicitly rather than silently accepted.
- **`n_wet == 288` on 8089/8090 species** (the one outlier is 0) — contradicts Batch 6's own
  empirical finding (`docs/HEALTH_ENGINE.md` / this project's CLAUDE.md) that `WET_N=0` is "an
  evidenced default (what the device already ships with)". That empirical read was against a
  **factory-uncalibrated** `PARROT-A073`, never against a device the official app had calibrated —
  so the two findings don't actually contradict each other, they describe different device states.
  288 = 24h ÷ 5min, suggesting a smoothing-window sample count the official app writes at
  calibration time. **Not acted on in this pass** — this project's Plant Dr `calibrateWet` keeps
  writing `n=0` unchanged. The raw value is stored (`wetCalibrationSampleCount`) for future
  reference; confirming whether the official app really writes 288 at calibration time is a BLE
  sniff question (separate, planned next), not something this import should guess into behavior.

## Decisions (confirmed live with DestCom, not assumed)

1. **Source priority on the ~3400 species present in both datasets**: **Parrot's values win** for
   every field Parrot actually provides (soil moisture via `vwc_dry`/`vwc_wet`, temperature,
   light, conductivity) — DestCom's explicit choice, made with full awareness that this changes
   the Health Engine's live status and the Batch 5 auto-watering trigger condition
   (`soilMoisturePercent` status) for already-assigned real devices (`PARROT-A073`,
   `Parrot pot 8733`, etc.) the moment this import runs against production. WatchFlower remains the
   *only* source for soil pH and air humidity — Parrot's dataset has no equivalent fields for
   either, so "Parrot priority" has nothing to override there.
2. **Plant Dr calibration fields are stored now**, even though nothing in Batch 6's `calibrateWet`
   is changed to read them yet — DestCom's explicit choice, to avoid re-deriving/re-extracting this
   data a second time once the BLE-sniff phase clarifies how the official app actually uses
   `vwc_irr`/`vwc_cmd`/eco variants for mode-switching.
3. **Revised after DestCom's explicit correction (2026-08-29, mid-review)**: the free text
   (planting/growth/pruning/harvesting/interesting/description advice, common names) **is**
   committed, across all 7 available locales (DE/EN/ES/FR/IT/JA/ZH), for a future frontend i18n
   effort — DestCom's explicit call, made with full awareness this is proprietary App-Store content
   with no confirmed public redistribution right ("peu importe, on avance quand même comme le
   reste du projet"). Only the numeric threshold/calibration fields were originally planned for
   extraction; this supersedes that narrower scope. See `PlantProfileTranslation` below.
   - **Images are excluded, not a licensing compromise but a factual one**: per-species thumbnails
     are not bundled in the app at all (only 71 generic UI/category images exist locally; the
     `images` field in the encyclopedia dump is a bare filename like `TRE14525_GWI.jpg`, fetched
     from a remote server at view time — `AWSS3.framework` is linked, and the runtime container's
     image cache, checked directly, holds none of them). Each image also carries an individually
     named third-party photographer/agency copyright (`"copyright":{"name":"GWI/Trevor Sims",
     "copyright_url":"www.map-photos.com"}`) distinct from — and more clear-cut than — Parrot's own
     compiled text, so this would be a materially different call even if the files were available
     locally. Recommended to DestCom and not objected to; revisit only if he explicitly asks.
   - **Clarification (DestCom flagged this reads as excluding data, it doesn't)**: "not committed"
     applies to the *raw source files* only — `scientific_data.json`, the 40+MB-per-locale dumps,
     the 44MB `plantsDatabase_FR.sqlite` Core Data file stay wherever DestCom keeps his own copy of
     the app bundle, never checked into git as-is. It says nothing about which *fields* get
     extracted from them — see the filter-taxonomy codes below, which, unlike images, **are**
     extracted and committed (an earlier oversight in this draft, not a considered exclusion).

## Filter-taxonomy codes (`PlantProfileAttribute`)

Originally left out of the extraction — an oversight, not a considered exclusion, flagged by
DestCom during review. The encyclopedia dump's `attributes` field (e.g. `{"FO": ["BR","GR"],
"SF": ["DR"], "PT": ["SH","PE"]}`) is the same filter taxonomy `FilterValues.plist`/
`PlantDetailsInfo.plist` define for the app's own species browser/search UI (plant type, special
features, bloom color, shape, foliage type, height category) — self-describing 2-letter
category/value codes, present for essentially every plant (matches the 91891-row
`ZPLANTATTRIBUTESENTITY` count already seen in the runtime Core Data cache). `attributes_numeric` +
the top-level `attribute_to_number` lookup (90 entries) encode the exact same facts as small
integers instead of codes — redundant with `attributes` for this project's purposes, so only
`attributes` is extracted; `attribute_to_number` itself is not needed.

Stored as a new `PlantProfileAttribute(plantProfileId, category, value)` table — one row per
`(plant, code)` pair, ~90k rows total. **Only the raw 2-letter codes are stored in this pass** —
their human-readable labels (e.g. "BR" → "Broadleaf evergreen") live in
`FilterValues.plist`/`PlantDetailsInfo.plist` (bundle files, different format) cross-referenced
with each locale's `Localizable.strings` (yet another file/format) — a real additional parsing
step, deferred since nothing consumes this data yet either way. Revisit if/when a species
browser/filter UI is actually built.

## Data flow

```
Flower Power.app bundle (DestCom's Mac only, not portable to CI/prod)
  → backend/scripts/extractParrotPlantData.ts   (one-off, manual, run by DestCom locally)
     ├→ backend/prisma/seed-data/parrot_plant_profiles.csv         (committed, ~8090 rows, numeric)
     ├→ backend/prisma/seed-data/parrot_plant_translations.json    (committed, ~8090 × 7 locales,
     │                                                               free text — see below)
     └→ backend/prisma/seed-data/parrot_plant_attributes.json      (committed, ~90k rows, raw
                                                                     filter-taxonomy codes)
  → backend/src/health/importSpeciesProfiles.ts   (automatic, runs on every container boot,
      same as today) — imports WatchFlower CSV as before, then overlays the Parrot numeric CSV
      with priority-merge on matching Latin names (inserting new profiles for the ~4600 species
      only Parrot has), then imports the translations JSON into `PlantProfileTranslation` and the
      attributes JSON into `PlantProfileAttribute`.
```

## Multi-locale text (`PlantProfileTranslation`)

DestCom's explicit correction to the original draft of this spec: the free text (planting advice,
growth habit, pruning, harvesting, "interesting" trivia, description, common name) is committed
too, across all 7 locales the app ships (`DE`/`EN`/`ES`/`FR`/`IT`/`JA`/`ZH` — confirmed by the 7
`{locale}_dump.json.zip` files actually present in the bundle; other `.lproj` folders exist for UI
chrome translation only, no matching plant-content dump). This is for a future frontend i18n
effort — nothing consumes it yet (no tRPC procedure, no UI), same "store ahead of the consumer"
posture as the Plant Dr calibration fields above.

Stored as JSON (`backend/prisma/seed-data/parrot_plant_translations.json`), not CSV — this content
routinely contains semicolons, quotes, HTML markup (`<em>...</em>`) and newlines, unlike the
numeric CSV where a naive `split(';')` was already a safe, confirmed-empirically choice for
WatchFlower's own data. A dedicated `PlantProfileTranslation` table (one row per
`(plantProfileId, locale)` pair) rather than 7×N columns on `PlantProfile` itself — keeps
`PlantProfile` from growing a column per locale per field, and matches how a future i18n table
would naturally be queried (by locale, joined to the profile).

Only species that exist in the encyclopedia dump get translation rows — including the ~3400
species matched to an existing WatchFlower-only profile (they gain translations without their
numeric thresholds changing, if for some reason a match had no scientific profile — not expected
given the confirmed 1:1 join, but the translation import doesn't depend on the numeric overlay
having matched).

**Confirmed empirically against the runtime Core Data cache** (`plantsDatabase_FR.sqlite`'s
`ZPLANTDESCRIPTIONENTITY.ZDESCRIPTIONDATA` — DestCom asked whether this blob's content was actually
captured): decoded the blob for a known plant (id 5642, "Abelia chinensis") — it's plain UTF-8 JSON,
not NSKeyedArchiver/binary-plist as might be expected for a Core Data "transformable" attribute. Its
`planting`/`growth`/`pruning`/`harvesting`/`interesting`/`description.text` fields are byte-for-byte
identical to `FR_dump.json`'s entry for the same id — confirming the JSON dumps are a complete,
verified substitute for this blob (and broader: 7 locales instead of the one the runtime cache
happens to have materialized).

That same decoded blob turned out to be **the entire per-plant JSON object**, not just the
description fields — revealing several more fields worth capturing, added after this check
(DestCom's explicit choice, both groups below):

- **More translated text** (locale-specific, added to `PlantProfileTranslation`): `soil_irr`
  (soil/watering advice prose — distinct from the numeric `vwc_*` thresholds), `pests`, `blooming`,
  `hardiness_zone_min`/`hardiness_zone_max` and `heat_zone_min`/`heat_zone_max` (descriptive danger
  text, e.g. "Elle peut subir des dommages irréversibles quand..."), `light_min`/`light_max` (sun
  exposure in words, e.g. "plein soleil" — distinct from the numeric `dli_min`/`dli_max`).
- **Structural/taxonomic facts** (identical across locales, added as new `PlantProfile` columns —
  from the encyclopedia dump directly, not `scientific_data.json`): `height_min`/`height_max`,
  `spread_min`/`spread_max` (plant size in cm), `hardiness_zone_min_value`/`max_value` and
  `heat_zone_min_value`/`max_value` (USDA-style zone codes, given as strings e.g. `"7"`), `t_dying`
  (°C, irreversible cold-damage threshold), `popularity`, `genus_name`, `latin_name`,
  `taxonomy_group_id`, `tags`, `no_fert`.

The extraction script is **not** part of `docker-entrypoint.sh` — it depends on files that exist
only on DestCom's Mac (`/Applications/Flower Power.app`), never on the Linux production server or
in CI. Its committed *output* (the distilled CSV) is what the automatic importer consumes, exactly
like the WatchFlower CSV today (except fetched from a local repo path instead of a public URL,
since there is no public URL for this source).

## Matching rule (Parrot ↔ WatchFlower)

Normalize both sides' Latin name (case-insensitive, unify `×`/`x` spacing, collapse whitespace) and
match exactly. **No fuzzy/synonym matching in this pass** — a Parrot cultivar entry like `Abelia x
'Edward Goucher'` will not match WatchFlower's more generic `Abelia × grandiflora` (correct: they
are genuinely different, more specific taxa) and becomes a new profile, matching the encyclopedia
dump's own species/cultivar granularity. A future pass could add synonym-aware matching using the
encyclopedia dump's `synonyms`/`common_names` fields if this proves to miss too many real matches —
not attempted here (YAGNI without evidence it's needed).

## Schema changes (Prisma)

New nullable `PlantProfile` columns, all `Float?` unless noted:
- `soilMoistureIrrigatePercent` (`vwc_irr`) — no current equivalent field.
- `soilMoistureCommandPercent` (`vwc_cmd`) — no current equivalent field.
- `soilMoistureIrrigateEcoPercent` (`vwc_irr_eco`)
- `soilMoistureCommandEcoPercent` (`vwc_cmd_eco`)
- `wetCalibrationSampleCount` (`Int?`, `n_wet`) — raw, unconsumed, kept for the anomaly noted above.
- `parrotSpeciesId` (`Int? @unique`) — the source `id`, so re-running the extraction/import after a
  future Parrot data refresh can upsert by id instead of only by name.

Additional structural/taxonomic `PlantProfile` columns (from the "entire object" finding above —
same across locales, sourced from the encyclopedia dump directly, not `scientific_data.json`):
- `heightMinCm`/`heightMaxCm` (`Float?`, `height_min`/`height_max`)
- `spreadMinCm`/`spreadMaxCm` (`Float?`, `spread_min`/`spread_max`)
- `hardinessZoneMinValue`/`hardinessZoneMaxValue` (`String?`, e.g. `"7"` — kept as a string, not
  parsed to a number, since the source gives it as one and a non-numeric zone code can't be ruled
  out without checking every one of 8090 rows)
- `heatZoneMinValue`/`heatZoneMaxValue` (`String?`, same reasoning)
- `tDyingC` (`Float?`, `t_dying`)
- `popularity` (`Int?`)
- `genusName` (`String?`)
- `latinName` (`String?`, `latin_name` — kept distinct from `name`/`fullname` even though they were
  identical in the one example checked; not verified identical across all 8090 rows)
- `taxonomyGroupId` (`Int?`)
- `tags` (`Int?`, purpose not decoded — kept raw)
- `noFert` (`Boolean?`, `no_fert`)

`soilMoistureMinPercent`/`soilMoistureMaxPercent`/`soilConductivityMinUsCm`/`MaxUsCm`/
`temperatureMinC`/`MaxC`/`lightMinMmol`/`MaxMmol` are **existing** columns — Parrot's
`vwc_dry`/`vwc_wet`/`ec_min×1000`/`ec_max×1000`/`adt_min`/`adt_max`/`dli_min×1000`/`dli_max×1000`
flow into these directly (no new columns) for matched/new species, per the priority decision above.
`n_dry` is not stored — it is 0 for essentially every species (no informational content, no current
consumer) — can be added later if a reason emerges.

New model:

```prisma
model PlantProfileTranslation {
  id                   Int          @id @default(autoincrement())
  plantProfileId       Int
  locale               String       // 'DE' | 'EN' | 'ES' | 'FR' | 'IT' | 'JA' | 'ZH'
  commonName           String?
  description          String?
  planting             String?
  growth               String?
  pruning              String?
  harvesting           String?
  interesting          String?
  soilIrr              String?
  pests                String?
  blooming             String?
  hardinessZoneMinText String?
  hardinessZoneMaxText String?
  heatZoneMinText      String?
  heatZoneMaxText      String?
  lightMinText         String?
  lightMaxText         String?
  plantProfile         PlantProfile @relation(fields: [plantProfileId], references: [id])

  @@unique([plantProfileId, locale])
}
```

`PlantProfile` gains `translations PlantProfileTranslation[]` and `attributes
PlantProfileAttribute[]`:

```prisma
model PlantProfileAttribute {
  id             Int          @id @default(autoincrement())
  plantProfileId Int
  category       String       // 2-letter code, e.g. 'FO' (foliage type), 'SF' (special feature)
  value          String       // 2-letter code, e.g. 'BR', 'DR'
  plantProfile   PlantProfile @relation(fields: [plantProfileId], references: [id])

  @@unique([plantProfileId, category, value])
  @@index([category, value])
}
```

## A related, deferred finding: `locationsDatabase.sqlite` (real device data, not plant data)

While locating `samples.sqlite`/`locationsDatabase.sqlite` (DestCom's own request, checked
alongside this plant-DB work), the app's runtime container (not the read-only bundle —
`~/Library/Containers/com.parrot.flowerpower/Data/Documents/`) turned out to hold real, small,
already-populated data about DestCom's own 3 real Parrot Pots (`PARROT-A073`, the 2nd original pot
`A3D3`, and the newly-acquired `8733` — all 3 already known to this project). Two concrete leads
worth acting on, **deliberately not part of this plan** — they belong to the BLE-sniff/official-app
-behavior investigation DestCom already sequenced as the *next* phase after this one, not the plant
database:

- `ZSENSORENTITY.ZCALIBRATIONDATA` — a real hex blob for the `39e1fe01` Calibration-service
  characteristic (2 samples, for devices whose `DRY_VWC`/`WET_VWC` this project already knows from
  Batch 6), currently logged only as an undecoded raw blob (`RawSensorLog`). Real reference data to
  attempt decoding against, whenever that phase starts.
- `ZSENSORAUTOWATERINGCFGENTITY` — confirms the official app's watering-mode selection
  (auto/eco/manual/etc.) is just a per-sensor config row (`ZMODE` integer, `ZVWCCMD`/`ZVWCIRR`
  floats, an allowed-hours window, a vacation end date) rather than a different protocol per mode —
  but all 3 of DestCom's sensors currently show `ZMODE=1`, not enough variation to know which
  integer maps to which named mode without either changing the mode in the app and re-reading, or
  the planned BLE sniff.
- `samples.sqlite` (historical sensor cache) was checked too and is completely empty — DestCom
  hasn't yet let the official app sync real history from a paired device long enough to populate it.

## Final field audit — every key in both source files accounted for

DestCom asked directly whether every Flower Power data point (bar images) was now captured.
Answered by taking the exhaustive union of every key across all 8090 plants in both source files
(not a sample) and cross-checking each one — this found real gaps beyond the ones already listed
above, now closed:

**More translated text** (`PlantProfileTranslation`): `fertilizer` (top-level free text — real
content on 5388/8090 species, distinct from the ordinal `characteristics.fertilizer` below —
initially missed because the one sample checked happened to have it null), `detail_care` (378/8090,
extra care notes distinct from planting/growth/pruning), `nameFirstLetter`, `orderIndexForSorting`
(confirmed empirically to differ between `EN_dump.json` and `FR_dump.json` for the same plant — a
locale's own alphabetical-sort aids based on its localized common name, not structural).

**More structural/taxonomic `PlantProfile` columns** (confirmed identical between `EN_dump.json`
and `FR_dump.json` for the same plant, checked directly rather than assumed):
`nameFirstLetterLatin`, `orderIndexForSortingLatin` (Latin-name-based, unlike their non-`Latin`
counterparts above), `synonyms`, `hidden`, `is_taxonomy_group_head`,
`taxonomy_group_subelements_count`, `species_name`, `subspecies_name`, `n_irr`/`n_irr_eco` (from
`scientific_data.json` — vary meaningfully, 0/384/672, the same class of finding as `n_wet=288`),
`characteristics.sun`/`.water`/`.fertilizer` (ordinal 1-4 categories — a coarse categorical view
distinct from the precise numeric thresholds; `characteristics.temperature_min/max_celsius` from
the same object is **not** separately stored, confirmed redundant with `scientific_data.json`'s
`adt_min`/`adt_max`, already captured).

**New tables**: `fertilizer_type` (array of small ints per plant, confirmed identical across
locales) → `PlantProfileFertilizerType(plantProfileId, code)`, same shape as
`PlantProfileAttribute`. `searchNames` (confirmed **locale-dependent** — an array of
`{name, type}`, `type` 0=common name/1=Latin name/2=cultivar/3=synonym, present on all 8090 plants,
overlapping but not identical to `common_names`/`synonyms`) → `PlantProfileSearchName(plantProfileId,
locale, name, type)`.

**`attributes_numeric`/`attribute_to_number` — deliberately stored but never to be consumed**:
checked whether `attribute_to_number` (the lookup used to decode `attributes_numeric`) is the same
across locales, expecting it to be (it looked like an internal enum). It is **not** — 64 of its 90
entries have a different number in `FR_dump.json` than in `EN_dump.json` (e.g. `"PT-FE"` is 80 in
EN, 79 in FR). `attributes_numeric` is therefore only meaningful when decoded against the *same
locale's* `attribute_to_number` — storing it as if it were a fixed, universal fact (as every other
structural field above is) would silently misrepresent it, the same class of mistake as
WatchFlower's borrowed `RAW_MIN` constant that clamped real soil-conductivity readings before this
project's own self-calibration work fixed it. DestCom's explicit call after seeing this: store both
anyway, scoped correctly per locale (`PlantAttributeNumberMapping(locale, code, number)`,
`PlantProfileAttributeNumber(plantProfileId, locale, number)`), and never read them from any
consumer — `attributes` (the string-coded version, confirmed locale-independent) remains the only
one anything is allowed to actually use. Documented here so this constraint isn't forgotten if
someone reaches for `attributes_numeric` later.

**Confirmed excluded, correctly, no further action**: `images` (external host, individually
copyrighted — DestCom's own explicit call, see above). Nothing else from either source file's key
union remains unaccounted for.

## Explicit non-goals for this pass

- No change to `backend/src/plantDr.ts` / `calibrateWet` — the new calibration fields are stored,
  not consumed.
- No change to the Health Engine's scoring logic itself — only the *data* driving it changes for
  matched species. `computeDeviceHealth` keeps reading the same `PlantProfile` columns it already
  reads.
- No synonym/fuzzy species matching.
- No automatic re-fetch mechanism for future Parrot app updates — this is a one-time enrichment
  from the version DestCom has installed today (`4.6.3`, encyclopedia `4.0.8`); a future refresh
  would be a manual re-run of the same extraction script.
- **No images** — confirmed with DestCom: since per-species thumbnails are fetched from an
  external host (S3/CDN) rather than bundled in the app, and individually copyrighted per
  photographer/agency, they're excluded outright, not just deferred.
- No frontend/tRPC consumer for `PlantProfileTranslation`/`PlantProfileAttribute` — storage only,
  ahead of a future i18n/species-browser effort that doesn't exist yet.
- No human-readable label resolution for `PlantProfileAttribute`'s codes — the codes themselves are
  extracted, their `FilterValues.plist`/`Localizable.strings`-sourced labels are not (see above).
- No action on the `locationsDatabase.sqlite` findings (calibration blob, `ZMODE` values) — noted
  above as a lead for the next, separately-sequenced phase.
- **`dli_max`/`ec_min` sentinel-like values are kept raw, not nulled** — DestCom's explicit choice
  after reviewing the sun/water-category correlation evidence above, accepting the documented
  consequence that the Health Engine's range check becomes practically toothless (not literally
  absent) for the affected parameter on the ~5300 affected species.
