# Base de plantes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a searchable, filterable "Base de plantes" page (list + detail) over the 9120
already-imported `PlantProfile` rows, reproducing the official Flower Power app's Description/
Entretien content, with a navbar link.

**Architecture:** A new `plants` tRPC router (`search`, `getById`, `listFilters`) backed by plain
Prisma queries (no new tables, no FTS5 — see spec's YAGNI rationale), a small pure-logic label
resolution module (`parrotFilterLabels.ts`) for the ~65 `PlantProfileAttribute`/
`PlantProfileFertilizerType` codes that have a confirmed French label, and two new TanStack Router
routes (`/plants`, `/plants/$id`) using existing shadcn components plus one new one (`checkbox`).

**Tech Stack:** TypeScript, Prisma/SQLite, tRPC, React 19, TanStack Router/Query, Tailwind v4,
shadcn/ui, Biome, Node's built-in `node:test`.

**Spec:** `docs/superpowers/specs/2026-08-31-plant-database-page-design.md` (sub-project 1 of
`docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md`).

## Global Constraints

- `pnpm` exclusively, never `npm`/`yarn`.
- TypeScript everywhere, no Python.
- Biome formatting (2 spaces, single quotes) — run `npx biome check --write <files>` from the repo
  root before each commit if unsure.
- Locales in `PlantProfileSearchName`/`PlantProfileTranslation` are stored **uppercase**
  (`'FR'`, `'EN'`, …) — verified on real data during brainstorming, do not use lowercase `'fr'`.
- A `PlantProfileAttribute`/`PlantProfileFertilizerType` code with no confirmed label is **never**
  shown to the user, in any form (not the raw code either) — silently omitted.
- `PlantProfile.tags` (bitmask): only bit `256` (orchid) is confirmed in this project. Do not
  invent labels or filters for any other bit — verified ambiguous/contradictory during this plan's
  own writing (see spec's correction).
- No plant images anywhere in this feature — a generic icon placeholder only (`Sprout` from
  `lucide-react`).
- Consultation only — no "assign to a device" action anywhere in this feature.
- Frontend typecheck command is `cd frontend && pnpm typecheck` — **never** the bare
  `npx tsc --noEmit` (documented no-op in `CLAUDE.md`'s Gotchas section, silently checks zero
  files).

---

### Task 1: `parrotFilterLabels.ts` — label resolution module

**Files:**
- Create: `backend/src/health/parrotFilterLabels.ts`
- Create: `backend/src/health/parrotFilterLabels.test.ts`

**Interfaces:**
- Produces: `resolveAttributeLabel(category: string, value: string): { group: string; groupLabel: string; valueLabel: string } | null`,
  `resolveFertilizerTypeLabel(code: number): string | null`,
  `listKnownAttributeFilters(): { category: string; group: string; groupLabel: string; options: { value: string; label: string }[] }[]`
  — consumed by Task 2/3's `plants` router. No other task's output is consumed here.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/health/parrotFilterLabels.test.ts`:

```ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listKnownAttributeFilters, resolveAttributeLabel, resolveFertilizerTypeLabel } from './parrotFilterLabels.js';

describe('resolveAttributeLabel', () => {
  it('resolves a PT type-dimension value', () => {
    assert.deepEqual(resolveAttributeLabel('PT', 'IP'), { group: 'type', groupLabel: 'Type', valueLabel: "Plante d'intérieur" });
  });

  it('resolves a PT lifetime-dimension value with a different group than type', () => {
    assert.deepEqual(resolveAttributeLabel('PT', 'PE'), { group: 'lifetime', groupLabel: 'Cycle', valueLabel: 'Vivace' });
  });

  it('returns null for a PT value belonging to neither known dimension', () => {
    assert.equal(resolveAttributeLabel('PT', 'AQ'), null);
  });

  it('resolves a leaf color (FO)', () => {
    assert.deepEqual(resolveAttributeLabel('FO', 'GR'), { group: 'leafColor', groupLabel: 'Couleur des feuilles', valueLabel: 'Vert' });
  });

  it('resolves a bloom color (BL)', () => {
    assert.deepEqual(resolveAttributeLabel('BL', 'PI'), { group: 'bloomColor', groupLabel: 'Couleur de floraison', valueLabel: 'Rose' });
  });

  it('resolves a plant shape (SH)', () => {
    assert.deepEqual(resolveAttributeLabel('SH', 'RO'), { group: 'shape', groupLabel: 'Forme de la plante', valueLabel: 'Arrondie' });
  });

  it('resolves a special feature (SF)', () => {
    assert.deepEqual(resolveAttributeLabel('SF', 'AB'), { group: 'specialFeatures', groupLabel: 'Particularités', valueLabel: 'Attire les oiseaux' });
  });

  it('returns null for an unknown category entirely', () => {
    assert.equal(resolveAttributeLabel('ZZ', 'AB'), null);
  });

  it('returns null for a known category with an unknown value', () => {
    assert.equal(resolveAttributeLabel('SH', 'ZZ'), null);
  });
});

describe('resolveFertilizerTypeLabel', () => {
  it('resolves a known code', () => {
    assert.equal(resolveFertilizerTypeLabel(4), 'orchidée');
  });

  it('resolves the last known code (22)', () => {
    assert.equal(resolveFertilizerTypeLabel(22), 'légumes du potager');
  });

  it('returns null for an unknown code', () => {
    assert.equal(resolveFertilizerTypeLabel(99), null);
  });
});

describe('listKnownAttributeFilters', () => {
  it('lists exactly 7 logical groups across the 6 raw categories, PT split in two', () => {
    const groups = listKnownAttributeFilters();
    assert.equal(groups.length, 7);
    const groupNames = groups.map((g) => g.group).sort();
    assert.deepEqual(groupNames, ['bloomColor', 'bloomSeason', 'leafColor', 'lifetime', 'shape', 'specialFeatures', 'type']);
  });

  it('both PT-derived groups carry category "PT"', () => {
    const groups = listKnownAttributeFilters();
    const type = groups.find((g) => g.group === 'type');
    const lifetime = groups.find((g) => g.group === 'lifetime');
    assert.equal(type?.category, 'PT');
    assert.equal(lifetime?.category, 'PT');
  });

  it('the leafColor group has exactly 12 options', () => {
    const groups = listKnownAttributeFilters();
    const leafColor = groups.find((g) => g.group === 'leafColor');
    assert.equal(leafColor?.options.length, 12);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && pnpm test`
Expected: FAIL — `Cannot find module './parrotFilterLabels.js'` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `backend/src/health/parrotFilterLabels.ts`:

```ts
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

export function resolveAttributeLabel(category: string, value: string): ResolvedAttributeLabel | null {
  const groups = ATTRIBUTE_GROUPS_BY_CATEGORY[category];
  if (!groups) return null;
  for (const groupDef of groups) {
    const valueLabel = groupDef.values[value];
    if (valueLabel) return { group: groupDef.group, groupLabel: groupDef.groupLabel, valueLabel };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && pnpm test`
Expected: PASS (all tests in `parrotFilterLabels.test.ts`, plus every pre-existing test still
passing).

- [ ] **Step 5: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && npx biome check --write backend/src/health/parrotFilterLabels.ts backend/src/health/parrotFilterLabels.test.ts`
Expected: clean or auto-fixed.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/health/parrotFilterLabels.ts backend/src/health/parrotFilterLabels.test.ts
git commit -m "feat(backend): add Parrot plant attribute/fertilizer-type label resolution"
```

---

### Task 2: `plants` tRPC router — `search` and `listFilters`

**Files:**
- Create: `backend/src/api/trpc/routers/plants.ts`
- Modify: `backend/src/api/trpc/router.ts`

**Interfaces:**
- Consumes: `resolveFertilizerTypeLabel`, `listKnownAttributeFilters` from Task 1's
  `backend/src/health/parrotFilterLabels.js` (only `listKnownAttributeFilters` is used in this
  task; `resolveFertilizerTypeLabel` and `resolveAttributeLabel` are consumed by Task 3).
- Produces: `plantsRouter` with procedures `search(input: { search?: string; orchidOnly?: boolean;
  attributeFilters?: { category: string; value: string }[]; page: number; pageSize: number }) =>
  { items: PlantSummary[]; total: number }` where `PlantSummary = { id: number; name: string;
  commonName: string | null; hasParrotData: boolean; isOrchid: boolean }`, and
  `listFilters() => AttributeFilterGroup[]` (same shape as Task 1's `listKnownAttributeFilters`
  return type). Task 3 adds `getById` to the same router. Task 4 (frontend) consumes both
  `search` and `listFilters`.

- [ ] **Step 1: Create the router file**

Create `backend/src/api/trpc/routers/plants.ts`:

```ts
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { listKnownAttributeFilters } from '../../../health/parrotFilterLabels.js';
import { protectedProcedure, router } from '../trpc.js';

const ORCHID_TAG_BIT = 256;

async function findOrchidProfileIds(): Promise<number[]> {
  const rows = await prisma.plantProfile.findMany({ where: { tags: { not: null } }, select: { id: true, tags: true } });
  return rows.filter((row) => row.tags != null && (row.tags & ORCHID_TAG_BIT) !== 0).map((row) => row.id);
}

export const plantsRouter = router({
  listFilters: protectedProcedure.query(() => listKnownAttributeFilters()),

  search: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        orchidOnly: z.boolean().optional(),
        attributeFilters: z.array(z.object({ category: z.string(), value: z.string() })).optional(),
        page: z.number().int().min(1),
        pageSize: z.number().int().min(1).max(100),
      }),
    )
    .query(async ({ input }) => {
      const search = input.search?.trim();
      const and: object[] = [];

      if (search) {
        and.push({
          OR: [
            { name: { contains: search } },
            { commonName: { contains: search } },
            { searchNames: { some: { locale: 'FR', name: { contains: search } } } },
          ],
        });
      }

      if (input.orchidOnly) {
        and.push({ id: { in: await findOrchidProfileIds() } });
      }

      const filtersByCategory = new Map<string, string[]>();
      for (const filter of input.attributeFilters ?? []) {
        const values = filtersByCategory.get(filter.category) ?? [];
        values.push(filter.value);
        filtersByCategory.set(filter.category, values);
      }
      for (const [category, values] of filtersByCategory) {
        and.push({ attributes: { some: { category, value: { in: values } } } });
      }

      const where = { AND: and };

      const [items, total] = await Promise.all([
        prisma.plantProfile.findMany({
          where,
          orderBy: { name: 'asc' },
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
          include: { translations: { where: { locale: 'FR' } } },
        }),
        prisma.plantProfile.count({ where }),
      ]);

      return {
        items: items.map((profile) => ({
          id: profile.id,
          name: profile.name,
          commonName: profile.translations[0]?.commonName ?? profile.commonName ?? null,
          hasParrotData: profile.parrotSpeciesId != null,
          isOrchid: profile.tags != null && (profile.tags & ORCHID_TAG_BIT) !== 0,
        })),
        total,
      };
    }),
});
```

- [ ] **Step 2: Register the router**

In `backend/src/api/trpc/router.ts`, add the import in alphabetical order with the existing ones:

```ts
import { plantDrRouter } from './routers/plantDr.js';
import { plantsRouter } from './routers/plants.js';
import { pollSettingsRouter } from './routers/pollSettings.js';
```

And add the entry to `appRouter`, also alphabetically:

```ts
  plantDr: plantDrRouter,
  plants: plantsRouter,
  pollSettings: pollSettingsRouter,
```

- [ ] **Step 3: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the backend test suite**

Run: `cd backend && pnpm test`
Expected: all tests still pass (this task adds no new automated tests — matches this project's
established convention for Prisma-orchestration code, see the design spec's "Tests" section;
verified manually in Task 6).

- [ ] **Step 5: Manual smoke test against real data**

Run: `cd backend && BLE_PROVIDER=mock pnpm dev` (leave running), then in another terminal, sign in
first to get a session cookie (replace credentials with your local admin, see `pnpm seed:admin` in
`CLAUDE.md` if you don't have one) and call the procedure:

```bash
curl -s -c /tmp/cookies.txt -X POST http://localhost:3000/api/auth/sign-in/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@admin.com","password":"admin"}' > /dev/null

curl -s -b /tmp/cookies.txt 'http://localhost:3000/api/trpc/plants.search?input=%7B%22page%22%3A1%2C%22pageSize%22%3A5%2C%22search%22%3A%22ficus%22%7D'
```

Expected: JSON with `result.data.items` containing 5 or fewer entries whose `name` or
`commonName` contains "ficus"/"Ficus", and `result.data.total` reflecting the real count in
`dev.db`. Also test `plants.listFilters` (`GET .../plants.listFilters`) and confirm it returns 7
groups (matching Task 1's test).

- [ ] **Step 6: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && npx biome check --write backend/src/api/trpc/routers/plants.ts backend/src/api/trpc/router.ts`
Expected: clean or auto-fixed.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/api/trpc/routers/plants.ts backend/src/api/trpc/router.ts
git commit -m "feat(backend): add plants.search and plants.listFilters tRPC procedures"
```

---

### Task 3: `plants` tRPC router — `getById`

**Files:**
- Modify: `backend/src/api/trpc/routers/plants.ts`

**Interfaces:**
- Consumes: `resolveAttributeLabel`, `resolveFertilizerTypeLabel` from Task 1.
- Produces: `getById(input: { id: number }) => PlantDetail`, thrown `TRPCError({code:'NOT_FOUND'})`
  on a missing id. `PlantDetail` shape is given in full in Step 1 below — Task 5 (frontend detail
  page) consumes every field of it.

- [ ] **Step 1: Add the procedure**

In `backend/src/api/trpc/routers/plants.ts`, add the import:

```ts
import { TRPCError } from '@trpc/server';
import { listKnownAttributeFilters, resolveAttributeLabel, resolveFertilizerTypeLabel } from '../../../health/parrotFilterLabels.js';
```

(replacing the single-name import from Task 2 with this 3-name one), then add to the `plantsRouter`
object, after `search`:

```ts
  getById: protectedProcedure.input(z.object({ id: z.number().int() })).query(async ({ input }) => {
    const profile = await prisma.plantProfile.findUnique({
      where: { id: input.id },
      include: {
        translations: { where: { locale: 'FR' } },
        attributes: true,
        fertilizerTypes: true,
        searchNames: { where: { locale: 'FR', type: 0 } },
      },
    });
    if (!profile) throw new TRPCError({ code: 'NOT_FOUND', message: 'Espèce introuvable' });

    const translation = profile.translations[0] ?? null;
    const commonNames = [...new Set(profile.searchNames.map((entry) => entry.name))];

    const resolvedAttributes = profile.attributes
      .map((attribute) => resolveAttributeLabel(attribute.category, attribute.value))
      .filter((resolved): resolved is NonNullable<typeof resolved> => resolved != null);

    const fertilizerTypeLabels = profile.fertilizerTypes
      .map((entry) => resolveFertilizerTypeLabel(entry.code))
      .filter((label): label is string => label != null);

    return {
      id: profile.id,
      name: profile.name,
      genusName: profile.genusName,
      speciesName: profile.speciesName,
      synonyms: profile.synonyms,
      commonNames,
      commonName: translation?.commonName ?? profile.commonName ?? null,
      hasParrotData: profile.parrotSpeciesId != null,
      isOrchid: profile.tags != null && (profile.tags & ORCHID_TAG_BIT) !== 0,
      heightMinCm: profile.heightMinCm,
      heightMaxCm: profile.heightMaxCm,
      spreadMinCm: profile.spreadMinCm,
      spreadMaxCm: profile.spreadMaxCm,
      soilMoistureMinPercent: profile.soilMoistureMinPercent,
      soilMoistureMaxPercent: profile.soilMoistureMaxPercent,
      soilConductivityMinUsCm: profile.soilConductivityMinUsCm,
      soilConductivityMaxUsCm: profile.soilConductivityMaxUsCm,
      temperatureMinC: profile.temperatureMinC,
      temperatureMaxC: profile.temperatureMaxC,
      lightMinMmol: profile.lightMinMmol,
      lightMaxMmol: profile.lightMaxMmol,
      sunCategory: profile.sunCategory,
      waterCategory: profile.waterCategory,
      fertilizerCategory: profile.fertilizerCategory,
      hardinessZoneMinValue: profile.hardinessZoneMinValue,
      hardinessZoneMaxValue: profile.hardinessZoneMaxValue,
      description: translation?.description ?? null,
      interesting: translation?.interesting ?? null,
      planting: translation?.planting ?? null,
      growth: translation?.growth ?? null,
      blooming: translation?.blooming ?? null,
      harvesting: translation?.harvesting ?? null,
      soilIrr: translation?.soilIrr ?? null,
      fertilizerText: translation?.fertilizerText ?? null,
      pruning: translation?.pruning ?? null,
      pests: translation?.pests ?? null,
      detailCare: translation?.detailCare ?? null,
      hardinessZoneMinText: translation?.hardinessZoneMinText ?? null,
      hardinessZoneMaxText: translation?.hardinessZoneMaxText ?? null,
      heatZoneMinText: translation?.heatZoneMinText ?? null,
      heatZoneMaxText: translation?.heatZoneMaxText ?? null,
      resolvedAttributes,
      fertilizerTypeLabels,
    };
  }),
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && pnpm exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Manual smoke test against real data**

With the backend still running (`BLE_PROVIDER=mock pnpm dev`, from Task 2), find a real Ficus
benjamina id and fetch its detail:

```bash
sqlite3 backend/prisma/dev.db "SELECT id FROM PlantProfile WHERE name='Ficus benjamina';"
# use the printed id below, e.g. 1234
curl -s -b /tmp/cookies.txt 'http://localhost:3000/api/trpc/plants.getById?input=%7B%22id%22%3A1234%7D' | python3 -m json.tool
```

Expected: `result.data.commonName` = "Figuier Pleureur", `result.data.commonNames` contains both
"Figuier Pleureur" and "Ficus Benjamina", `result.data.synonyms` = "Ficus nitida",
`result.data.resolvedAttributes` is a non-empty array of `{group, groupLabel, valueLabel}` objects
with real French labels (no raw codes). Also test a nonexistent id (e.g. `999999999`) and confirm
an HTTP error response with `NOT_FOUND`, not a 500 or a hang.

- [ ] **Step 4: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && npx biome check --write backend/src/api/trpc/routers/plants.ts`
Expected: clean or auto-fixed.

- [ ] **Step 5: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add backend/src/api/trpc/routers/plants.ts
git commit -m "feat(backend): add plants.getById tRPC procedure"
```

---

### Task 4: Frontend — `/plants` list route + navbar link

**Files:**
- Create: `frontend/src/routes/_authenticated/plants.tsx`
- Modify: `frontend/src/components/app-shell.tsx` (navbar link)

**Interfaces:**
- Consumes: `trpc.plants.search`, `trpc.plants.listFilters` (Task 2) — types are inferred
  automatically from the tRPC router, no manual mirror needed in `frontend/src/lib/types.ts` (that
  file's existing manual types exist specifically to work around `Date` serialization, see its own
  header comment; `plants.search`/`plants.listFilters` have no `Date` fields, so plain tRPC
  inference is correct and sufficient here).
- Produces: route `/plants`, linked from the navbar. Task 5's `/plants/$id` route is linked *from*
  this task's result cards (`<Link to="/plants/$id" params={{id: String(item.id)}}>`), but this
  task does not depend on Task 5 existing yet — TanStack Router resolves the link at runtime, not
  at build time, and the route can be visited by directly navigating to `/plants/$id` once Task 5
  lands.

- [ ] **Step 1: Add the shadcn `checkbox` component**

Run: `cd frontend && pnpm dlx shadcn@latest add checkbox`
Expected: creates `frontend/src/components/ui/checkbox.tsx` (vendored shadcn code, not
hand-reformatted — same convention as every other file in that folder, see `CLAUDE.md`'s Frontend
section).

- [ ] **Step 2: Create the list route**

Create `frontend/src/routes/_authenticated/plants.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Sprout } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';

export const Route = createFileRoute('/_authenticated/plants')({
  component: PlantsListPage,
});

const PAGE_SIZE = 24;

function PlantsListPage() {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [orchidOnly, setOrchidOnly] = useState(false);
  const [selectedFilters, setSelectedFilters] = useState<{ category: string; value: string }[]>([]);
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, orchidOnly, selectedFilters]);

  const { data: filterGroups } = useQuery(trpc.plants.listFilters.queryOptions());

  const { data, isFetching } = useQuery(
    trpc.plants.search.queryOptions({
      search: debouncedSearch || undefined,
      orchidOnly: orchidOnly || undefined,
      attributeFilters: selectedFilters.length > 0 ? selectedFilters : undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  );

  function toggleFilter(category: string, value: string, checked: boolean) {
    setSelectedFilters((prev) => {
      if (checked) return [...prev, { category, value }];
      return prev.filter((filter) => !(filter.category === category && filter.value === value));
    });
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-foreground">Base de plantes</h1>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input placeholder="Rechercher une espèce…" value={search} onChange={(event) => setSearch(event.target.value)} className="max-w-xs" />
        <div className="flex items-center gap-2">
          <Checkbox id="orchid-only" checked={orchidOnly} onCheckedChange={(checked) => setOrchidOnly(checked === true)} />
          <Label htmlFor="orchid-only">Orchidées uniquement</Label>
        </div>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="outline">Filtres avancés{selectedFilters.length > 0 ? ` (${selectedFilters.length})` : ''}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Filtres avancés</DialogTitle>
            </DialogHeader>
            <div className="flex max-h-96 flex-col gap-4 overflow-y-auto">
              {filterGroups?.map((group) => (
                <div key={group.group} className="flex flex-col gap-1.5">
                  <span className="text-sm font-semibold text-foreground">{group.groupLabel}</span>
                  {group.options.map((option) => {
                    const checked = selectedFilters.some((filter) => filter.category === group.category && filter.value === option.value);
                    return (
                      <div key={option.value} className="flex items-center gap-2">
                        <Checkbox
                          id={`${group.group}-${option.value}`}
                          checked={checked}
                          onCheckedChange={(next) => toggleFilter(group.category, option.value, next === true)}
                        />
                        <Label htmlFor={`${group.group}-${option.value}`}>{option.label}</Label>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {isFetching && !data && <p className="text-sm text-muted-foreground">Chargement…</p>}
      {data && data.items.length === 0 && <p className="text-sm text-muted-foreground">Aucune espèce trouvée.</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {data?.items.map((item) => (
          <Link key={item.id} to="/plants/$id" params={{ id: String(item.id) }}>
            <Card className="flex flex-col gap-1 p-4 hover:bg-muted">
              <div className="flex items-center gap-2">
                <Sprout size={16} className="text-muted-foreground" />
                {item.isOrchid && <Badge variant="secondary">Orchidée</Badge>}
              </div>
              <span className="text-sm font-medium text-foreground">{item.commonName ?? item.name}</span>
              <span className="text-xs italic text-muted-foreground">{item.name}</span>
            </Card>
          </Link>
        ))}
      </div>

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" disabled={page <= 1} onClick={() => setPage((prev) => prev - 1)}>
            Précédent
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} sur {totalPages} ({data.total} résultats)
          </span>
          <Button variant="outline" disabled={page >= totalPages} onClick={() => setPage((prev) => prev + 1)}>
            Suivant
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Add the navbar link**

In `frontend/src/components/app-shell.tsx`, add the import:

```ts
import { Clock, Home, LogOut, PlusCircle, Settings, Sprout } from 'lucide-react';
```

Then, in the desktop sidebar `<nav>`, add this `Link` right after the "Tableau de bord" one and
before "Historique":

```tsx
          <Link
            to="/plants"
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent',
              'data-[status=active]:font-bold data-[status=active]:text-sidebar-foreground [&[data-status=active]_svg]:text-sidebar-accent-foreground',
            )}
          >
            <Sprout size={18} />
            Base de plantes
          </Link>
```

And in the mobile bottom `<nav>`, add this `Link` right after the "Plantes" (`/`) one and before
"Historique":

```tsx
        <Link
          to="/plants"
          className={cn(
            'flex flex-col items-center gap-0.5 px-3 py-1 text-[11px] font-medium text-sidebar-foreground/70',
            'data-[status=active]:font-bold data-[status=active]:text-sidebar-accent-foreground',
          )}
        >
          <Sprout size={20} />
          Base
        </Link>
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors (this also project-references `backend`, so a mistake in Task 1/2's types
would surface here too).

- [ ] **Step 5: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && npx biome check --write frontend/src/routes/_authenticated/plants.tsx frontend/src/components/app-shell.tsx`
Expected: clean or auto-fixed.

- [ ] **Step 6: Manual browser check**

Run `cd backend && BLE_PROVIDER=mock pnpm dev` and `cd frontend && pnpm dev` (two terminals), sign
in, click "Base de plantes" in the sidebar. Confirm: the grid loads with real species names, typing
"ficus" in the search box filters the grid after ~300ms, checking "Orchidées uniquement" filters to
only orchid species (badge visible on each), opening "Filtres avancés" shows 7 grouped checkbox
lists with real French labels (no raw 2-letter codes anywhere), checking one narrows the results,
and the pagination controls work when a filter/search yields more than 24 results.

- [ ] **Step 7: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add frontend/src/routes/_authenticated/plants.tsx frontend/src/components/app-shell.tsx frontend/src/components/ui/checkbox.tsx frontend/package.json frontend/pnpm-lock.yaml
git commit -m "feat(frontend): add the Base de plantes list page and navbar link"
```

---

### Task 5: Frontend — `/plants/$id` detail route

**Files:**
- Create: `frontend/src/components/needs-gauge.tsx`
- Create: `frontend/src/routes/_authenticated/plants.$id.tsx`

**Interfaces:**
- Consumes: `trpc.plants.getById` (Task 3) — type inferred automatically from tRPC, same reasoning
  as Task 4 (no `Date` fields, no manual mirror type needed in `frontend/src/lib/types.ts`).
- Produces: route `/plants/$id`, linked from Task 4's list page.

- [ ] **Step 1: Create the needs-gauge component**

Create `frontend/src/components/needs-gauge.tsx`:

```tsx
// A 5-dot categorical gauge for PlantProfile.sunCategory/waterCategory/fertilizerCategory — these
// are Parrot's own real categorical ratings (1-4 or 1-3 observed in real data), not a formula this
// project invented. Deliberately not a reuse of SensorGauge (a circular gauge for a continuous
// min/max range) — a different visual language for a different kind of value. See
// docs/superpowers/specs/2026-08-31-plant-database-page-design.md, "Jauges de besoins".
const TOTAL_DOTS = 5;

export function NeedsGauge({ label, value, rangeLabel }: { label: string; value: number; rangeLabel?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-sm text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {rangeLabel && <span className="text-xs text-muted-foreground">{rangeLabel}</span>}
        <div className="flex gap-1">
          {Array.from({ length: TOTAL_DOTS }, (_, index) => (
            <span
              key={index}
              className={index < value ? 'h-2.5 w-2.5 rounded-full bg-primary' : 'h-2.5 w-2.5 rounded-full bg-muted'}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the detail route**

Create `frontend/src/routes/_authenticated/plants.$id.tsx`:

```tsx
import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Sprout } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NeedsGauge } from '@/components/needs-gauge';
import { trpc } from '@/lib/trpc';

