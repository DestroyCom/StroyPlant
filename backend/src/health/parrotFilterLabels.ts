// Label resolution for the ~65 PlantProfileAttribute/PlantProfileFertilizerType codes with a
// confirmed French label, extracted manually from the official "Flower Power" iOS app's own
// FilterValues.plist/PlantDetailsInfo.plist/fr.lproj/Localizable.strings during the brainstorming
// for docs/superpowers/specs/2026-08-31-plant-database-page-design.md — see that spec's "spike"
// section for the full coverage table and methodology. A code with no entry here is NEVER shown to
// the user (see the design's "Règle d'affichage") — this module is the single source of truth for
// which codes are safe to surface.

export interface ResolvedAttributeLabel {
  group: string;
  groupLabel: string;
  valueLabel: string;
}

interface AttributeGroupDef {
  group: string;
  groupLabel: string;
  values: Record<string, string>;
}

// PlantProfileAttribute.category = "PT" mixes two distinct dimensions (plant type AND lifecycle)
// under the same raw code — Parrot's own raw `attributes` JSON does this, not an import bug (see
// the design spec). The two value sets never overlap, so resolution is unambiguous.
const PT_TYPE_VALUES: Record<string, string> = {
  SH: 'Arbuste',
  VI: 'Plante grimpante',
  TR: 'Arbre',
  IP: "Plante d'intérieur",
  ED: 'Comestible',
  GR: 'Herbe',
};

const PT_LIFETIME_VALUES: Record<string, string> = {
  AN: 'Annuel',
  PE: 'Vivace',
  BA: 'Bi-annuelle',
};

const BL_BLOOM_COLOR_VALUES: Record<string, string> = {
  BL: 'Bleu',
  WH: 'Blanc',
  OR: 'Orange',
  PU: 'Pourpre',
  GR: 'Vert',
  BK: 'Noir',
  PI: 'Rose',
  YE: 'Jaune',
  RE: 'Rouge',
};

const FO_LEAF_COLOR_VALUES: Record<string, string> = {
  PU: 'Pourpre',
  SI: 'Argenté',
  BR: 'Bronze ou Marron',
  RE: 'Rouge',
  WH: 'Blanc',
  YE: 'Jaune',
  PI: 'Rose',
  OR: 'Orange',
  GR: 'Vert',
  BK: 'Noir',
  BL: 'Bleu',
  VA: 'Panaché',
};

const SH_SHAPE_VALUES: Record<string, string> = {
  IR: 'Irrégulière',
  PY: 'Pyramidale',
  RO: 'Arrondie',
  SP: 'Déployée',
  UP: 'Droite',
};

// From PlantDetailsInfo.plist, not FilterValues.plist — a separate bundle file, same resolution
// method. Real data never contains "FO" for this category (checked against dev.db during the
// spike) — kept anyway since it's part of the app's own definition, harmless if it ever appears.
const SF_SPECIAL_FEATURES_VALUES: Record<string, string> = {
  AB: 'Attire les oiseaux',
  AF: 'Feuillage luxuriant',
  ED: 'Comestible',
  FO: "Pas d'origine Nord Américaine",
};

// Real PlantProfileAttribute rows for category "SN" use a completely different code scheme
// (EE/EF/ES/… observed in dev.db) than this plist-derived one (FA/SP/WI/SU) — this will never
// actually match any real row, kept only for completeness/documentation, see the design spec's
// coverage table (0/12 for this category).
const SN_BLOOM_SEASON_VALUES: Record<string, string> = {
  FA: 'Automne',
  SP: 'Printemps',
  WI: 'Hiver',
  SU: 'Été',
};

