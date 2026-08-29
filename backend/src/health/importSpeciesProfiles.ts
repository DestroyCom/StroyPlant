import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '../db/client.js';
import { normalizeLatinName, parseParrotCsvLine, resolveMatchId } from './parrotPlantData.js';

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
