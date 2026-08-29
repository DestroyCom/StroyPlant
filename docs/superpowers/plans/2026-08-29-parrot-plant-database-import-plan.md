# Parrot Plant Database Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import Parrot's own manufacturer-calibrated plant database (8090 species, extracted from
the official "Flower Power" iOS app bundle) into `PlantProfile`, taking priority over the existing
WatchFlower CSV data for every field Parrot provides — and, per DestCom's explicit request after
an exhaustive audit of every key in both source files, capture literally everything else the
source data contains except images (fetched from an external host at view time, individually
copyrighted per photographer/agency — the one exclusion, confirmed with DestCom): Plant Dr
irrigation/eco-mode calibration data, free text in all 7 available locales, filter-taxonomy
attribute codes, fertilizer-type codes, per-locale search names, and — stored but explicitly never
to be read by any consumer, since it's confirmed locale-relative — the `attributes_numeric`/
`attribute_to_number` archival pair.

**Architecture:** A one-off local extraction script (run manually on DestCom's Mac, where the app
bundle lives) distills the source JSON dumps into 7 committed artifacts. The existing
`importSpeciesProfiles.ts` (already runs on every backend boot, unchanged trigger) gains 6 further
independently-idempotent steps, each gated on its own target table being empty rather than on
`plant_profiles` as a whole: one overlays the numeric/structural CSV onto whatever WatchFlower
already imported (matching by a normalized Latin name), the rest import the remaining files keyed
off the `parrotSpeciesId` that overlay step just assigned to every matched/created `PlantProfile`
row.

**Tech Stack:** TypeScript, Prisma/SQLite, Node's built-in `node:test` (this repo's only test
runner, see `backend/package.json`'s `test` script), `unzip`/`jq`-equivalent parsing via plain
`JSON.parse` (no new npm dependency).

