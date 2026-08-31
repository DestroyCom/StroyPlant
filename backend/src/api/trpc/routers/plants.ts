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
