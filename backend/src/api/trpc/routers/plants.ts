import type { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '../../../db/client.js';
import { listKnownAttributeFilters, resolveAttributeLabel, resolveFertilizerTypeLabel } from '../../../health/parrotFilterLabels.js';
import { protectedProcedure, router } from '../trpc.js';

// Only this one bit of PlantProfile.tags is confirmed in this project (see CLAUDE.md) — every
// read of the bitmask must go through this single helper, never a duplicated inline check.
const ORCHID_TAG_BIT = 256;

function isOrchid(tags: number | null): boolean {
  return tags != null && (tags & ORCHID_TAG_BIT) !== 0;
}

// Prisma has no portable bitwise operator for a SQLite `where` clause, so filtering by a tags bit
// can't be pushed into the query itself — this loads every profile with a non-null `tags` (8070 of
// 9120 rows, id+tags only) and filters in JS. Fine at this volume (only 33 real orchids, static
// data) — see docs/superpowers/specs/2026-08-31-plant-database-page-design.md's YAGNI rationale
// for why a raw SQL bitwise query isn't worth it here.
async function findOrchidProfileIds(): Promise<number[]> {
  const rows = await prisma.plantProfile.findMany({ where: { tags: { not: null } }, select: { id: true, tags: true } });
  return rows.filter((row) => isOrchid(row.tags)).map((row) => row.id);
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
      const and: Prisma.PlantProfileWhereInput[] = [];

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

      // Bucket by the resolved logical group (not the raw category) — PlantProfileAttribute.category
      // "PT" covers two distinct dimensions (type, lifetime), and grouping by raw category would OR them
      // together instead of ANDing (see the final-review finding this fixes). A filter value that can't
      // be resolved is silently dropped here — consistent with "never filter on an unconfirmed code."
      const filtersByGroup = new Map<string, { category: string; values: string[] }>();
      for (const filter of input.attributeFilters ?? []) {
        const resolved = resolveAttributeLabel(filter.category, filter.value);
        if (!resolved) continue;
        const bucket = filtersByGroup.get(resolved.group) ?? { category: filter.category, values: [] };
        bucket.values.push(filter.value);
        filtersByGroup.set(resolved.group, bucket);
      }
      for (const { category, values } of filtersByGroup.values()) {
        and.push({ attributes: { some: { category, value: { in: values } } } });
      }

      const where: Prisma.PlantProfileWhereInput = { AND: and };

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
          isOrchid: isOrchid(profile.tags),
        })),
        total,
      };
    }),

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
      isOrchid: isOrchid(profile.tags),
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
});
