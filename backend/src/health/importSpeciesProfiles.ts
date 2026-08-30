import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { prisma } from '../db/client.js';
import { normalizeLatinName, parseParrotCsvLine, resolveMatchId } from './parrotPlantData.js';

// Batches the 5 large per-row upsert loops below into chunked transactions instead of one
// auto-commit per row — SQLite's per-statement fsync overhead made the unbatched version of
// importParrotAttributeNumbers()'s 641,165-row loop alone dominate an 8m9s real import run.
const IMPORT_CHUNK_SIZE = 500;

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
  const existingByNormalizedName = new Map(existingProfiles.map((p) => [normalizeLatinName(p.name), p.id]));

  const lines = readFileSync(PARROT_CSV_PATH, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0);

  let updated = 0;
  let created = 0;

  for (let i = 0; i < lines.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = lines.slice(i, i + IMPORT_CHUNK_SIZE);
    const operations = [];
    let chunkUpdated = 0;
    let chunkCreated = 0;
    for (const line of chunk) {
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
        operations.push(prisma.plantProfile.update({ where: { id: matchedId }, data }));
        chunkUpdated++;
      } else {
        operations.push(
          prisma.plantProfile.upsert({
            where: { name },
            update: data,
            create: { name, commonName, ...data },
          }),
        );
        chunkCreated++;
      }
    }
    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }
    updated += chunkUpdated;
    created += chunkCreated;
  }

  console.log(`Parrot overlay finished: ${updated} existing profiles updated, ${created} new profiles created.`);
}

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

const PARROT_TRANSLATIONS_PATH = fileURLToPath(new URL('../../prisma/seed-data/parrot_plant_translations.json.gz', import.meta.url));

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

  const rows: ParrotPlantTranslationRow[] = JSON.parse(gunzipSync(readFileSync(PARROT_TRANSLATIONS_PATH)).toString('utf-8'));

  let imported = 0;
  let skippedNoProfile = 0;
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK_SIZE);
    const operations = [];
    for (const row of chunk) {
      const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
      if (plantProfileId === undefined) {
        skippedNoProfile++;
        continue;
      }
      // Same destructuring approach as importParrotOverlay (Task 4) and for the same reason —
      // parrotSpeciesId/locale are handled explicitly (key lookup / unique constraint), everything
      // else on the row is a PlantProfileTranslation column and flows through automatically.
      const { parrotSpeciesId, locale, ...fields } = row;
      operations.push(
        prisma.plantProfileTranslation.upsert({
          where: { plantProfileId_locale: { plantProfileId, locale } },
          update: fields,
          create: { plantProfileId, locale, ...fields },
        }),
      );
    }
    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }
    imported += operations.length;
  }

  console.log(`Parrot translations import finished: ${imported} rows imported, ${skippedNoProfile} skipped (no matching profile).`);
}

interface ParrotPlantAttributeRow {
  parrotSpeciesId: number;
  category: string;
  value: string;
}

const PARROT_ATTRIBUTES_PATH = fileURLToPath(new URL('../../prisma/seed-data/parrot_plant_attributes.json', import.meta.url));

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
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK_SIZE);
    const operations = [];
    for (const row of chunk) {
      const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
      if (plantProfileId === undefined) {
        skippedNoProfile++;
        continue;
      }
      operations.push(
        prisma.plantProfileAttribute.upsert({
          where: { plantProfileId_category_value: { plantProfileId, category: row.category, value: row.value } },
          update: {},
          create: { plantProfileId, category: row.category, value: row.value },
        }),
      );
    }
    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }
    imported += operations.length;
  }

  console.log(`Parrot attributes import finished: ${imported} rows imported, ${skippedNoProfile} skipped (no matching profile).`);
}

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

const PARROT_FERTILIZER_TYPES_PATH = fileURLToPath(new URL('../../prisma/seed-data/parrot_plant_fertilizer_types.json', import.meta.url));
const PARROT_SEARCH_NAMES_PATH = fileURLToPath(new URL('../../prisma/seed-data/parrot_plant_search_names.json', import.meta.url));
const PARROT_ATTRIBUTE_NUMBER_MAPPING_PATH = fileURLToPath(
  new URL('../../prisma/seed-data/parrot_attribute_number_mapping.json', import.meta.url),
);
const PARROT_ATTRIBUTE_NUMBERS_PATH = fileURLToPath(new URL('../../prisma/seed-data/parrot_plant_attribute_numbers.json', import.meta.url));

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
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK_SIZE);
    const operations = [];
    for (const row of chunk) {
      const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
      if (plantProfileId === undefined) continue;
      operations.push(
        prisma.plantProfileFertilizerType.upsert({
          where: { plantProfileId_code: { plantProfileId, code: row.code } },
          update: {},
          create: { plantProfileId, code: row.code },
        }),
      );
    }
    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }
    imported += operations.length;
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
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK_SIZE);
    const operations = [];
    for (const row of chunk) {
      const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
      if (plantProfileId === undefined) continue;
      operations.push(
        prisma.plantProfileSearchName.upsert({
          where: {
            plantProfileId_locale_type_name: { plantProfileId, locale: row.locale, type: row.type, name: row.name },
          },
          update: {},
          create: { plantProfileId, locale: row.locale, name: row.name, type: row.type },
        }),
      );
    }
    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }
    imported += operations.length;
  }
  console.log(`Parrot search names import finished: ${imported} rows imported.`);
}

// Archival only — see PlantAttributeNumberMapping/PlantProfileAttributeNumber's schema.prisma
// comments (Task 1). Imported so the raw data isn't lost, never read by any other code.
async function importParrotAttributeNumbers(): Promise<void> {
  const existingMappingCount = await prisma.plantAttributeNumberMapping.count();
  if (existingMappingCount === 0 && existsSync(PARROT_ATTRIBUTE_NUMBER_MAPPING_PATH)) {
    const mappingRows: ParrotAttributeNumberMappingRow[] = JSON.parse(readFileSync(PARROT_ATTRIBUTE_NUMBER_MAPPING_PATH, 'utf-8'));
    for (let i = 0; i < mappingRows.length; i += IMPORT_CHUNK_SIZE) {
      const chunk = mappingRows.slice(i, i + IMPORT_CHUNK_SIZE);
      await prisma.$transaction(
        chunk.map((row) =>
          prisma.plantAttributeNumberMapping.upsert({
            where: { locale_code: { locale: row.locale, code: row.code } },
            update: { number: row.number },
            create: row,
          }),
        ),
      );
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
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK_SIZE);
    const operations = [];
    for (const row of chunk) {
      const plantProfileId = profileIdBySpeciesId.get(row.parrotSpeciesId);
      if (plantProfileId === undefined) continue;
      operations.push(
        prisma.plantProfileAttributeNumber.upsert({
          where: { plantProfileId_locale_number: { plantProfileId, locale: row.locale, number: row.number } },
          update: {},
          create: { plantProfileId, locale: row.locale, number: row.number },
        }),
      );
    }
    if (operations.length > 0) {
      await prisma.$transaction(operations);
    }
    imported += operations.length;
  }
  console.log(`Parrot plant attribute-numbers import finished: ${imported} rows imported (archival only).`);
}

async function main(): Promise<void> {
  await importWatchFlowerProfiles();
  await importParrotOverlay();
  await importParrotTranslations();
  await importParrotAttributes();
  await importParrotFertilizerTypes();
  await importParrotSearchNames();
  await importParrotAttributeNumbers();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Échec de l'import des profils de plantes:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