export const Route = createFileRoute('/_authenticated/plants/$id')({
  // `parse` returns `false` (never throws) for an invalid id — the verified type in this
  // project's installed @tanstack/react-router (1.170.18, checked against
  // node_modules/.../router-core/dist/esm/route.d.ts's `ParseParamsFn`) is
  // `(rawParams) => TParams | false`, not something that supports throwing `notFound()` here.
  // A `false` result makes this route not match at all, which for a single dynamic segment like
  // this one surfaces as the router's normal not-found handling — the component's own
  // `error`/`!plant` branch (see PlantDetailPage below) is what actually handles a
  // syntactically-valid but nonexistent id (e.g. `/plants/999999999`), since that one requires a
  // real network response to know it's missing, not just parsing the URL.
  params: {
    parse: (params) => {
      const id = Number(params.id);
      return Number.isInteger(id) ? { id } : false;
    },
    stringify: ({ id }) => ({ id: String(id) }),
  },
  component: PlantDetailPage,
});

function formatRange(min: number | null, max: number | null, unit: string): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${Math.round(min)}–${Math.round(max)}${unit}`;
  if (min != null) return `≥ ${Math.round(min)}${unit}`;
  return `≤ ${Math.round(max as number)}${unit}`;
}

function TextSection({ title, text }: { title: string; text: string | null }) {
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-none">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function PlantDetailPage() {
  const { id } = Route.useParams();
  const { data: plant, isLoading, error } = useQuery(trpc.plants.getById.queryOptions({ id }));

  if (isLoading) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (error || !plant) return <p className="text-sm text-destructive">Cette espèce n'existe pas ou plus.</p>;

  const title = plant.commonName ?? plant.name;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Sprout size={22} className="text-muted-foreground" />
        </div>
        <div className="flex flex-col">
          <h1 className="text-xl font-bold text-foreground">{title}</h1>
          <span className="text-sm italic text-muted-foreground">{plant.name}</span>
        </div>
        {plant.isOrchid && <Badge variant="secondary">Orchidée</Badge>}
      </div>

      {!plant.hasParrotData ? (
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="text-sm font-semibold text-foreground">Fiche limitée — données partielles</h2>
          <p className="text-sm text-muted-foreground">
            Plages disponibles :{' '}
            {[
              formatRange(plant.soilMoistureMinPercent, plant.soilMoistureMaxPercent, '%'),
              formatRange(plant.temperatureMinC, plant.temperatureMaxC, '°C'),
            ]
              .filter(Boolean)
              .join(' · ') || 'aucune donnée numérique disponible'}
          </p>
        </Card>
      ) : (
        <Tabs defaultValue="description">
          <TabsList>
            <TabsTrigger value="description">Description</TabsTrigger>
            <TabsTrigger value="entretien">Entretien</TabsTrigger>
          </TabsList>

          <TabsContent value="description" className="flex flex-col gap-4">
            <Card className="flex flex-col p-4">
              <h2 className="mb-2 text-sm font-semibold text-foreground">Nomenclature</h2>
              <TextSection title="Nom scientifique" text={plant.name} />
              <TextSection title="Genre" text={plant.genusName} />
              <TextSection title="Espèce" text={plant.speciesName} />
              <TextSection title="Noms communs" text={plant.commonNames.length > 0 ? plant.commonNames.join(', ') : null} />
              <TextSection title="Synonymes" text={plant.synonyms} />
            </Card>
            <TextSection title="Description générale" text={plant.description} />
            <TextSection title="Faits intéressants" text={plant.interesting} />
            <Card className="flex flex-col p-4">
              <h2 className="mb-2 text-sm font-semibold text-foreground">Caractéristiques de la plante</h2>
              {plant.resolvedAttributes
                .filter((attribute) => attribute.group === 'type' || attribute.group === 'lifetime' || attribute.group === 'leafColor' || attribute.group === 'shape')
                .map((attribute) => (
                  <TextSection key={`${attribute.group}-${attribute.valueLabel}`} title={attribute.groupLabel} text={attribute.valueLabel} />
                ))}
              <TextSection title="Taille" text={formatRange(plant.heightMinCm, plant.heightMaxCm, ' cm')} />
              <TextSection title="Expansion" text={formatRange(plant.spreadMinCm, plant.spreadMaxCm, ' cm')} />
            </Card>
            {plant.resolvedAttributes.some((attribute) => attribute.group === 'specialFeatures') && (
              <div className="flex flex-wrap gap-2">
                {plant.resolvedAttributes
                  .filter((attribute) => attribute.group === 'specialFeatures')
                  .map((attribute) => (
                    <Badge key={attribute.valueLabel} variant="outline">
                      {attribute.valueLabel}
                    </Badge>
                  ))}
              </div>
            )}
          </TabsContent>

          <TabsContent value="entretien" className="flex flex-col gap-4">
            <Card className="flex flex-col p-4">
              <h2 className="mb-2 text-sm font-semibold text-foreground">Nutriments et besoins environnementaux</h2>
              {plant.waterCategory != null && (
                <NeedsGauge label="Arrosage" value={plant.waterCategory} rangeLabel={formatRange(plant.soilMoistureMinPercent, plant.soilMoistureMaxPercent, '%') ?? undefined} />
              )}
              {plant.sunCategory != null && (
                <NeedsGauge
                  label="Ensoleillement"
                  value={plant.sunCategory}
                  rangeLabel={formatRange(plant.lightMinMmol, plant.lightMaxMmol, ' mol/m²/j') ?? undefined}
                />
              )}
              {plant.fertilizerCategory != null && (
                <NeedsGauge
                  label="Engrais"
                  value={plant.fertilizerCategory}
                  rangeLabel={formatRange(plant.soilConductivityMinUsCm, plant.soilConductivityMaxUsCm, ' µS/cm') ?? undefined}
                />
              )}
              <TextSection title="Températures" text={formatRange(plant.temperatureMinC, plant.temperatureMaxC, '°C')} />
            </Card>
            <TextSection title="Plantation" text={plant.planting} />
            <TextSection title="Croissance" text={plant.growth} />
            <TextSection title="Floraison" text={plant.blooming} />
            <TextSection title="Récolte" text={plant.harvesting} />
            <TextSection title="Sol et Irrigation" text={plant.soilIrr} />
            <TextSection title="Fertilisation" text={plant.fertilizerText} />
            <TextSection title="Elagage" text={plant.pruning} />
            <TextSection title="Éléments nuisibles" text={plant.pests} />
            <TextSection title="Conseils complémentaires" text={plant.detailCare} />
            <TextSection
              title="Zone de pousse de la plante"
              text={
                plant.hardinessZoneMinText || plant.hardinessZoneMaxText
                  ? [plant.hardinessZoneMinText, plant.hardinessZoneMaxText].filter(Boolean).join(' — ')
                  : null
              }
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && npx biome check --write frontend/src/components/needs-gauge.tsx "frontend/src/routes/_authenticated/plants.\$id.tsx"`
Expected: clean or auto-fixed.

