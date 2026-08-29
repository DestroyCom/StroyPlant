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
  return name.toLowerCase().replace(/×/g, 'x').replace(/\s+/g, ' ').trim();
}

function orNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

export function buildParrotPlantRow(entry: ParrotEncyclopediaEntry, profile: ParrotScientificProfile): ParrotPlantRow {
  const preferredCommonName = entry.common_names?.find((c) => c.preferred)?.common_name ?? entry.common_names?.[0]?.common_name ?? null;

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
const BOOLEAN_COLUMNS = new Set<(typeof PARROT_CSV_COLUMNS)[number]>(['noFert', 'hidden', 'isTaxonomyGroupHead']);

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

export function resolveMatchId(name: string, existingByNormalizedName: ReadonlyMap<string, number>): number | undefined {
  return existingByNormalizedName.get(normalizeLatinName(name));
}