**Spec:** `docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md` — read this
first, it has the full rationale for every decision below (source priority, sentinel handling,
unit conversions, why the raw dumps aren't committed).

## Global Constraints

- `pnpm` exclusively, never `npm`/`yarn` (`backend/CLAUDE.md` root rule).
- No new runtime dependency for zip/JSON handling — the extraction script shells out to the
  system `unzip` (already required as a dev tool on DestCom's Mac; this script never runs in
  Docker/CI).
- Every pure function (normalization, sentinel handling, CSV row parse/format, match resolution)
  lives in `backend/src/health/parrotPlantData.ts` so it is covered by the existing test glob
  (`backend/package.json`'s `"test": "tsx --test 'src/inference/**/*.test.ts'
  'src/health/**/*.test.ts'"`) — `backend/scripts/` is not covered by that glob and must stay a
  thin I/O wrapper with no independently-meaningful logic of its own.
- `soilPhMin`/`soilPhMax`/`humidityMinPercent`/`humidityMaxPercent`/`lightMinLux`/`lightMaxLux`
  are never touched by the Parrot overlay (Parrot's dataset has no equivalent fields) — only
  WatchFlower ever sets them.
- The Parrot overlay step must be independently idempotent from the WatchFlower import step (the
  existing `existingCount > 0` gate in `importSpeciesProfiles.ts` would otherwise permanently skip
  the new step on every production database that already has WatchFlower rows).
- `PlantAttributeNumberMapping` and `PlantProfileAttributeNumber` are archival only — confirmed
  empirically that `attribute_to_number` differs by locale (64/90 codes have a different number
  between `EN_dump.json` and `FR_dump.json`), so no code anywhere may read either model as if it
  were a universal fact. `PlantProfileAttribute` (locale-independent string codes) is the only
  supported way to read a plant's attributes.

---

## File structure

- Modify: `backend/prisma/schema.prisma` — new `PlantProfile` columns + 6 new models
  (`PlantProfileTranslation`, `PlantProfileAttribute`, `PlantProfileFertilizerType`,
  `PlantProfileSearchName`, and the archival-only `PlantAttributeNumberMapping`/
  `PlantProfileAttributeNumber` pair).
- Create: `backend/prisma/seed-data/parrot_plant_profiles.csv` — committed, distilled numeric +
  structural/taxonomic output of the extraction script (Task 3's manual run).
- Create: `backend/prisma/seed-data/parrot_plant_translations.json` — committed, all 7 locales'
  free text (planting/growth/pruning/harvesting/interesting/description/fertilizer/detail_care/
  common name/nameFirstLetter/orderIndexForSorting), one array entry per `(plantProfileId source
  id, locale)` pair. No images (see spec: not bundled locally, individually copyrighted by
  external photographers/agencies — excluded outright, confirmed with DestCom).
- Create: `backend/prisma/seed-data/parrot_plant_attributes.json`,
  `parrot_plant_fertilizer_types.json`, `parrot_plant_search_names.json`,
  `parrot_attribute_number_mapping.json`, `parrot_plant_attribute_numbers.json` — committed,
  covering every remaining field found during the exhaustive final field audit (see spec).
- Create: `backend/src/health/parrotPlantData.ts` — pure logic: normalization, sentinel/unit
  conversion, CSV row parse/format, match resolution.
- Create: `backend/src/health/parrotPlantData.test.ts` — tests for the above.
- Create: `backend/scripts/extractParrotPlantData.ts` — one-off local script, reads all 9 zips
  from the app bundle (2 for numeric data + 7 locale dumps for everything locale-dependent), writes
  7 committed artifacts (numeric CSV, translations, attributes, fertilizer types, search names,
  and the archival attribute-number mapping/numbers pair).
- Modify: `backend/src/health/importSpeciesProfiles.ts` — split into `importWatchFlowerProfiles()`
  (existing logic, renamed, behavior preserved), `importParrotOverlay()` (numeric),
  `importParrotTranslations()` (text), `importParrotAttributes()`, `importParrotFertilizerTypes()`,
  `importParrotSearchNames()`, and `importParrotAttributeNumbers()` (archival) — all seven called
  from `main()`.
- Modify: `backend/package.json` — new `"extract:parrot-plants"` script.
- Modify: `/Users/destcom/Documents/PERSO/StroyPlant/CLAUDE.md` — project status entry (Task 9).

---

### Task 1: Prisma schema migration

**Files:**
- Modify: `backend/prisma/schema.prisma:112-133` (the `PlantProfile` model)
- Create: migration via `pnpm prisma:migrate` (generates
  `backend/prisma/migrations/<timestamp>_add_parrot_plant_data/migration.sql`)

**Interfaces:**
- Produces: 8 new nullable `PlantProfile` scalar columns for Plant Dr calibration
  (`soilMoistureIrrigatePercent`, `soilMoistureCommandPercent`, `soilMoistureIrrigateEcoPercent`,
  `soilMoistureCommandEcoPercent`, `wetCalibrationSampleCount`, `irrigateCalibrationSampleCount`,
  `irrigateEcoCalibrationSampleCount`, `parrotSpeciesId`) plus 28 structural/taxonomic ones
  (`heightMinCm`, `heightMaxCm`, `spreadMinCm`, `spreadMaxCm`, `hardinessZoneMinValue`,
  `hardinessZoneMaxValue`, `heatZoneMinValue`, `heatZoneMaxValue`, `tDyingC`, `popularity`,
  `genusName`, `speciesName`, `subspeciesName`, `latinName`, `taxonomyGroupId`,
  `isTaxonomyGroupHead`, `taxonomyGroupSubelementsCount`, `tags`, `noFert`, `hidden`, `synonyms`,
  `nameFirstLetterLatin`, `orderIndexForSortingLatin`, `sunCategory`, `waterCategory`,
  `fertilizerCategory`), consumed by Task 2/4's TypeScript code by exact name. Also produces 5 new
  models: `PlantProfileTranslation` (locale-scoped free text, 20 scalar fields, consumed by
  Task 5), `PlantProfileAttribute` (filter-taxonomy codes, consumed by Task 6),
  `PlantProfileFertilizerType` (consumed by Task 7), `PlantProfileSearchName` (locale-scoped,
  consumed by Task 7), and the archival-only `PlantAttributeNumberMapping`/
  `PlantProfileAttributeNumber` pair (consumed by Task 7, never by anything else — see their
  code comments).

- [ ] **Step 1: Edit the model**

In `backend/prisma/schema.prisma`, replace the `PlantProfile` model body:

```prisma
model PlantProfile {
  id         Int     @id @default(autoincrement())
  name       String  @unique
  commonName String?

  soilMoistureMinPercent  Float?
  soilMoistureMaxPercent  Float?
  soilConductivityMinUsCm Float?
  soilConductivityMaxUsCm Float?
  soilPhMin               Float?
  soilPhMax               Float?
  temperatureMinC         Float?
  temperatureMaxC         Float?
  humidityMinPercent      Float?
  humidityMaxPercent      Float?
  lightMinLux             Float?
  lightMaxLux             Float?
  lightMinMmol            Float?
  lightMaxMmol            Float?

  // Parrot-specific Plant Dr / watering-mode calibration data (source: the official Flower Power
  // app's scientific_data.json, see docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md).
  // Not yet consumed by backend/src/plantDr.ts — stored ahead of time so a future BLE-sniff-informed
  // change doesn't need to re-extract this data.
  soilMoistureIrrigatePercent    Float?
  soilMoistureCommandPercent     Float?
  soilMoistureIrrigateEcoPercent Float?
  soilMoistureCommandEcoPercent  Float?
  wetCalibrationSampleCount      Int?
  irrigateCalibrationSampleCount    Int?
  irrigateEcoCalibrationSampleCount Int?
  parrotSpeciesId                Int?    @unique

  // Structural/taxonomic facts, identical across locales — from the encyclopedia dump directly
  // (not scientific_data.json). Found while confirming ZPLANTDESCRIPTIONENTITY.ZDESCRIPTIONDATA's
  // content was fully captured — that Core Data blob turned out to hold the entire per-plant JSON
  // object, not just its description fields — and then via an exhaustive key-by-key audit of both
  // source files after DestCom asked to confirm nothing was still missing. See the spec's "Two
  // anomalies" and "Final field audit" sections.
  heightMinCm                   Float?
  heightMaxCm                   Float?
  spreadMinCm                   Float?
  spreadMaxCm                   Float?
  hardinessZoneMinValue         String?
  hardinessZoneMaxValue         String?
  heatZoneMinValue              String?
  heatZoneMaxValue              String?
  tDyingC                       Float?
  popularity                    Int?
  genusName                     String?
  speciesName                   String?
  subspeciesName                String?
  latinName                     String?
  taxonomyGroupId                  Int?
  isTaxonomyGroupHead              Boolean?
  taxonomyGroupSubelementsCount    Int?
  tags                          Int?
  noFert                         Boolean?
  hidden                         Boolean?
  synonyms                       String?
  nameFirstLetterLatin           String?
  orderIndexForSortingLatin      Int?
  sunCategory                    Int?
  waterCategory                  Int?
  fertilizerCategory             Int?

  devices          Device[]
  translations     PlantProfileTranslation[]
  attributes       PlantProfileAttribute[]
  fertilizerTypes  PlantProfileFertilizerType[]
  searchNames      PlantProfileSearchName[]
  attributeNumbers PlantProfileAttributeNumber[]
}

// Multi-locale free text from the same Flower Power app source (planting/growth/pruning/
// harvesting/interesting/description advice, common name per language) — stored ahead of a future
// frontend i18n effort, no consumer yet. See docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md.
model PlantProfileTranslation {
  id                   Int          @id @default(autoincrement())
  plantProfileId       Int
  locale               String
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
  fertilizerText       String?
  detailCare           String?
  nameFirstLetter      String?
  orderIndexForSorting Int?
  plantProfile         PlantProfile @relation(fields: [plantProfileId], references: [id])

  @@unique([plantProfileId, locale])
}

// Filter-taxonomy codes (plant type, special features, bloom color, shape, foliage type, height
// category) from the same encyclopedia dump's `attributes` field — raw 2-letter codes only, no
// human-readable label resolution yet (lives in FilterValues.plist/Localizable.strings, a
// different file format, deferred until a consumer needs it). See the spec's "Filter-taxonomy
// codes" section.
model PlantProfileAttribute {
  id             Int          @id @default(autoincrement())
  plantProfileId Int
  category       String
  value          String
  plantProfile   PlantProfile @relation(fields: [plantProfileId], references: [id])

  @@unique([plantProfileId, category, value])
  @@index([category, value])
}

// `fertilizer_type` — a small array of category codes per plant, confirmed identical across
// locales, same shape/reasoning as PlantProfileAttribute above.
model PlantProfileFertilizerType {
  id             Int          @id @default(autoincrement())
  plantProfileId Int
  code           Int
  plantProfile   PlantProfile @relation(fields: [plantProfileId], references: [id])

  @@unique([plantProfileId, code])
}

// `searchNames` — confirmed locale-dependent (the "name" text differs per language), unlike every
// other array-of-codes field above. `type`: 0 = common name, 1 = Latin name, 2 = cultivar,
// 3 = synonym (inferred from the data, not documented by Parrot).
model PlantProfileSearchName {
  id             Int          @id @default(autoincrement())
  plantProfileId Int
  locale         String
  name           String
  type           Int
  plantProfile   PlantProfile @relation(fields: [plantProfileId], references: [id])

  @@unique([plantProfileId, locale, type, name])
}

// Archival only, per the spec's "attributes_numeric/attribute_to_number" decision:
// attribute_to_number is confirmed locale-relative (64/90 codes have a different number between
// EN and FR), so PlantProfileAttributeNumber's `number` column is only meaningful when decoded
// against THIS SAME table's matching `locale` row — nothing may ever read either of these two
// models. PlantProfileAttribute (locale-independent string codes) is the only supported way to
// read a plant's attributes; these two exist solely so the raw data isn't lost.
model PlantAttributeNumberMapping {
  id     Int    @id @default(autoincrement())
  locale String
  code   String
  number Int

  @@unique([locale, code])
}

model PlantProfileAttributeNumber {
  id             Int          @id @default(autoincrement())
  plantProfileId Int
  locale         String
  number         Int
  plantProfile   PlantProfile @relation(fields: [plantProfileId], references: [id])

  @@unique([plantProfileId, locale, number])
}
```

- [ ] **Step 2: Generate and apply the migration**

Run: `cd backend && pnpm prisma:migrate --name add_parrot_plant_data`
Expected: creates `prisma/migrations/<timestamp>_add_parrot_plant_data/migration.sql` with 6
`ALTER TABLE "PlantProfile" ADD COLUMN` statements, applies it to `backend/prisma/dev.db`, and
regenerates the Prisma client (no errors).

- [ ] **Step 3: Verify the client picked up the new fields**

Run: `cd backend && node -e "const {PrismaClient} = require('@prisma/client'); const p = new PrismaClient(); p.plantProfile.findFirst().then(r => { console.log(Object.keys(r || {})); process.exit(0); })"`
Expected: if any row exists, the printed keys include `soilMoistureIrrigatePercent`,
`parrotSpeciesId`, etc. (if `dev.db` is empty, this prints `[]` for `r === null` — acceptable, the
important check is that the command doesn't throw a Prisma validation error).

- [ ] **Step 4: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations
git commit -m "feat(backend): add PlantProfile columns for Parrot Plant Dr calibration data"
```

---

### Task 2: Pure logic module — `parrotPlantData.ts`

**Files:**
- Create: `backend/src/health/parrotPlantData.ts`
- Test: `backend/src/health/parrotPlantData.test.ts`

**Interfaces:**
- Consumes: nothing (pure, no imports from the rest of the codebase).
- Produces (consumed by Task 3 and Task 4):
  - `normalizeLatinName(name: string): string`
  - `ParrotEncyclopediaEntry` — `id`/`fullname`/`common_names` plus the structural/taxonomic fields
    found while decoding `ZPLANTDESCRIPTIONENTITY.ZDESCRIPTIONDATA` (`height_min`/`max`,
    `spread_min`/`max`, `hardiness_zone_min_value`/`max_value`, `heat_zone_min_value`/`max_value`,
    `t_dying`, `popularity`, `genus_name`, `latin_name`, `taxonomy_group_id`, `tags`, `no_fert`) —
    see the full interface in Step 3's code below.
  - `type ParrotScientificProfile = { dli_min?: number; dli_max?: number; adt_min?: number; adt_max?: number; ec_min?: number; ec_max?: number; vwc_dry?: number; vwc_wet?: number; vwc_irr?: number; vwc_cmd?: number; vwc_irr_eco?: number; vwc_cmd_eco?: number; n_wet?: number }`
  - `ParrotPlantRow` — the CSV-row shape of `ParrotEncyclopediaEntry` + `ParrotScientificProfile`
    combined, camelCased; full shape in Step 3's code below.
  - `buildParrotPlantRow(entry: ParrotEncyclopediaEntry, profile: ParrotScientificProfile): ParrotPlantRow`
  - `PARROT_CSV_COLUMNS: readonly string[]` (44 CSV column names, in order)
  - `formatParrotCsvRow(row: ParrotPlantRow): string`
  - `parseParrotCsvLine(line: string): ParrotPlantRow`
  - `resolveMatchId(name: string, existingByNormalizedName: ReadonlyMap<string, number>): number | undefined`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/health/parrotPlantData.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildParrotPlantRow,
  formatParrotCsvRow,
  normalizeLatinName,
  parseParrotCsvLine,
  resolveMatchId,
} from './parrotPlantData.js';

describe('normalizeLatinName', () => {
  it('unifies the multiplication sign and case', () => {
    assert.equal(normalizeLatinName('Abelia × grandiflora'), normalizeLatinName('Abelia x grandiflora'));
  });

  it('collapses repeated whitespace and trims', () => {
    assert.equal(normalizeLatinName('  Abelia   grandiflora '), 'abelia grandiflora');
  });

  it('does not merge genuinely different cultivars', () => {
    assert.notEqual(
      normalizeLatinName("Abelia x 'Edward Goucher'"),
      normalizeLatinName('Abelia x grandiflora'),
    );
  });
});

describe('buildParrotPlantRow', () => {
  it('converts EC from mS/cm to µS/cm', () => {
    const row = buildParrotPlantRow(
      { id: 2, fullname: 'Abelia x grandiflora' },
      { ec_min: 0.5, ec_max: 5 },
    );
    assert.equal(row.soilConductivityMinUsCm, 500);
    assert.equal(row.soilConductivityMaxUsCm, 5000);
  });

  it('converts DLI from mol/day to mmol/day', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { dli_min: 5, dli_max: 20 });
    assert.equal(row.lightMinMmol, 5000);
    assert.equal(row.lightMaxMmol, 20000);
  });

  it('passes dli_max=99 through unit-converted, unchanged — a category-level default kept raw rather than nulled (DestCom, after reviewing the sun-category correlation evidence)', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { dli_min: 5, dli_max: 99 });
    assert.equal(row.lightMaxMmol, 99000);
  });

  it('passes ec_min=-1 through unit-converted, unchanged — same raw-not-nulled decision', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { ec_min: -1, ec_max: 3 });
    assert.equal(row.soilConductivityMinUsCm, -1000);
    assert.equal(row.soilConductivityMaxUsCm, 3000);
  });

  it('maps vwc_dry/vwc_wet to soil moisture min/max unchanged (already percent)', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, { vwc_dry: 32, vwc_wet: 66 });
    assert.equal(row.soilMoistureMinPercent, 32);
    assert.equal(row.soilMoistureMaxPercent, 66);
  });

  it('maps the irrigation/command/eco fields and sample count unchanged', () => {
    const row = buildParrotPlantRow(
      { id: 2, fullname: 'X' },
      { vwc_irr: 32, vwc_cmd: 38, vwc_irr_eco: 26, vwc_cmd_eco: 32, n_wet: 288 },
    );
    assert.equal(row.soilMoistureIrrigatePercent, 32);
    assert.equal(row.soilMoistureCommandPercent, 38);
    assert.equal(row.soilMoistureIrrigateEcoPercent, 26);
    assert.equal(row.soilMoistureCommandEcoPercent, 32);
    assert.equal(row.wetCalibrationSampleCount, 288);
  });

  it('picks the preferred common name when present', () => {
    const row = buildParrotPlantRow(
      {
        id: 2,
        fullname: 'X',
        common_names: [
          { common_name: 'Not preferred' },
          { common_name: 'Chinese Abelia', preferred: true },
        ],
      },
      {},
    );
    assert.equal(row.commonName, 'Chinese Abelia');
  });

  it('leaves fields null when the source has no value at all', () => {
    const row = buildParrotPlantRow({ id: 2, fullname: 'X' }, {});
    assert.equal(row.soilMoistureMinPercent, null);
    assert.equal(row.temperatureMinC, null);
    assert.equal(row.commonName, null);
  });

  it('maps the structural/taxonomic fields from the encyclopedia entry unchanged', () => {
    const row = buildParrotPlantRow(
      {
        id: 2,
        fullname: 'X',
        height_min: 150,
        height_max: 185,
        spread_min: 195,
        spread_max: 295,
        hardiness_zone_min_value: '7',
        hardiness_zone_max_value: '9',
        heat_zone_min_value: '7',
        heat_zone_max_value: '9',
        t_dying: -12,
        popularity: 330,
        genus_name: 'Abelia',
        species_name: 'chinensis',
        subspecies_name: undefined,
        latin_name: 'Abelia chinensis',
        taxonomy_group_id: 1358,
        is_taxonomy_group_head: true,
        taxonomy_group_subelements_count: 0,
        tags: 164,
        no_fert: false,
        hidden: false,
        synonyms: 'Abelia rupestris',
        nameFirstLetterLatin: 'A',
        orderIndexForSortingLatin: 0,
        characteristics: { sun: 3, water: 2, fertilizer: 1 },
      },
      { n_irr: 0, n_irr_eco: 0 },
    );
    assert.equal(row.heightMinCm, 150);
    assert.equal(row.heightMaxCm, 185);
    assert.equal(row.spreadMinCm, 195);
    assert.equal(row.spreadMaxCm, 295);
    assert.equal(row.hardinessZoneMinValue, '7');
    assert.equal(row.hardinessZoneMaxValue, '9');
    assert.equal(row.heatZoneMinValue, '7');
    assert.equal(row.heatZoneMaxValue, '9');
    assert.equal(row.tDyingC, -12);
    assert.equal(row.popularity, 330);
    assert.equal(row.genusName, 'Abelia');
    assert.equal(row.speciesName, 'chinensis');
    assert.equal(row.subspeciesName, null);
    assert.equal(row.latinName, 'Abelia chinensis');
    assert.equal(row.taxonomyGroupId, 1358);
    assert.equal(row.isTaxonomyGroupHead, true);
    assert.equal(row.taxonomyGroupSubelementsCount, 0);
    assert.equal(row.tags, 164);
    assert.equal(row.noFert, false);
    assert.equal(row.hidden, false);
    assert.equal(row.synonyms, 'Abelia rupestris');
    assert.equal(row.nameFirstLetterLatin, 'A');
    assert.equal(row.orderIndexForSortingLatin, 0);
    assert.equal(row.sunCategory, 3);
    assert.equal(row.waterCategory, 2);
    assert.equal(row.fertilizerCategory, 1);
    assert.equal(row.irrigateCalibrationSampleCount, 0);
    assert.equal(row.irrigateEcoCalibrationSampleCount, 0);
  });
});

describe('formatParrotCsvRow / parseParrotCsvLine round trip', () => {
  it('round-trips a fully populated row, including the structural fields and a false boolean', () => {
    const row = buildParrotPlantRow(
      {
        id: 2,
        fullname: 'Abelia x grandiflora',
        common_names: [{ common_name: 'Abelia', preferred: true }],
        height_min: 150,
        height_max: 185,
        spread_min: 195,
        spread_max: 295,
        hardiness_zone_min_value: '7',
        hardiness_zone_max_value: '9',
        heat_zone_min_value: '7',
        heat_zone_max_value: '9',
        t_dying: -12,
        popularity: 330,
        genus_name: 'Abelia',
        species_name: 'chinensis',
        latin_name: 'Abelia chinensis',
        taxonomy_group_id: 1358,
        is_taxonomy_group_head: true,
        taxonomy_group_subelements_count: 0,
        tags: 164,
        no_fert: false,
        hidden: false,
        synonyms: 'Abelia rupestris',
        nameFirstLetterLatin: 'A',
        orderIndexForSortingLatin: 0,
        characteristics: { sun: 3, water: 2, fertilizer: 1 },
      },
      {
        dli_min: 5,
        dli_max: 20,
        adt_min: 7,
        adt_max: 40,
        ec_min: 0.5,
        ec_max: 5,
        vwc_dry: 32,
        vwc_wet: 66,
        vwc_irr: 32,
        vwc_cmd: 38,
        vwc_irr_eco: 26,
        vwc_cmd_eco: 32,
        n_wet: 288,
        n_irr: 384,
        n_irr_eco: 672,
      },
    );
    const parsed = parseParrotCsvLine(formatParrotCsvRow(row));
    assert.deepEqual(parsed, row);
    // false must survive the round trip distinctly from null (both serialize to falsy-looking text)
    assert.equal(parsed.noFert, false);
    assert.equal(parsed.hidden, false);
  });

  it('round-trips a row full of nulls', () => {
    const row = buildParrotPlantRow({ id: 7, fullname: 'X' }, {});
    const parsed = parseParrotCsvLine(formatParrotCsvRow(row));
    assert.deepEqual(parsed, row);
    assert.equal(parsed.noFert, null);
  });
});

describe('resolveMatchId', () => {
  it('finds an existing profile by normalized name regardless of the × / x spelling', () => {
    const existing = new Map([[normalizeLatinName('Abelia × grandiflora'), 42]]);
    assert.equal(resolveMatchId('Abelia x grandiflora', existing), 42);
  });

  it('returns undefined for a name with no match', () => {
    const existing = new Map([[normalizeLatinName('Abelia × grandiflora'), 42]]);
    assert.equal(resolveMatchId("Abelia x 'Edward Goucher'", existing), undefined);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pnpm test`
Expected: FAIL — `Cannot find module './parrotPlantData.js'` (the module doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `backend/src/health/parrotPlantData.ts`:

```typescript
// Parrot's official plant database, extracted from the "Flower Power" iOS app's bundled
// scientific_data.json + {locale}_dump.json (see backend/scripts/extractParrotPlantData.ts and
// docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md for the full source
// investigation). Pure functions only — no I/O, no Prisma — so this stays covered by
// `pnpm test`'s src/health glob.

// dli_max=99 (89.5% of species) and ec_min=-1 (5.3%) both look like coarse per-category defaults
// rather than measured per-species values (cross-checked against characteristics.sun/water — see
// docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md's "Two anomalies"
// section for the evidence). DestCom's explicit choice after reviewing that evidence: keep them
// raw, do not null them — accepting that the Health Engine's range check becomes practically
// always-satisfied (not literally absent) for the affected parameter on those species.
const MS_CM_TO_US_CM = 1000;
const MOL_TO_MMOL = 1000;

export interface ParrotEncyclopediaEntry {
  id: number;
  fullname: string;
  common_names?: { common_name: string; preferred?: boolean }[];
  height_min?: number;
  height_max?: number;
  spread_min?: number;
  spread_max?: number;
  hardiness_zone_min_value?: string;
  hardiness_zone_max_value?: string;
  heat_zone_min_value?: string;
  heat_zone_max_value?: string;
  t_dying?: number;
  popularity?: number;
  genus_name?: string;
  species_name?: string;
  subspecies_name?: string;
  latin_name?: string;
  taxonomy_group_id?: number;
  is_taxonomy_group_head?: boolean;
  taxonomy_group_subelements_count?: number;
  tags?: number;
  no_fert?: boolean;
  hidden?: boolean;
  synonyms?: string;
  nameFirstLetterLatin?: string;
  orderIndexForSortingLatin?: number;
  characteristics?: { sun?: number; water?: number; fertilizer?: number };
}

export interface ParrotScientificProfile {
  dli_min?: number;
  dli_max?: number;
  adt_min?: number;
  adt_max?: number;
  ec_min?: number;
  ec_max?: number;
  vwc_dry?: number;
  vwc_wet?: number;
  vwc_irr?: number;
  vwc_cmd?: number;
  vwc_irr_eco?: number;
  vwc_cmd_eco?: number;
  n_wet?: number;
  n_irr?: number;
  n_irr_eco?: number;
}

export interface ParrotPlantRow {
  name: string;
  parrotSpeciesId: number;
  commonName: string | null;
  soilMoistureMinPercent: number | null;
  soilMoistureMaxPercent: number | null;
  soilConductivityMinUsCm: number | null;
  soilConductivityMaxUsCm: number | null;
  temperatureMinC: number | null;
  temperatureMaxC: number | null;
  lightMinMmol: number | null;
  lightMaxMmol: number | null;
  soilMoistureIrrigatePercent: number | null;
  soilMoistureCommandPercent: number | null;
  soilMoistureIrrigateEcoPercent: number | null;
  soilMoistureCommandEcoPercent: number | null;
  wetCalibrationSampleCount: number | null;
  irrigateCalibrationSampleCount: number | null;
  irrigateEcoCalibrationSampleCount: number | null;
  heightMinCm: number | null;
  heightMaxCm: number | null;
  spreadMinCm: number | null;
  spreadMaxCm: number | null;
  hardinessZoneMinValue: string | null;
  hardinessZoneMaxValue: string | null;
  heatZoneMinValue: string | null;
  heatZoneMaxValue: string | null;
  tDyingC: number | null;
  popularity: number | null;
  genusName: string | null;
  speciesName: string | null;
  subspeciesName: string | null;
  latinName: string | null;
  taxonomyGroupId: number | null;
  isTaxonomyGroupHead: boolean | null;
  taxonomyGroupSubelementsCount: number | null;
  tags: number | null;
  noFert: boolean | null;
  hidden: boolean | null;
  synonyms: string | null;
  nameFirstLetterLatin: string | null;
  orderIndexForSortingLatin: number | null;
  sunCategory: number | null;
  waterCategory: number | null;
  fertilizerCategory: number | null;
}

export function normalizeLatinName(name: string): string {
  return name
    .toLowerCase()
    .replace(/×/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();
}

function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function buildParrotPlantRow(
  entry: ParrotEncyclopediaEntry,
  profile: ParrotScientificProfile,
): ParrotPlantRow {
  const preferredCommonName =
    entry.common_names?.find((c) => c.preferred)?.common_name ?? entry.common_names?.[0]?.common_name ?? null;

  return {
    name: entry.fullname,
    parrotSpeciesId: entry.id,
    commonName: preferredCommonName,
    soilMoistureMinPercent: orNull(profile.vwc_dry),
    soilMoistureMaxPercent: orNull(profile.vwc_wet),
    soilConductivityMinUsCm: profile.ec_min === undefined ? null : profile.ec_min * MS_CM_TO_US_CM,
    soilConductivityMaxUsCm: profile.ec_max === undefined ? null : profile.ec_max * MS_CM_TO_US_CM,
    temperatureMinC: orNull(profile.adt_min),
    temperatureMaxC: orNull(profile.adt_max),
    lightMinMmol: profile.dli_min === undefined ? null : profile.dli_min * MOL_TO_MMOL,
    lightMaxMmol: profile.dli_max === undefined ? null : profile.dli_max * MOL_TO_MMOL,
    soilMoistureIrrigatePercent: orNull(profile.vwc_irr),
    soilMoistureCommandPercent: orNull(profile.vwc_cmd),
    soilMoistureIrrigateEcoPercent: orNull(profile.vwc_irr_eco),
    soilMoistureCommandEcoPercent: orNull(profile.vwc_cmd_eco),
    wetCalibrationSampleCount: orNull(profile.n_wet),
    irrigateCalibrationSampleCount: orNull(profile.n_irr),
    irrigateEcoCalibrationSampleCount: orNull(profile.n_irr_eco),
    heightMinCm: orNull(entry.height_min),
    heightMaxCm: orNull(entry.height_max),
    spreadMinCm: orNull(entry.spread_min),
    spreadMaxCm: orNull(entry.spread_max),
    hardinessZoneMinValue: orNull(entry.hardiness_zone_min_value),
    hardinessZoneMaxValue: orNull(entry.hardiness_zone_max_value),
    heatZoneMinValue: orNull(entry.heat_zone_min_value),
    heatZoneMaxValue: orNull(entry.heat_zone_max_value),
    tDyingC: orNull(entry.t_dying),
    popularity: orNull(entry.popularity),
    genusName: orNull(entry.genus_name),
    speciesName: orNull(entry.species_name),
    subspeciesName: orNull(entry.subspecies_name),
    latinName: orNull(entry.latin_name),
    taxonomyGroupId: orNull(entry.taxonomy_group_id),
    isTaxonomyGroupHead: orNull(entry.is_taxonomy_group_head),
    taxonomyGroupSubelementsCount: orNull(entry.taxonomy_group_subelements_count),
    tags: orNull(entry.tags),
    noFert: orNull(entry.no_fert),
    hidden: orNull(entry.hidden),
    synonyms: orNull(entry.synonyms),
    nameFirstLetterLatin: orNull(entry.nameFirstLetterLatin),
    orderIndexForSortingLatin: orNull(entry.orderIndexForSortingLatin),
    sunCategory: orNull(entry.characteristics?.sun),
    waterCategory: orNull(entry.characteristics?.water),
    fertilizerCategory: orNull(entry.characteristics?.fertilizer),
  };
}

export const PARROT_CSV_COLUMNS = [
  'name',
  'parrotSpeciesId',
  'commonName',
  'soilMoistureMinPercent',
  'soilMoistureMaxPercent',
  'soilConductivityMinUsCm',
  'soilConductivityMaxUsCm',
  'temperatureMinC',
  'temperatureMaxC',
  'lightMinMmol',
  'lightMaxMmol',
  'soilMoistureIrrigatePercent',
  'soilMoistureCommandPercent',
  'soilMoistureIrrigateEcoPercent',
  'soilMoistureCommandEcoPercent',
  'wetCalibrationSampleCount',
  'irrigateCalibrationSampleCount',
  'irrigateEcoCalibrationSampleCount',
  'heightMinCm',
  'heightMaxCm',
  'spreadMinCm',
  'spreadMaxCm',
  'hardinessZoneMinValue',
  'hardinessZoneMaxValue',
  'heatZoneMinValue',
  'heatZoneMaxValue',
  'tDyingC',
  'popularity',
  'genusName',
  'speciesName',
  'subspeciesName',
  'latinName',
  'taxonomyGroupId',
  'isTaxonomyGroupHead',
  'taxonomyGroupSubelementsCount',
  'tags',
  'noFert',
  'hidden',
  'synonyms',
  'nameFirstLetterLatin',
  'orderIndexForSortingLatin',
  'sunCategory',
  'waterCategory',
  'fertilizerCategory',
] as const;

// Most columns are numeric; these two sets carve out the exceptions so parseParrotCsvLine knows
// how to parse each field back. Anything not listed here is treated as a number.
const STRING_COLUMNS = new Set<(typeof PARROT_CSV_COLUMNS)[number]>([
  'name',
  'commonName',
  'hardinessZoneMinValue',
  'hardinessZoneMaxValue',
  'heatZoneMinValue',
  'heatZoneMaxValue',
  'genusName',
  'speciesName',
  'subspeciesName',
  'latinName',
  'synonyms',
  'nameFirstLetterLatin',
]);
const BOOLEAN_COLUMNS = new Set<(typeof PARROT_CSV_COLUMNS)[number]>([
  'noFert',
  'hidden',
  'isTaxonomyGroupHead',
]);

// No quoting/escaping, same simplifying assumption as WatchFlower's own CSV
// (backend/src/health/importSpeciesProfiles.ts) — Latin names/cultivar names never contain ';'.
export function formatParrotCsvRow(row: ParrotPlantRow): string {
  return PARROT_CSV_COLUMNS.map((col) => {
    const value = row[col as keyof ParrotPlantRow];
    return value === null ? '' : String(value);
  }).join(';');
}

export function parseParrotCsvLine(line: string): ParrotPlantRow {
  const fields = line.split(';');
  const raw = (col: (typeof PARROT_CSV_COLUMNS)[number]): string | null => {
    const value = fields[PARROT_CSV_COLUMNS.indexOf(col)];
    return value === undefined || value === '' ? null : value;
  };

  const result: Record<string, unknown> = {};
  for (const col of PARROT_CSV_COLUMNS) {
    const value = raw(col);
    if (value === null) {
      result[col] = col === 'name' ? '' : col === 'parrotSpeciesId' ? 0 : null;
    } else if (STRING_COLUMNS.has(col)) {
      result[col] = value;
    } else if (BOOLEAN_COLUMNS.has(col)) {
      result[col] = value === 'true';
    } else {
      result[col] = Number.parseFloat(value);
    }
  }
  return result as unknown as ParrotPlantRow;
}

export function resolveMatchId(
  name: string,
  existingByNormalizedName: ReadonlyMap<string, number>,
): number | undefined {
  return existingByNormalizedName.get(normalizeLatinName(name));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm test`
Expected: PASS, all new `parrotPlantData.test.ts` cases green, no regression in the existing 128
tests.

- [ ] **Step 5: Typecheck and lint**

Run: `cd backend && npx tsc --noEmit && cd .. && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add backend/src/health/parrotPlantData.ts backend/src/health/parrotPlantData.test.ts
git commit -m "feat(backend): add pure Parrot plant data conversion/matching logic"
```

---

### Task 3: Extraction script (manual, run locally by DestCom)

**Files:**
- Create: `backend/scripts/extractParrotPlantData.ts`
- Modify: `backend/package.json` (new script entry)

**Interfaces:**
- Consumes: `buildParrotPlantRow`, `formatParrotCsvRow`, `PARROT_CSV_COLUMNS`,
  `ParrotEncyclopediaEntry`, `ParrotScientificProfile` from Task 2's `parrotPlantData.ts`.
- Produces 6 committed files: `backend/prisma/seed-data/parrot_plant_profiles.csv` (consumed by
  Task 4); `parrot_plant_translations.json` (consumed by Task 5) — an array of
  `ParrotPlantTranslation` rows (`parrotSpeciesId`, `locale`, and 19 nullable text/int fields —
  `commonName`, `description`, `planting`, `growth`, `pruning`, `harvesting`, `interesting`,
  `soilIrr`, `pests`, `blooming`, `hardinessZoneMinText`, `hardinessZoneMaxText`,
  `heatZoneMinText`, `heatZoneMaxText`, `lightMinText`, `lightMaxText`, `fertilizerText`,
  `detailCare`, `nameFirstLetter`, `orderIndexForSorting`); `parrot_plant_attributes.json`
  (consumed by Task 6) — `{ parrotSpeciesId, category, value }`; `parrot_plant_fertilizer_types.json`
  (consumed by Task 7) — `{ parrotSpeciesId, code }`; `parrot_plant_search_names.json` (consumed by
  Task 7) — `{ parrotSpeciesId, locale, name, type }`; and the archival-only
  `parrot_attribute_number_mapping.json` (`{ locale, code, number }`) +
  `parrot_plant_attribute_numbers.json` (`{ parrotSpeciesId, locale, number }`), both consumed by
  Task 7 and never by anything else.

This script only ever runs on DestCom's own Mac (the source files are the actual iOS app bundle,
never present in Docker/CI) — it is not covered by `pnpm test`'s glob and is not unit tested
itself; Task 2's tests already cover 100% of its actual logic (row building/formatting). This task
is verified by actually running it once, by hand, against the real bundle.

- [ ] **Step 1: Write the script**

Create `backend/scripts/extractParrotPlantData.ts`:

```typescript
// One-off local extraction: reads the official "Flower Power" iOS app's bundled plant database
// (only present on DestCom's Mac, see docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md)
// and writes 7 distilled, committed artifacts covering every field found in an exhaustive audit of
// both source files: the numeric+structural CSV, per-locale free text, filter-taxonomy attribute
// codes, fertilizer-type codes, per-locale search names, and the archival-only
// attribute-number mapping/numbers pair (confirmed locale-relative, never to be read by any
// consumer — see the spec). No images — confirmed with DestCom: per-species thumbnails are fetched
// from an external host at view time, not bundled, and individually copyrighted per
// photographer/agency (see the spec for the full finding). Never run in Docker/CI — the source
// files don't exist there. Re-run manually if DestCom updates the Flower Power app and wants to
// refresh this data.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  buildParrotPlantRow,
  formatParrotCsvRow,
  type ParrotEncyclopediaEntry,
  type ParrotScientificProfile,
} from '../src/health/parrotPlantData.js';

const DEFAULT_APP_DIR = '/Applications/Flower Power.app/Wrapper/Flower Power.app';
const PROFILES_OUTPUT_PATH = fileURLToPath(new URL('../prisma/seed-data/parrot_plant_profiles.csv', import.meta.url));
const TRANSLATIONS_OUTPUT_PATH = fileURLToPath(
  new URL('../prisma/seed-data/parrot_plant_translations.json', import.meta.url),
);
const ATTRIBUTES_OUTPUT_PATH = fileURLToPath(
  new URL('../prisma/seed-data/parrot_plant_attributes.json', import.meta.url),
);
const FERTILIZER_TYPES_OUTPUT_PATH = fileURLToPath(
  new URL('../prisma/seed-data/parrot_plant_fertilizer_types.json', import.meta.url),
);
const SEARCH_NAMES_OUTPUT_PATH = fileURLToPath(
  new URL('../prisma/seed-data/parrot_plant_search_names.json', import.meta.url),
);
// Archival only — see the PlantAttributeNumberMapping/PlantProfileAttributeNumber model comments
// in schema.prisma (Task 1) for why nothing may ever read these two files' imported data back out.
const ATTRIBUTE_NUMBER_MAPPING_OUTPUT_PATH = fileURLToPath(
  new URL('../prisma/seed-data/parrot_attribute_number_mapping.json', import.meta.url),
);
const ATTRIBUTE_NUMBERS_OUTPUT_PATH = fileURLToPath(
  new URL('../prisma/seed-data/parrot_plant_attribute_numbers.json', import.meta.url),
);

// The 7 locale dumps actually present in the bundle (confirmed by listing it directly) — other
// .lproj folders in the app exist for UI chrome translation only, with no matching plant-content dump.
const LOCALES = ['DE', 'EN', 'ES', 'FR', 'IT', 'JA', 'ZH'] as const;

interface ParrotEncyclopediaEntryWithText extends ParrotEncyclopediaEntry {
  description?: { text: string | null };
  planting?: string;
  growth?: string;
  pruning?: string;
  harvesting?: string;
  interesting?: string;
  soil_irr?: string;
  pests?: string;
  blooming?: string;
  hardiness_zone_min?: string;
  hardiness_zone_max?: string;
  heat_zone_min?: string;
  heat_zone_max?: string;
  light_min?: string;
  light_max?: string;
  fertilizer?: string;
  detail_care?: string;
  nameFirstLetter?: string;
  orderIndexForSorting?: number;
  searchNames?: { name: string; type: number }[];
  attributes_numeric?: number[];
}

interface ParrotEncyclopediaEntryWithAttributes extends ParrotEncyclopediaEntry {
  attributes?: Record<string, string[]>;
}

interface ParrotEncyclopediaEntryWithFertilizerType extends ParrotEncyclopediaEntry {
  fertilizer_type?: number[];
}

interface ParrotPlantFertilizerType {
  parrotSpeciesId: number;
  code: number;
}

interface ParrotPlantSearchName {
  parrotSpeciesId: number;
  locale: string;
  name: string;
  type: number;
}

interface ParrotAttributeNumberMapping {
  locale: string;
  code: string;
  number: number;
}

interface ParrotPlantAttributeNumber {
  parrotSpeciesId: number;
  locale: string;
  number: number;
}

interface ParrotPlantAttribute {
  parrotSpeciesId: number;
  category: string;
  value: string;
}

interface ParrotPlantTranslation {
  parrotSpeciesId: number;
  locale: string;
  commonName: string | null;
  description: string | null;
  planting: string | null;
  growth: string | null;
  pruning: string | null;
  harvesting: string | null;
  interesting: string | null;
  soilIrr: string | null;
  pests: string | null;
  blooming: string | null;
  hardinessZoneMinText: string | null;
  hardinessZoneMaxText: string | null;
  heatZoneMinText: string | null;
  heatZoneMaxText: string | null;
  lightMinText: string | null;
  lightMaxText: string | null;
  fertilizerText: string | null;
  detailCare: string | null;
  nameFirstLetter: string | null;
  orderIndexForSorting: number | null;
}

function readZippedJson<T>(appDir: string, zipName: string, jsonName: string): T {
  const raw = execFileSync('unzip', ['-p', `${appDir}/${zipName}`, jsonName], {
    maxBuffer: 200 * 1024 * 1024,
  });
  return JSON.parse(raw.toString('utf-8')) as T;
}

function extractNumericProfiles(appDir: string): ParrotEncyclopediaEntry[] {
  const encyclopedia = readZippedJson<{ plants: ParrotEncyclopediaEntry[] }>(appDir, 'EN_dump.json.zip', 'EN_dump.json');
  const scientificProfiles = readZippedJson<Record<string, ParrotScientificProfile>>(
    appDir,
    'scientific_data.json.zip',
    'scientific_data.json',
  );

  const lines: string[] = [];
  let skippedNoProfile = 0;
  for (const entry of encyclopedia.plants) {
    const profile = scientificProfiles[String(entry.id)];
    if (!profile) {
      skippedNoProfile++;
      continue;
    }
    lines.push(formatParrotCsvRow(buildParrotPlantRow(entry, profile)));
  }

  writeFileSync(PROFILES_OUTPUT_PATH, `${lines.join('\n')}\n`, 'utf-8');
  console.log(
    `Wrote ${lines.length} rows to ${PROFILES_OUTPUT_PATH} (${skippedNoProfile} plants had no scientific profile).`,
  );
  return encyclopedia.plants;
}

// Reads each locale's dump exactly once and extracts everything that varies by locale from it:
// the free text (ParrotPlantTranslation), searchNames, and the attributes_numeric/
// attribute_to_number archival pair (both confirmed locale-relative — see schema.prisma's
// PlantAttributeNumberMapping comment). Deliberately one combined pass rather than 3 separate
// functions each re-reading and re-parsing the same ~40MB-per-locale JSON.
function extractLocaleDependentData(appDir: string): void {
  const translations: ParrotPlantTranslation[] = [];
  const searchNames: ParrotPlantSearchName[] = [];
  const attributeNumberMappings: ParrotAttributeNumberMapping[] = [];
  const attributeNumbers: ParrotPlantAttributeNumber[] = [];

  for (const locale of LOCALES) {
    const encyclopedia = readZippedJson<{
      plants: ParrotEncyclopediaEntryWithText[];
      attribute_to_number: Record<string, number>;
    }>(appDir, `${locale}_dump.json.zip`, `${locale}_dump.json`);

    for (const [code, number] of Object.entries(encyclopedia.attribute_to_number)) {
      attributeNumberMappings.push({ locale, code, number });
    }

    for (const entry of encyclopedia.plants) {
      const preferredCommonName =
        entry.common_names?.find((c) => c.preferred)?.common_name ?? entry.common_names?.[0]?.common_name ?? null;
      translations.push({
        parrotSpeciesId: entry.id,
        locale,
        commonName: preferredCommonName,
        description: entry.description?.text ?? null,
        planting: entry.planting ?? null,
        growth: entry.growth ?? null,
        pruning: entry.pruning ?? null,
        harvesting: entry.harvesting ?? null,
        interesting: entry.interesting ?? null,
        soilIrr: entry.soil_irr ?? null,
        pests: entry.pests ?? null,
        blooming: entry.blooming ?? null,
        hardinessZoneMinText: entry.hardiness_zone_min ?? null,
        hardinessZoneMaxText: entry.hardiness_zone_max ?? null,
        heatZoneMinText: entry.heat_zone_min ?? null,
        heatZoneMaxText: entry.heat_zone_max ?? null,
        lightMinText: entry.light_min ?? null,
        lightMaxText: entry.light_max ?? null,
        fertilizerText: entry.fertilizer ?? null,
        detailCare: entry.detail_care ?? null,
        nameFirstLetter: entry.nameFirstLetter ?? null,
        orderIndexForSorting: entry.orderIndexForSorting ?? null,
      });

      for (const searchName of entry.searchNames ?? []) {
        searchNames.push({ parrotSpeciesId: entry.id, locale, name: searchName.name, type: searchName.type });
      }
      for (const number of entry.attributes_numeric ?? []) {
        attributeNumbers.push({ parrotSpeciesId: entry.id, locale, number });
      }
    }
    console.log(`Read ${encyclopedia.plants.length} ${locale} entries.`);
  }

  writeFileSync(TRANSLATIONS_OUTPUT_PATH, JSON.stringify(translations), 'utf-8');
  console.log(`Wrote ${translations.length} translation rows to ${TRANSLATIONS_OUTPUT_PATH}.`);
  writeFileSync(SEARCH_NAMES_OUTPUT_PATH, JSON.stringify(searchNames), 'utf-8');
  console.log(`Wrote ${searchNames.length} search name rows to ${SEARCH_NAMES_OUTPUT_PATH}.`);
  writeFileSync(ATTRIBUTE_NUMBER_MAPPING_OUTPUT_PATH, JSON.stringify(attributeNumberMappings), 'utf-8');
  console.log(`Wrote ${attributeNumberMappings.length} attribute-number mapping rows (archival only) to ${ATTRIBUTE_NUMBER_MAPPING_OUTPUT_PATH}.`);
  writeFileSync(ATTRIBUTE_NUMBERS_OUTPUT_PATH, JSON.stringify(attributeNumbers), 'utf-8');
  console.log(`Wrote ${attributeNumbers.length} plant attribute-number rows (archival only) to ${ATTRIBUTE_NUMBERS_OUTPUT_PATH}.`);
}

// Attribute codes (plant type, special features, bloom color, etc.) and fertilizer_type are
// structural, not translated text — reading the EN dump once is enough, the same codes appear
// identically in every locale's dump (confirmed empirically, unlike attributes_numeric above).
function extractAttributes(appDir: string): void {
  const encyclopedia = readZippedJson<{ plants: ParrotEncyclopediaEntryWithAttributes[] }>(
    appDir,
    'EN_dump.json.zip',
    'EN_dump.json',
  );

  const rows: ParrotPlantAttribute[] = [];
  for (const entry of encyclopedia.plants) {
    if (!entry.attributes) continue;
    for (const [category, values] of Object.entries(entry.attributes)) {
      for (const value of values) {
        rows.push({ parrotSpeciesId: entry.id, category, value });
      }
    }
  }

  writeFileSync(ATTRIBUTES_OUTPUT_PATH, JSON.stringify(rows), 'utf-8');
  console.log(`Wrote ${rows.length} attribute rows to ${ATTRIBUTES_OUTPUT_PATH}.`);
}

function extractFertilizerTypes(appDir: string): void {
  const encyclopedia = readZippedJson<{ plants: ParrotEncyclopediaEntryWithFertilizerType[] }>(
    appDir,
    'EN_dump.json.zip',
    'EN_dump.json',
  );

  const rows: ParrotPlantFertilizerType[] = [];
  for (const entry of encyclopedia.plants) {
    for (const code of entry.fertilizer_type ?? []) {
      rows.push({ parrotSpeciesId: entry.id, code });
    }
  }

  writeFileSync(FERTILIZER_TYPES_OUTPUT_PATH, JSON.stringify(rows), 'utf-8');
  console.log(`Wrote ${rows.length} fertilizer-type rows to ${FERTILIZER_TYPES_OUTPUT_PATH}.`);
}

function main(): void {
  const appDir = process.argv[2] ?? DEFAULT_APP_DIR;
  extractNumericProfiles(appDir);
  extractLocaleDependentData(appDir);
  extractAttributes(appDir);
  extractFertilizerTypes(appDir);
}

main();
```

- [ ] **Step 2: Add the npm script**

In `backend/package.json`'s `"scripts"` section, add (after `"import:species"`):

```json
    "extract:parrot-plants": "tsx scripts/extractParrotPlantData.ts",
```

- [ ] **Step 3: Run it against the real app bundle**

Run: `cd backend && pnpm extract:parrot-plants`
Expected:
```
Wrote 8090 rows to .../parrot_plant_profiles.csv (0 plants had no scientific profile).
Read 8090 EN entries.
Read 8090 DE entries.
Read 8090 ES entries.
Read 8090 FR entries.
Read 8090 IT entries.
Read 8090 JA entries.
Read 8090 ZH entries.
Wrote 56630 translation rows to .../parrot_plant_translations.json.
Wrote <S> search name rows to .../parrot_plant_search_names.json.
Wrote 630 attribute-number mapping rows (archival only) to .../parrot_attribute_number_mapping.json.
Wrote <N> plant attribute-number rows (archival only) to .../parrot_plant_attribute_numbers.json.
Wrote <A> attribute rows to .../parrot_plant_attributes.json.
Wrote <F> fertilizer-type rows to .../parrot_plant_fertilizer_types.json.
```
(0 skipped on the numeric side, matching the 1:1 join already confirmed manually during
investigation — a nonzero skip count, or a per-locale count other than 8090, would mean the data
isn't as uniform as observed and is worth a second look before proceeding. 56630 = 8090 x 7. 630 =
90 codes x 7 locales, exact and known ahead of time since `attribute_to_number` has a fixed 90
entries per locale. `<S>`, `<N>`, `<A>`, `<F>` are unknown ahead of time — record them once
observed; `<A>` should be in the same ballpark as the 91891-row `ZPLANTATTRIBUTESENTITY` count
already seen in the runtime Core Data cache, though not necessarily identical since that cache may
reflect a slightly different app-version snapshot.)

- [ ] **Step 4: Sanity-check every output file**

Run: `wc -l backend/prisma/seed-data/parrot_plant_profiles.csv && head -3 backend/prisma/seed-data/parrot_plant_profiles.csv`
Expected: 8090 lines, each with 44 `;`-separated fields (matching `PARROT_CSV_COLUMNS`'s length),
numeric/string/boolean values where expected and empty fields for nulls (e.g. species with no
`ec_min`) — including a row with a literal `-1` in the `soilConductivityMinUsCm`-derived column for
a species known to have `ec_min=-1` (kept raw, not nulled, per the "Two anomalies" decision).

Run: `node -e "const d = require('./backend/prisma/seed-data/parrot_plant_translations.json'); console.log(d.length, d.find(r => r.locale === 'FR' && r.parrotSpeciesId === 5642))"`
Expected: `56630 { parrotSpeciesId: 5642, locale: 'FR', commonName: ..., description: ..., planting: 'Il pousse mieux en plein soleil...', ... }` — the same "Abelia chinensis" French planting text
already seen verbatim during the initial manual investigation of `FR_dump.json`.

Run: `node -e "const d = require('./backend/prisma/seed-data/parrot_plant_attributes.json'); console.log(d.length, d.filter(r => r.parrotSpeciesId === 5642))"`
Expected: the count matches Step 3's `<A>`, and the filtered list for id 5642 (Abelia chinensis)
matches the `attributes` object seen during the initial manual investigation (`FO: [BR, GR]`,
`SF: [DR]`, `PT: [SH, PE]`, `SH: [SP]`, `BL: [PI, WH, PU]`, `SN: [EF, EE, LE, MF, ME]` — 12 rows).

Run: `node -e "const d = require('./backend/prisma/seed-data/parrot_plant_search_names.json'); console.log(d.filter(r => r.parrotSpeciesId === 5642 && r.locale === 'EN'))"`
Expected: matches the 3 EN search names already seen during investigation (`Chinese Abelia`
type 0, `Abelia chinensis` type 1, `Abelia rupestris` type 3).

Run: `node -e "const en = require('./backend/prisma/seed-data/parrot_attribute_number_mapping.json'); const fr = require('./backend/prisma/seed-data/parrot_attribute_number_mapping.json'); console.log(en.filter(r=>r.locale==='EN'&&r.code==='PT-FE'), en.filter(r=>r.locale==='FR'&&r.code==='PT-FE'))"`
Expected: EN row has `number: 80`, FR row has `number: 79` — confirms the mapping was captured
per-locale, not collapsed into one (incorrectly universal) table.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/extractParrotPlantData.ts backend/package.json backend/prisma/seed-data/
git commit -m "feat(backend): extract Parrot's official plant database (thresholds + 7-locale text + attribute/fertilizer codes + search names) into distilled files"
```

---

### Task 4: Wire the overlay into `importSpeciesProfiles.ts`

**Files:**
- Modify: `backend/src/health/importSpeciesProfiles.ts` (full rewrite of `main()`, existing
  WatchFlower logic preserved verbatim inside a renamed function)

**Interfaces:**
- Consumes: `parseParrotCsvLine`, `resolveMatchId`, `normalizeLatinName` from
  `parrotPlantData.ts`; reads `backend/prisma/seed-data/parrot_plant_profiles.csv` (Task 3's
  output).
- Produces: no new exports — this is the script's own `main()`, run via `pnpm import:species` and
  from `docker-entrypoint.sh` exactly as today.

- [ ] **Step 1: Rewrite the file**

Replace the full contents of `backend/src/health/importSpeciesProfiles.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../db/client.js';
import { parseParrotCsvLine, resolveMatchId } from './parrotPlantData.js';

// Source: assets/plants/watchflower_plantdb.csv from the emericg/WatchFlower repo (GPLv3). The
// file is never committed to StroyPlant (third-party data under a different license) — it is
// downloaded when this script runs. URL pinned to a specific commit (not `master`) so a
// future re-import doesn't silently change data versions.
const WATCHFLOWER_CSV_URL =
  'https://raw.githubusercontent.com/emericg/WatchFlower/ee229b5313fc2b5e98a385e8934ce3618602bf7b/assets/plants/watchflower_plantdb.csv';

// Format verified empirically (not assumed): `;` delimiter, 35 columns per data line,
// no quoting/escaping anywhere in the file — a simple split(';') is reliable here,
// no need for a CSV parser. 0-based index into the split line.
const COLUMN = {
  name: 0,
  commonName: 1,
  soilMoistureMin: 21,
  soilMoistureMax: 22,
  soilConductivityMin: 23,
  soilConductivityMax: 24,
  soilPhMin: 25,
  soilPhMax: 26,
  temperatureMin: 27,
  temperatureMax: 28,
  humidityMin: 29,
  humidityMax: 30,
  lightMinLux: 31,
  lightMaxLux: 32,
  lightMinMmol: 33,
  lightMaxMmol: 34,
} as const;

// A MIN=0/MAX=0 pair means "not applicable" in the source CSV (confirmed by the repo's docs
// and observed in practice, e.g. PH columns for succulents) — never a literal zero.
function parseRange(rawMin: string | undefined, rawMax: string | undefined): [number | null, number | null] {
  const min = rawMin ? Number.parseFloat(rawMin) : null;
  const max = rawMax ? Number.parseFloat(rawMax) : null;
  if (min === 0 && max === 0) return [null, null];
  return [Number.isNaN(min) ? null : min, Number.isNaN(max) ? null : max];
}

// Idempotent by design, same as seed-admin.ts: docker-entrypoint.sh runs this on every container
// boot, not just the first one. Unlike seed-admin's single findUnique check, this skips the whole
// download+parse pass (not just the upsert) once any profile exists — a full re-import was
// previously a manual, easy-to-forget step; production ran with 0 rows in plant_profiles until this
// was actually run once by hand (found empirically on the production server, 2026-07-29).
async function importWatchFlowerProfiles(): Promise<void> {
  const existingCount = await prisma.plantProfile.count();
  if (existingCount > 0) {
    console.log(`plant_profiles already has ${existingCount} rows — skipping WatchFlower download/import.`);
    return;
  }

  console.log(`Downloading CSV from ${WATCHFLOWER_CSV_URL}...`);
  const response = await fetch(WATCHFLOWER_CSV_URL);
  if (!response.ok) {
    throw new Error(`CSV download failed: HTTP ${response.status}`);
  }
  const csv = await response.text();
  const lines = csv.split('\n').filter((line) => line.trim().length > 0);
  const [, ...dataLines] = lines; // skip the header line

  let imported = 0;
  let skipped = 0;

  for (const line of dataLines) {
    const fields = line.split(';');
    const name = fields[COLUMN.name]?.trim();
    if (!name) {
      skipped++;
      continue;
    }

    const [soilMoistureMinPercent, soilMoistureMaxPercent] = parseRange(fields[COLUMN.soilMoistureMin], fields[COLUMN.soilMoistureMax]);
    const [soilConductivityMinUsCm, soilConductivityMaxUsCm] = parseRange(
      fields[COLUMN.soilConductivityMin],
      fields[COLUMN.soilConductivityMax],
    );
    const [soilPhMin, soilPhMax] = parseRange(fields[COLUMN.soilPhMin], fields[COLUMN.soilPhMax]);
    const [temperatureMinC, temperatureMaxC] = parseRange(fields[COLUMN.temperatureMin], fields[COLUMN.temperatureMax]);
    const [humidityMinPercent, humidityMaxPercent] = parseRange(fields[COLUMN.humidityMin], fields[COLUMN.humidityMax]);
    const [lightMinLux, lightMaxLux] = parseRange(fields[COLUMN.lightMinLux], fields[COLUMN.lightMaxLux]);
    const [lightMinMmol, lightMaxMmol] = parseRange(fields[COLUMN.lightMinMmol], fields[COLUMN.lightMaxMmol]);

    const data = {
      commonName: fields[COLUMN.commonName]?.trim() || null,
      soilMoistureMinPercent,
      soilMoistureMaxPercent,
      soilConductivityMinUsCm,
      soilConductivityMaxUsCm,
      soilPhMin,
      soilPhMax,
      temperatureMinC,
      temperatureMaxC,
      humidityMinPercent,
      humidityMaxPercent,
      lightMinLux,
      lightMaxLux,
      lightMinMmol,
      lightMaxMmol,
    };

    await prisma.plantProfile.upsert({
      where: { name },
      update: data,
      create: { name, ...data },
    });
    imported++;
  }

  console.log(`WatchFlower import finished: ${imported} profiles imported, ${skipped} rows skipped (missing name).`);
}

const PARROT_CSV_PATH = fileURLToPath(new URL('../../prisma/seed-data/parrot_plant_profiles.csv', import.meta.url));

// Independently idempotent from importWatchFlowerProfiles: gated on whether the overlay has ever
// run (parrotSpeciesId set on at least one row), not on plant_profiles being non-empty overall —
// otherwise this would never run at all against a production database that already has WatchFlower
// rows from before this feature existed. See
// docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md for why Parrot's values
// take priority over WatchFlower's on every field it provides.
async function importParrotOverlay(): Promise<void> {
  const alreadyApplied = await prisma.plantProfile.count({ where: { parrotSpeciesId: { not: null } } });
  if (alreadyApplied > 0) {
    console.log(`${alreadyApplied} profiles already carry Parrot data — skipping Parrot overlay.`);
    return;
  }

  if (!existsSync(PARROT_CSV_PATH)) {
    console.log(`No Parrot plant data file at ${PARROT_CSV_PATH} — skipping Parrot overlay.`);
    return;
  }

  const existingProfiles = await prisma.plantProfile.findMany({ select: { id: true, name: true } });
  const existingByNormalizedName = new Map(existingProfiles.map((p) => [normalizeName(p.name), p.id]));

  const lines = readFileSync(PARROT_CSV_PATH, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);

  let updated = 0;
  let created = 0;

  for (const line of lines) {
    const row = parseParrotCsvLine(line);
    // Destructure out the two fields handled separately (name drives the where/create key,
    // commonName is intentionally left untouched on an update — see below) so every OTHER field
    // on ParrotPlantRow flows into `data` automatically. Enumerating each field by hand here was
    // tried first and silently dropped a whole batch of newly-added columns during this plan's own
    // drafting (caught in self-review, see the note at the bottom of this plan) — with a field list
    // now in the 40s and still growing, destructuring is the version of this that can't go stale.
    const { name, commonName, ...data } = row;

    const matchedId = resolveMatchId(name, existingByNormalizedName);
    if (matchedId !== undefined) {
      await prisma.plantProfile.update({ where: { id: matchedId }, data });
      updated++;
    } else {
      await prisma.plantProfile.upsert({
        where: { name },
        update: data,
        create: { name, commonName, ...data },
      });
      created++;
    }
  }

  console.log(`Parrot overlay finished: ${updated} existing profiles updated, ${created} new profiles created.`);
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/×/g, 'x').replace(/\s+/g, ' ').trim();
}

async function main(): Promise<void> {
  await importWatchFlowerProfiles();
  await importParrotOverlay();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Échec de l'import des profils de plantes:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
```

Note: `normalizeName` here is a local copy of `parrotPlantData.ts`'s `normalizeLatinName` used only
to build `existingByNormalizedName` from WatchFlower's own `name` column — kept as a private
duplicate rather than exported/imported twice under two names would be worse; **actually, reuse the
real export instead of duplicating it**: replace the local `normalizeName` function and its one
call site with `normalizeLatinName` (already imported-ready from `./parrotPlantData.js`) — add it to
the import line at the top (`import { normalizeLatinName, parseParrotCsvLine, resolveMatchId } from
'./parrotPlantData.js';`) and delete the `function normalizeName(...)` block, changing
`existingProfiles.map((p) => [normalizeName(p.name), p.id])` to use `normalizeLatinName`.

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: clean (no unused-import errors — confirm the `normalizeName` duplicate was actually
removed per the note above, not left dangling).

- [ ] **Step 3: Run the full test suite**

Run: `cd backend && pnpm test`
Expected: PASS, no regressions (this file has no direct tests — it's a script orchestrating
Prisma I/O — Task 2's tests already cover every pure decision it delegates to
`parrotPlantData.ts`).

- [ ] **Step 4: Commit**

```bash
git add backend/src/health/importSpeciesProfiles.ts
git commit -m "feat(backend): overlay Parrot's plant data onto WatchFlower's on every boot"
```

---

### Task 5: Import Parrot translations into `PlantProfileTranslation`

**Files:**
- Modify: `backend/src/health/importSpeciesProfiles.ts` (add `importParrotTranslations()`, call it
  from `main()`)

**Interfaces:**
- Consumes: the `PlantProfileTranslation` model (Task 1) and
  `backend/prisma/seed-data/parrot_plant_translations.json` (Task 3's second output). Reads
  `parrotSpeciesId` off `PlantProfile` rows already populated by Task 4's `importParrotOverlay()`
  — this task must run after that one.

- [ ] **Step 1: Add the function and wire it into `main()`**

In `backend/src/health/importSpeciesProfiles.ts`, add near the bottom (after
`importParrotOverlay`, before `main`):

```typescript
interface ParrotPlantTranslationRow {
  parrotSpeciesId: number;
  locale: string;
  commonName: string | null;
  description: string | null;
  planting: string | null;
  growth: string | null;
  pruning: string | null;
  harvesting: string | null;
  interesting: string | null;
  soilIrr: string | null;
  pests: string | null;
  blooming: string | null;
  hardinessZoneMinText: string | null;
  hardinessZoneMaxText: string | null;
  heatZoneMinText: string | null;
  heatZoneMaxText: string | null;
  lightMinText: string | null;
  lightMaxText: string | null;
  fertilizerText: string | null;
  detailCare: string | null;
  nameFirstLetter: string | null;
  orderIndexForSorting: number | null;
}

const PARROT_TRANSLATIONS_PATH = fileURLToPath(
  new URL('../../prisma/seed-data/parrot_plant_translations.json', import.meta.url),
);

// Independently idempotent, same reasoning as importParrotOverlay: gated on this table already
// having rows, not on plant_profiles being non-empty. Must run after importParrotOverlay, which is
// what actually populates parrotSpeciesId on every matched/created PlantProfile row.
async function importParrotTranslations(): Promise<void> {
  const existingCount = await prisma.plantProfileTranslation.count();
  if (existingCount > 0) {
    console.log(`plant_profile_translations already has ${existingCount} rows — skipping Parrot translations import.`);
    return;
  }

  if (!existsSync(PARROT_TRANSLATIONS_PATH)) {
    console.log(`No Parrot translations file at ${PARROT_TRANSLATIONS_PATH} — skipping.`);
    return;
  }

  const profiles = await prisma.plantProfile.findMany({
    where: { parrotSpeciesId: { not: null } },
    select: { id: true, parrotSpeciesId: true },
  });
  const profileIdBySpeciesId = new Map(profiles.map((p) => [p.parrotSpeciesId as number, p.id]));

  const rows: ParrotPlantTranslationRow[] = JSON.parse(readFileSync(PARROT_TRANSLATIONS_PATH, 'utf-8'));

  let imported = 0;
  let skippedNoProfile = 0;
  for (const row of rows) {
    const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
    if (plantProfileId === undefined) {
      skippedNoProfile++;
      continue;
    }
    // Same destructuring approach as importParrotOverlay (Task 4) and for the same reason —
    // parrotSpeciesId/locale are handled explicitly (key lookup / unique constraint), everything
    // else on the row is a PlantProfileTranslation column and flows through automatically.
    const { parrotSpeciesId, locale, ...fields } = row;
    await prisma.plantProfileTranslation.upsert({
      where: { plantProfileId_locale: { plantProfileId, locale } },
      update: fields,
      create: { plantProfileId, locale, ...fields },
    });
    imported++;
  }

  console.log(`Parrot translations import finished: ${imported} rows imported, ${skippedNoProfile} skipped (no matching profile).`);
}
```

Then change `main()` to:

```typescript
async function main(): Promise<void> {
  await importWatchFlowerProfiles();
  await importParrotOverlay();
  await importParrotTranslations();
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the full test suite**

Run: `cd backend && pnpm test`
Expected: PASS, no regressions (same reasoning as Task 4 — this function has no dedicated unit
tests, it's Prisma I/O orchestration verified manually in Task 8).

- [ ] **Step 4: Commit**

```bash
git add backend/src/health/importSpeciesProfiles.ts
git commit -m "feat(backend): import Parrot's multi-locale plant text into PlantProfileTranslation"
```

---

### Task 6: Import Parrot attribute codes into `PlantProfileAttribute`

**Files:**
- Modify: `backend/src/health/importSpeciesProfiles.ts` (add `importParrotAttributes()`, call it
  from `main()`)

**Interfaces:**
- Consumes: the `PlantProfileAttribute` model (Task 1) and
  `backend/prisma/seed-data/parrot_plant_attributes.json` (Task 3's third output). Reads
  `parrotSpeciesId` off `PlantProfile` rows already populated by Task 4's `importParrotOverlay()`
  — same ordering requirement as Task 5.

- [ ] **Step 1: Add the function and wire it into `main()`**

In `backend/src/health/importSpeciesProfiles.ts`, add after `importParrotTranslations` and before
`main`:

```typescript
interface ParrotPlantAttributeRow {
  parrotSpeciesId: number;
  category: string;
  value: string;
}

const PARROT_ATTRIBUTES_PATH = fileURLToPath(
  new URL('../../prisma/seed-data/parrot_plant_attributes.json', import.meta.url),
);

// Independently idempotent, same reasoning as importParrotOverlay/importParrotTranslations. Must
// run after importParrotOverlay (parrotSpeciesId source of truth).
async function importParrotAttributes(): Promise<void> {
  const existingCount = await prisma.plantProfileAttribute.count();
  if (existingCount > 0) {
    console.log(`plant_profile_attributes already has ${existingCount} rows — skipping Parrot attributes import.`);
    return;
  }

  if (!existsSync(PARROT_ATTRIBUTES_PATH)) {
    console.log(`No Parrot attributes file at ${PARROT_ATTRIBUTES_PATH} — skipping.`);
    return;
  }

  const profiles = await prisma.plantProfile.findMany({
    where: { parrotSpeciesId: { not: null } },
    select: { id: true, parrotSpeciesId: true },
  });
  const profileIdBySpeciesId = new Map(profiles.map((p) => [p.parrotSpeciesId as number, p.id]));

  const rows: ParrotPlantAttributeRow[] = JSON.parse(readFileSync(PARROT_ATTRIBUTES_PATH, 'utf-8'));

  let imported = 0;
  let skippedNoProfile = 0;
  for (const row of rows) {
    const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
    if (plantProfileId === undefined) {
      skippedNoProfile++;
      continue;
    }
    await prisma.plantProfileAttribute.upsert({
      where: { plantProfileId_category_value: { plantProfileId, category: row.category, value: row.value } },
      update: {},
      create: { plantProfileId, category: row.category, value: row.value },
    });
    imported++;
  }

  console.log(`Parrot attributes import finished: ${imported} rows imported, ${skippedNoProfile} skipped (no matching profile).`);
}
```

Then change `main()` to:

```typescript
async function main(): Promise<void> {
  await importWatchFlowerProfiles();
  await importParrotOverlay();
  await importParrotTranslations();
  await importParrotAttributes();
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the full test suite**

Run: `cd backend && pnpm test`
Expected: PASS, no regressions (same reasoning as Task 5 — Prisma I/O orchestration verified
manually in Task 8).

- [ ] **Step 4: Commit**

```bash
git add backend/src/health/importSpeciesProfiles.ts
git commit -m "feat(backend): import Parrot's filter-taxonomy attribute codes into PlantProfileAttribute"
```

---

### Task 7: Import fertilizer types, search names, and the archival attribute-number pair

**Files:**
- Modify: `backend/src/health/importSpeciesProfiles.ts` (add `importParrotFertilizerTypes()`,
  `importParrotSearchNames()`, `importParrotAttributeNumbers()`, call all three from `main()`)

Grouped into one task — all three are mechanically identical (read a distilled JSON file, map
`parrotSpeciesId` to `plantProfileId`, insert rows) and none needs an independent review gate from
the others, per this plan's own task-sizing guidance.

**Interfaces:**
- Consumes: the `PlantProfileFertilizerType`, `PlantProfileSearchName`,
  `PlantAttributeNumberMapping`, `PlantProfileAttributeNumber` models (Task 1) and
  `parrot_plant_fertilizer_types.json`, `parrot_plant_search_names.json`,
  `parrot_attribute_number_mapping.json`, `parrot_plant_attribute_numbers.json` (Task 3's
  remaining outputs). Reads `parrotSpeciesId` off `PlantProfile` rows already populated by Task 4's
  `importParrotOverlay()` — same ordering requirement as Tasks 5/6.

- [ ] **Step 1: Add the three functions and wire them into `main()`**

In `backend/src/health/importSpeciesProfiles.ts`, add after `importParrotAttributes` and before
`main`:

```typescript
interface ParrotPlantFertilizerTypeRow {
  parrotSpeciesId: number;
  code: number;
}

interface ParrotPlantSearchNameRow {
  parrotSpeciesId: number;
  locale: string;
  name: string;
  type: number;
}

interface ParrotAttributeNumberMappingRow {
  locale: string;
  code: string;
  number: number;
}

interface ParrotPlantAttributeNumberRow {
  parrotSpeciesId: number;
  locale: string;
  number: number;
}

const PARROT_FERTILIZER_TYPES_PATH = fileURLToPath(
  new URL('../../prisma/seed-data/parrot_plant_fertilizer_types.json', import.meta.url),
);
const PARROT_SEARCH_NAMES_PATH = fileURLToPath(
  new URL('../../prisma/seed-data/parrot_plant_search_names.json', import.meta.url),
);
const PARROT_ATTRIBUTE_NUMBER_MAPPING_PATH = fileURLToPath(
  new URL('../../prisma/seed-data/parrot_attribute_number_mapping.json', import.meta.url),
);
const PARROT_ATTRIBUTE_NUMBERS_PATH = fileURLToPath(
  new URL('../../prisma/seed-data/parrot_plant_attribute_numbers.json', import.meta.url),
);

async function loadProfileIdBySpeciesId(): Promise<Map<number, number>> {
  const profiles = await prisma.plantProfile.findMany({
    where: { parrotSpeciesId: { not: null } },
    select: { id: true, parrotSpeciesId: true },
  });
  return new Map(profiles.map((p) => [p.parrotSpeciesId as number, p.id]));
}

async function importParrotFertilizerTypes(): Promise<void> {
  const existingCount = await prisma.plantProfileFertilizerType.count();
  if (existingCount > 0) {
    console.log(`plant_profile_fertilizer_types already has ${existingCount} rows — skipping.`);
    return;
  }
  if (!existsSync(PARROT_FERTILIZER_TYPES_PATH)) {
    console.log(`No Parrot fertilizer types file at ${PARROT_FERTILIZER_TYPES_PATH} — skipping.`);
    return;
  }

  const profileIdBySpeciesId = await loadProfileIdBySpeciesId();
  const rows: ParrotPlantFertilizerTypeRow[] = JSON.parse(readFileSync(PARROT_FERTILIZER_TYPES_PATH, 'utf-8'));

  let imported = 0;
  for (const row of rows) {
    const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
    if (plantProfileId === undefined) continue;
    await prisma.plantProfileFertilizerType.upsert({
      where: { plantProfileId_code: { plantProfileId, code: row.code } },
      update: {},
      create: { plantProfileId, code: row.code },
    });
    imported++;
  }
  console.log(`Parrot fertilizer types import finished: ${imported} rows imported.`);
}

async function importParrotSearchNames(): Promise<void> {
  const existingCount = await prisma.plantProfileSearchName.count();
  if (existingCount > 0) {
    console.log(`plant_profile_search_names already has ${existingCount} rows — skipping.`);
    return;
  }
  if (!existsSync(PARROT_SEARCH_NAMES_PATH)) {
    console.log(`No Parrot search names file at ${PARROT_SEARCH_NAMES_PATH} — skipping.`);
    return;
  }

  const profileIdBySpeciesId = await loadProfileIdBySpeciesId();
  const rows: ParrotPlantSearchNameRow[] = JSON.parse(readFileSync(PARROT_SEARCH_NAMES_PATH, 'utf-8'));

  let imported = 0;
  for (const row of rows) {
    const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
    if (plantProfileId === undefined) continue;
    await prisma.plantProfileSearchName.upsert({
      where: {
        plantProfileId_locale_type_name: { plantProfileId, locale: row.locale, type: row.type, name: row.name },
      },
      update: {},
      create: { plantProfileId, locale: row.locale, name: row.name, type: row.type },
    });
    imported++;
  }
  console.log(`Parrot search names import finished: ${imported} rows imported.`);
}

// Archival only — see PlantAttributeNumberMapping/PlantProfileAttributeNumber's schema.prisma
// comments (Task 1). Imported so the raw data isn't lost, never read by any other code.
async function importParrotAttributeNumbers(): Promise<void> {
  const existingMappingCount = await prisma.plantAttributeNumberMapping.count();
  if (existingMappingCount === 0 && existsSync(PARROT_ATTRIBUTE_NUMBER_MAPPING_PATH)) {
    const mappingRows: ParrotAttributeNumberMappingRow[] = JSON.parse(
      readFileSync(PARROT_ATTRIBUTE_NUMBER_MAPPING_PATH, 'utf-8'),
    );
    for (const row of mappingRows) {
      await prisma.plantAttributeNumberMapping.upsert({
        where: { locale_code: { locale: row.locale, code: row.code } },
        update: { number: row.number },
        create: row,
      });
    }
    console.log(`Parrot attribute-number mapping import finished: ${mappingRows.length} rows imported (archival only).`);
  } else {
    console.log(`plant_attribute_number_mapping already has ${existingMappingCount} rows — skipping.`);
  }

  const existingNumberCount = await prisma.plantProfileAttributeNumber.count();
  if (existingNumberCount > 0) {
    console.log(`plant_profile_attribute_numbers already has ${existingNumberCount} rows — skipping.`);
    return;
  }
  if (!existsSync(PARROT_ATTRIBUTE_NUMBERS_PATH)) {
    console.log(`No Parrot attribute numbers file at ${PARROT_ATTRIBUTE_NUMBERS_PATH} — skipping.`);
    return;
  }

  const profileIdBySpeciesId = await loadProfileIdBySpeciesId();
  const rows: ParrotPlantAttributeNumberRow[] = JSON.parse(readFileSync(PARROT_ATTRIBUTE_NUMBERS_PATH, 'utf-8'));

  let imported = 0;
  for (const row of rows) {
    const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
    if (plantProfileId === undefined) continue;
    await prisma.plantProfileAttributeNumber.upsert({
      where: { plantProfileId_locale_number: { plantProfileId, locale: row.locale, number: row.number } },
      update: {},
      create: { plantProfileId, locale: row.locale, number: row.number },
    });
    imported++;
  }
  console.log(`Parrot plant attribute-numbers import finished: ${imported} rows imported (archival only).`);
}
```

Then change `main()` to:

```typescript
async function main(): Promise<void> {
  await importWatchFlowerProfiles();
  await importParrotOverlay();
  await importParrotTranslations();
  await importParrotAttributes();
  await importParrotFertilizerTypes();
  await importParrotSearchNames();
  await importParrotAttributeNumbers();
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Run the full test suite**

Run: `cd backend && pnpm test`
Expected: PASS, no regressions (same reasoning as Tasks 5/6 — Prisma I/O orchestration verified
manually in Task 8).

- [ ] **Step 4: Commit**

```bash
git add backend/src/health/importSpeciesProfiles.ts
git commit -m "feat(backend): import Parrot fertilizer types, search names, and archival attribute-number data"
```

---

### Task 8: Manual verification against a scratch copy of `dev.db`

**Files:** none modified — verification only, matching this project's established convention
(every prior batch touching `plant_profiles`/production data was verified this way before being
considered done).

- [ ] **Step 1: Make a scratch copy of the real dev database**

Run: `cp backend/prisma/dev.db /tmp/dev_db_scratch_parrot_import.db`

- [ ] **Step 2: Point a throwaway run at the scratch copy and run the import**

Run: `cd backend && DATABASE_URL="file:/tmp/dev_db_scratch_parrot_import.db" pnpm import:species`
Expected output includes all seven import steps' finish lines:
```
plant_profiles already has 3404 rows — skipping WatchFlower download/import.
Parrot overlay finished: <N> existing profiles updated, <M> new profiles created.
Parrot translations import finished: <T> rows imported, 0 skipped (no matching profile).
Parrot attributes import finished: <A> rows imported, 0 skipped (no matching profile).
Parrot fertilizer types import finished: <F> rows imported.
Parrot search names import finished: <S> rows imported.
Parrot attribute-number mapping import finished: 630 rows imported (archival only).
Parrot plant attribute-numbers import finished: <NUM> rows imported (archival only).
```
(exact N/M unknown ahead of time — record them here once observed, and sanity-check `N + M` is in
the neighborhood of 8090 minus any rows the CSV's own `id` lookup skipped. `T` should equal
`(3404 + M) × 7` locales, and the skipped count should be exactly 0 — every profile that just got a
`parrotSpeciesId` from the overlay step should have a matching translation row in all 7 locales;
a nonzero skip count here would mean the overlay and translation extraction disagree about which
species exist, worth investigating before moving on. 630 is exact and known ahead of time — 90
codes × 7 locales.)

- [ ] **Step 3: Confirm total row counts grew as expected**

Run: `sqlite3 /tmp/dev_db_scratch_parrot_import.db "SELECT COUNT(*) FROM PlantProfile; SELECT COUNT(*) FROM PlantProfileTranslation; SELECT DISTINCT locale FROM PlantProfileTranslation ORDER BY locale; SELECT COUNT(*) FROM PlantProfileAttribute; SELECT COUNT(*) FROM PlantProfileFertilizerType; SELECT COUNT(*) FROM PlantProfileSearchName; SELECT COUNT(*) FROM PlantAttributeNumberMapping; SELECT COUNT(*) FROM PlantProfileAttributeNumber;"`
Expected: `3404 + M` profiles, `(3404 + M) × 7` translation rows, exactly the 7 locales
`DE, EN, ES, FR, IT, JA, ZH`, the attribute/fertilizer-type/search-name counts matching Step 2's
`<A>`/`<F>`/`<S>`, exactly 630 attribute-number mapping rows, and the attribute-number count
matching `<NUM>`.

- [ ] **Step 4: Spot-check a real assigned device's species before/after**

Run: `sqlite3 backend/prisma/dev.db "SELECT p.name, p.soilMoistureMinPercent, p.soilMoistureMaxPercent, p.soilConductivityMinUsCm, p.soilConductivityMaxUsCm FROM Device d JOIN PlantProfile p ON p.id = d.plantProfileId WHERE d.id LIKE 'PARROT-A073%' OR d.name LIKE '%A073%';"`
then the same query against the scratch DB:
`sqlite3 /tmp/dev_db_scratch_parrot_import.db "SELECT p.name, p.soilMoistureMinPercent, p.soilMoistureMaxPercent, p.soilConductivityMinUsCm, p.soilConductivityMaxUsCm FROM Device d JOIN PlantProfile p ON p.id = d.plantProfileId WHERE d.id LIKE 'PARROT-A073%' OR d.name LIKE '%A073%';"`
Expected: the values differ between the two runs (proof the Parrot-priority overlay actually took
effect for a real, already-assigned device) — record the before/after values here for the docs
update in Task 9, since this is exactly the kind of "real-hardware consequence" this project's
CLAUDE.md always documents explicitly for changes like this.

- [ ] **Step 5: Confirm re-running the import a second time is a no-op**

Run: `cd backend && DATABASE_URL="file:/tmp/dev_db_scratch_parrot_import.db" pnpm import:species`
Expected:
```
plant_profiles already has <total> rows — skipping WatchFlower download/import.
<total-with-parrot-data> profiles already carry Parrot data — skipping Parrot overlay.
plant_profile_translations already has <T> rows — skipping Parrot translations import.
plant_profile_attributes already has <A> rows — skipping Parrot attributes import.
plant_profile_fertilizer_types already has <F> rows — skipping.
plant_profile_search_names already has <S> rows — skipping.
plant_attribute_number_mapping already has 630 rows — skipping.
plant_profile_attribute_numbers already has <N> rows — skipping.
```
(all seven import steps skip — confirms the independent-idempotency fix from the Global
Constraints works across every one of them.)

- [ ] **Step 6: Clean up**

Run: `rm /tmp/dev_db_scratch_parrot_import.db`

(No commit — this task produces no file changes, only the recorded before/after numbers used in
Task 9.)

---

### Task 9: Update docs

**Files:**
- Modify: `/Users/destcom/Documents/PERSO/StroyPlant/CLAUDE.md` (Project status section)
- Modify: `docs/HEALTH_ENGINE.md` if it documents the WatchFlower CSV as the sole data source
  (check first — add a note if so)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Check whether `docs/HEALTH_ENGINE.md` names WatchFlower as the only species-data
  source**

Run: `grep -n -i "watchflower" docs/HEALTH_ENGINE.md`
If it does, add one paragraph noting Parrot's own data now takes priority for matched species,
pointing to the new spec doc rather than duplicating its content (matches this project's own
stated convention: "Full explanation ... in docs/HEALTH_ENGINE.md — do not duplicate that detail
here", applied in reverse here to avoid duplicating the new spec's content back into
HEALTH_ENGINE.md).

- [ ] **Step 2: Add a CLAUDE.md project-status entry**

Insert a new entry under "## Project status (by batch)", following the exact style of neighboring
entries (bold title + date, bullet list of key decisions, a "Verified" line) — using Task 8's
recorded before/after numbers for the real-hardware-consequence bullet, and explicitly naming the
`dli_max=99`/`ec_min=-1` (kept raw, not nulled) and `n_wet=288`/`n_irr`/`n_irr_eco` (stored,
unconsumed, pending the BLE sniff) findings as documented-but-not-yet-acted-on, plus the
`attributes_numeric`/`attribute_to_number` locale-relativity finding and DestCom's explicit
"store but never read" call on it — consistent with how every other open finding in this file is
written up (e.g. the "Real hardware consequence" paragraphs in the Batch 5 entry, or the "Not yet
re-verified" closings used throughout).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/HEALTH_ENGINE.md
git commit -m "docs: document the Parrot plant database import"
```

---

## Self-review notes (from the plan author, not a task to execute)

- Spec coverage: source priority (Task 4), calibration fields stored now (Task 1+2), multi-locale
  text stored with no images (Task 3 + Task 5), filter-taxonomy attribute codes (Task 3 + Task 6),
  fertilizer types/search names/archival attribute-numbers from the exhaustive final field audit
  (Task 3 + Task 7), the raw-not-nulled sentinel decision (Task 2 tests), unit conversions (Task 2
  tests), independent idempotency for all seven import steps (Task 4/5/6/7 + Task 8 Step 5),
  matching rule / no fuzzy matching (Task 2's `resolveMatchId` + its test asserting a cultivar does
  *not* match) — all covered.
- The `normalizeName` duplication caught during Task 4's own drafting is called out explicitly in
  Task 4 Step 1 with the exact fix, rather than left as a latent inconsistency for the executor to
  notice on their own.
- pH/humidity/lux(lux) are asserted in the Global Constraints section as never touched by the
  overlay — Task 4's `data` object in `importParrotOverlay` does not list `soilPhMin`, `soilPhMax`,
  `humidityMinPercent`, `humidityMaxPercent`, `lightMinLux`, or `lightMaxLux`, matching that
  constraint exactly.
- **Caught twice during this plan's own drafting, fixed structurally the second time**: after
  structural/taxonomic fields were first added to `ParrotPlantRow` (Task 2) and `PlantProfile`
  (Task 1), Task 4's `importParrotOverlay` `data` object still only listed the original 14 fields
  by hand — the new ones would have been parsed by `parseParrotCsvLine` and then silently dropped,
  never reaching the database. Fixed once by manually adding the missing fields; when a *second*,
  larger round of fields arrived from the exhaustive field audit (44 CSV columns total by the end),
  hand-listing every field was abandoned as unreliable at this point and replaced with
  `const { name, commonName, ...data } = row` — everything on `ParrotPlantRow` except the two
  fields genuinely handled specially flows into `data` automatically, so this can't go stale again
  as more fields are added.