- [ ] **Step 5: Manual browser check**

With both dev servers still running, from the `/plants` list page click on "Figuier Pleureur"
(Ficus benjamina) or search for it first. Confirm: header shows "Figuier Pleureur" with italic
"Ficus benjamina" underneath, Description tab shows Nomenclature (both common names, "Ficus
nitida" as synonym), Description générale, Faits intéressants (if present for this species),
Caractéristiques, Entretien tab shows the 3 dot-gauges with real French range text next to them,
Températures as a min–max string, and every text section that has content (Plantation, Croissance,
etc.) — confirm no section shows literally "null" or an empty box. Then navigate to a
WatchFlower-only species (find one via `sqlite3 backend/prisma/dev.db "SELECT id, name FROM
PlantProfile WHERE parrotSpeciesId IS NULL LIMIT 1;"` and visit `/plants/<that id>` directly) and
confirm it shows the degraded "Fiche limitée" card, not a crash or empty tabs. Finally visit
`/plants/999999999` (nonexistent id) and confirm the "Cette espèce n'existe pas ou plus." message
appears, not a blank page or a raw error dump (ties into the sous-projet 5 principle — verify this
page doesn't reproduce that problem even though sous-projet 5 itself is separate work).

- [ ] **Step 6: Commit**

```bash
cd /Users/destcom/Documents/PERSO/StroyPlant
git add frontend/src/components/needs-gauge.tsx "frontend/src/routes/_authenticated/plants.\$id.tsx"
git commit -m "feat(frontend): add the plant detail page (Description/Entretien tabs)"
```

---

### Task 6: End-to-end verification

**Files:** none modified — manual verification, matching this project's established convention.

- [ ] **Step 1: Full workspace build**

Run: `cd backend && pnpm exec tsc --noEmit && pnpm test`
Run: `cd frontend && pnpm typecheck`
Expected: all clean, all tests passing (including Task 1's new tests and every pre-existing test).

- [ ] **Step 2: Repo-wide lint**

Run: `cd /Users/destcom/Documents/PERSO/StroyPlant && npx biome check`
Expected: clean (no unstaged formatting issues left over from any task).

- [ ] **Step 3: Full manual pass in the browser**

With `BLE_PROVIDER=mock pnpm dev` (backend) and `pnpm dev` (frontend) both running: sign in, go to
"Base de plantes", search for a few different species names (including one that returns zero
results — confirm "Aucune espèce trouvée."), toggle "Orchidées uniquement" and confirm every
result card shows the Orchidée badge, open "Filtres avancés" and combine two filters from
*different* groups (e.g. a leaf color AND a plant type) and confirm results narrow further (AND
across groups), then combine two filters from the *same* group (e.g. two leaf colors) and confirm
results are the union of both (OR within a group). Click through to a handful of detail pages
across different plant types (a tree, a shrub, an orchid) and confirm the content looks coherent
and nothing shows a raw 2-letter code anywhere on either page.

- [ ] **Step 4: Report results to DestCom**

Summarize what was verified (Steps 1-3), and explicitly flag the two things this plan deliberately
did **not** attempt, per the spec's non-goals: no filter/badge for any `tags` bit other than
orchid (256) — the other 8 bits remain unconfirmed, not guessed; and no resolution for the
attribute codes documented as uncovered in the spec's coverage table (all of `SN`, most of
`SH`/`SF`/`BL`, some of `PT`-type).
