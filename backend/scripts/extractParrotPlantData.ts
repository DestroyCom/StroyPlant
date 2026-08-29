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
import { gzipSync } from 'node:zlib';
import {
  buildParrotPlantRow,
  formatParrotCsvRow,
  type ParrotEncyclopediaEntry,
  type ParrotScientificProfile,
} from '../src/health/parrotPlantData.js';

const DEFAULT_APP_DIR = '/Applications/Flower Power.app/Wrapper/Flower Power.app';
const PROFILES_OUTPUT_PATH = fileURLToPath(new URL('../prisma/seed-data/parrot_plant_profiles.csv', import.meta.url));
// Gzipped, unlike the other 6 outputs: at 150MB+ raw JSON, the plain file exceeds GitHub's 100MB
// per-file limit (confirmed empirically when pushing this branch) — gzip shrinks it to ~11MB
// (~14x, this text compresses extremely well) with no new dependency (node:zlib is built-in).
const TRANSLATIONS_OUTPUT_PATH = fileURLToPath(new URL('../prisma/seed-data/parrot_plant_translations.json.gz', import.meta.url));
const ATTRIBUTES_OUTPUT_PATH = fileURLToPath(new URL('../prisma/seed-data/parrot_plant_attributes.json', import.meta.url));
const FERTILIZER_TYPES_OUTPUT_PATH = fileURLToPath(new URL('../prisma/seed-data/parrot_plant_fertilizer_types.json', import.meta.url));
const SEARCH_NAMES_OUTPUT_PATH = fileURLToPath(new URL('../prisma/seed-data/parrot_plant_search_names.json', import.meta.url));
// Archival only — see the PlantAttributeNumberMapping/PlantProfileAttributeNumber model comments
// in schema.prisma (Task 1) for why nothing may ever read these two files' imported data back out.
const ATTRIBUTE_NUMBER_MAPPING_OUTPUT_PATH = fileURLToPath(
  new URL('../prisma/seed-data/parrot_attribute_number_mapping.json', import.meta.url),
);
const ATTRIBUTE_NUMBERS_OUTPUT_PATH = fileURLToPath(new URL('../prisma/seed-data/parrot_plant_attribute_numbers.json', import.meta.url));

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
  console.log(`Wrote ${lines.length} rows to ${PROFILES_OUTPUT_PATH} (${skippedNoProfile} plants had no scientific profile).`);
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
      const preferredCommonName = entry.common_names?.find((c) => c.preferred)?.common_name ?? entry.common_names?.[0]?.common_name ?? null;
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

  writeFileSync(TRANSLATIONS_OUTPUT_PATH, gzipSync(JSON.stringify(translations)));
  console.log(`Wrote ${translations.length} translation rows to ${TRANSLATIONS_OUTPUT_PATH}.`);
  writeFileSync(SEARCH_NAMES_OUTPUT_PATH, JSON.stringify(searchNames), 'utf-8');
  console.log(`Wrote ${searchNames.length} search name rows to ${SEARCH_NAMES_OUTPUT_PATH}.`);
  writeFileSync(ATTRIBUTE_NUMBER_MAPPING_OUTPUT_PATH, JSON.stringify(attributeNumberMappings), 'utf-8');
  console.log(
    `Wrote ${attributeNumberMappings.length} attribute-number mapping rows (archival only) to ${ATTRIBUTE_NUMBER_MAPPING_OUTPUT_PATH}.`,
  );
  writeFileSync(ATTRIBUTE_NUMBERS_OUTPUT_PATH, JSON.stringify(attributeNumbers), 'utf-8');
  console.log(`Wrote ${attributeNumbers.length} plant attribute-number rows (archival only) to ${ATTRIBUTE_NUMBERS_OUTPUT_PATH}.`);
}

// Attribute codes (plant type, special features, bloom color, etc.) and fertilizer_type are
// structural, not translated text — reading the EN dump once is enough, the same codes appear
// identically in every locale's dump (confirmed empirically, unlike attributes_numeric above).
function extractAttributes(appDir: string): void {
  const encyclopedia = readZippedJson<{ plants: ParrotEncyclopediaEntryWithAttributes[] }>(appDir, 'EN_dump.json.zip', 'EN_dump.json');

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
  const encyclopedia = readZippedJson<{ plants: ParrotEncyclopediaEntryWithFertilizerType[] }>(appDir, 'EN_dump.json.zip', 'EN_dump.json');

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