const ATTRIBUTE_GROUPS_BY_CATEGORY: Record<string, AttributeGroupDef[]> = {
  PT: [
    { group: 'type', groupLabel: 'Type', values: PT_TYPE_VALUES },
    { group: 'lifetime', groupLabel: 'Cycle', values: PT_LIFETIME_VALUES },
  ],
  BL: [{ group: 'bloomColor', groupLabel: 'Couleur de floraison', values: BL_BLOOM_COLOR_VALUES }],
  FO: [{ group: 'leafColor', groupLabel: 'Couleur des feuilles', values: FO_LEAF_COLOR_VALUES }],
  SH: [{ group: 'shape', groupLabel: 'Forme de la plante', values: SH_SHAPE_VALUES }],
  SF: [{ group: 'specialFeatures', groupLabel: 'Particularités', values: SF_SPECIAL_FEATURES_VALUES }],
  SN: [{ group: 'bloomSeason', groupLabel: 'Saison de floraison', values: SN_BLOOM_SEASON_VALUES }],
};

// `category`/`value` originate from user-controlled tRPC input (plants.search's attributeFilters,
// plants.getById via stored PlantProfileAttribute rows) — Object.hasOwn guards below reject
// inherited Object.prototype keys (e.g. category="toString", value="constructor") that would
// otherwise resolve to a prototype method instead of `undefined`/absent, which is truthy and — for
// `groups` — not iterable, crashing the request.
export function resolveAttributeLabel(category: string, value: string): ResolvedAttributeLabel | null {
  if (!Object.hasOwn(ATTRIBUTE_GROUPS_BY_CATEGORY, category)) return null;
  const groups = ATTRIBUTE_GROUPS_BY_CATEGORY[category];
  for (const groupDef of groups) {
    if (!Object.hasOwn(groupDef.values, value)) continue;
    const valueLabel = groupDef.values[value];
    return { group: groupDef.group, groupLabel: groupDef.groupLabel, valueLabel };
  }
  return null;
}

// fertilizer_type_1..22, French labels — verified against fr.lproj/Localizable.strings during the
// spike. PlantProfileFertilizerType.code is already this exact numeric key, no dimension split
// needed (unlike PlantProfileAttribute's "PT" above).
const FERTILIZER_TYPE_LABELS: Record<number, string> = {
  1: 'tout usage',
  2: 'palmier',
  3: 'cactus',
  4: 'orchidée',
  5: 'poacée',
  6: 'bougainvillier',
  7: 'citronnier',
  8: 'fraisier',
  9: 'laurier-rose',
  10: 'olivier',
  11: 'pélargonium',
  12: 'rhododendron',
  13: 'rose',
  14: 'tomate',
  15: 'hortensia et hydrangéa',
  16: 'bambou',
  17: 'bulbes',
  18: 'buissons',
  19: 'arbres fruitiers',
  20: 'herbes aromatiques',
  21: 'arbustes à fleurs',
  22: 'légumes du potager',
};

export function resolveFertilizerTypeLabel(code: number): string | null {
  return FERTILIZER_TYPE_LABELS[code] ?? null;
}

export interface AttributeFilterGroup {
  category: string;
  group: string;
  groupLabel: string;
  options: { value: string; label: string }[];
}

// Single source of truth for which attribute filters the frontend is allowed to offer — every
// entry here is guaranteed resolvable by resolveAttributeLabel above, so a filter proposed to the
// user can never correspond to an unlabeled code.
export function listKnownAttributeFilters(): AttributeFilterGroup[] {
  const result: AttributeFilterGroup[] = [];
  for (const [category, groups] of Object.entries(ATTRIBUTE_GROUPS_BY_CATEGORY)) {
    for (const groupDef of groups) {
      // bloomSeason is excluded from the filter UI: real PlantProfileAttribute rows for "SN" use a
      // different code scheme than this plist-derived one (0/12 overlap, confirmed against real
      // data) — offering it as a filter would always return zero results. Kept in
      // ATTRIBUTE_GROUPS_BY_CATEGORY (and still resolvable) in case real data ever matches it.
      if (groupDef.group === 'bloomSeason') continue;
      result.push({
        category,
        group: groupDef.group,
        groupLabel: groupDef.groupLabel,
        options: Object.entries(groupDef.values).map(([value, label]) => ({ value, label })),
      });
    }
  }
  return result;
}
