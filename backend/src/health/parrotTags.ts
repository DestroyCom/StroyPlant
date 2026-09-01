// Label resolution for PlantProfile.tags (bitmask) — confirmed against the real decompiled
// Android source (com.parrot.flowerpower.android.PlantDB.PlantDBManager, MASK_* constants +
// res/values-fr/strings.xml's tags_categoryName_* entries), not inferred. Bit 256 (orchid) was the
// only one previously confirmed in this project (via DataManager.java's isOrchid usage) — the
// other 8 were resolved on 2026-09-01 by reading PlantDBManager.java directly, which also
// independently confirmed every bit this project had already spot-checked empirically (e.g. bit 1
// → cacti/succulents, matching real PlantProfile rows with a single-bit tags value).
//
// Bit 512 (MASK_CANNABIS) exists as a constant in the same source but has no localized label
// anywhere in either app build (its getTagString() switch has no case for it, falling through to
// the raw string "cannabis") — deliberately excluded here, matching the app's own choice to never
// surface it as a user-facing category.
const TAG_LABELS: Record<number, string> = {
  1: 'Cactus et plantes grasses',
  2: 'Plantes à feuillage décoratif',
  4: 'Plantes fleuries',
  8: 'Fruits et légumes',
  16: "Plantes d'intérieur",
  32: "Plantes d'extérieur",
  64: 'Plantes de bien-être',
  128: 'Arbustes',
  256: 'Orchidées et plantes originales',
};

export interface TagOption {
  bit: number;
  label: string;
}

// Single source of truth for which tag bits are safe to offer as a filter or display as a badge —
// mirrors parrotFilterLabels.ts's "never show/use an unconfirmed code" contract for this separate
// bitmask data source.
export function listKnownTags(): TagOption[] {
  return Object.entries(TAG_LABELS)
    .map(([bit, label]) => ({ bit: Number(bit), label }))
    .sort((a, b) => a.bit - b.bit);
}

export function resolveTagLabels(tags: number | null): string[] {
  if (tags == null) return [];
  return Object.entries(TAG_LABELS)
    .filter(([bit]) => (tags & Number(bit)) !== 0)
    .map(([, label]) => label);
}
