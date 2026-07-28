import { prisma } from '../db/client.js';

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

async function main() {
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

  console.log(`Import finished: ${imported} profiles imported, ${skipped} rows skipped (missing name).`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Échec de l'import des profils de plantes:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
