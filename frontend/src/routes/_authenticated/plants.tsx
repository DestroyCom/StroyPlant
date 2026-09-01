import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { Sprout } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { trpc } from '@/lib/trpc';
import { useWikipediaSummary } from '@/lib/use-wikipedia-summary';

interface PlantsSearch {
  q?: string;
  tags?: number[];
  attrs?: { category: string; value: string }[];
  parrotOnly?: boolean;
  page?: number;
}

// Hand-rolled, same pattern as the existing `/login` route's `validateSearch` — this project
// doesn't use a zod-based route search validator, keep it consistent rather than introducing one
// just for this route.
function validatePlantsSearch(search: Record<string, unknown>): PlantsSearch {
  const result: PlantsSearch = {};
  if (typeof search.q === 'string') result.q = search.q;
  if (Array.isArray(search.tags) && search.tags.every((value) => typeof value === 'number')) {
    result.tags = search.tags as number[];
  }
  if (
    Array.isArray(search.attrs) &&
    search.attrs.every((value) => value != null && typeof value === 'object' && 'category' in value && 'value' in value)
  ) {
    result.attrs = search.attrs as { category: string; value: string }[];
  }
  if (typeof search.parrotOnly === 'boolean') result.parrotOnly = search.parrotOnly;
  if (typeof search.page === 'number') result.page = search.page;
  return result;
}

export const Route = createFileRoute('/_authenticated/plants')({
  validateSearch: validatePlantsSearch,
  component: PlantsListPage,
});

const PAGE_SIZE = 24;

// The list page's search/filters/page live in the URL (this route's search params), not local
// component state — so that navigating to a detail page and back (the app's own back button, see
// plants_.$id.tsx) restores exactly what was there before, and the page is bookmarkable/shareable.
// `replace: true` on every update keeps this from spamming browser history — only the initial
// navigation *into* `/plants` and the navigation *to* a detail page are real history entries; every
// search/filter/page change just rewrites the current one, matching how a search page's browser-back
// behavior is expected to work (one "back" from a detail page, not one per keystroke).
function PlantsListPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  const [searchInput, setSearchInput] = useState(search.q ?? '');
  const selectedTags = search.tags ?? [];
  const selectedFilters = search.attrs ?? [];
  const parrotOnly = search.parrotOnly ?? false;
  const page = search.page ?? 1;

  // Only navigates when the debounced value has genuinely diverged from what's already in the URL
  // — without this guard, this effect firing once on every mount (React's own behavior, sharpened
  // by StrictMode's synthetic double-invoke in dev, which makes a "skip the first run" ref
  // unreliable) would overwrite `page` (and everything else) back to its default on load, breaking
  // both a direct/bookmarked URL with a `page` param and the back button's restore.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput === (search.q ?? '')) return;
      navigate({ search: (prev) => ({ ...prev, q: searchInput || undefined, page: undefined }), replace: true });
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, navigate, search.q]);

  const { data: tags } = useQuery(trpc.plants.listTags.queryOptions());
  const {
    data: filterGroups,
    isError: isFilterGroupsError,
    error: filterGroupsError,
    refetch: refetchFilterGroups,
  } = useQuery(trpc.plants.listFilters.queryOptions());

  const { data, isFetching, isError, error } = useQuery(
    trpc.plants.search.queryOptions({
      search: search.q || undefined,
      tags: selectedTags.length > 0 ? selectedTags : undefined,
      attributeFilters: selectedFilters.length > 0 ? selectedFilters : undefined,
      parrotOnly: parrotOnly || undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
  );

  function toggleParrotOnly(checked: boolean) {
    navigate({ search: (prev) => ({ ...prev, parrotOnly: checked || undefined, page: undefined }), replace: true });
  }

  function toggleFilter(category: string, value: string, checked: boolean) {
    const next = checked
      ? [...selectedFilters, { category, value }]
      : selectedFilters.filter((filter) => !(filter.category === category && filter.value === value));
    navigate({ search: (prev) => ({ ...prev, attrs: next.length > 0 ? next : undefined, page: undefined }), replace: true });
  }

  function toggleTag(bit: number) {
    const next = selectedTags.includes(bit) ? selectedTags.filter((value) => value !== bit) : [...selectedTags, bit];
    navigate({ search: (prev) => ({ ...prev, tags: next.length > 0 ? next : undefined, page: undefined }), replace: true });
  }

  function setPage(next: number) {
    navigate({ search: (prev) => ({ ...prev, page: next }), replace: true });
  }

  function resetFilters() {
    setSearchInput('');
    navigate({ search: {}, replace: true });
  }

  const hasActiveFilters = Boolean(search.q) || selectedTags.length > 0 || selectedFilters.length > 0 || parrotOnly;

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-foreground">Base de plantes</h1>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Input
          placeholder="Rechercher une espèce…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          className="max-w-xs"
        />
        <div className="flex items-center gap-2">
          <Checkbox id="parrot-only" checked={parrotOnly} onCheckedChange={(checked) => toggleParrotOnly(checked === true)} />
          <Label htmlFor="parrot-only">Compatible Parrot Pot uniquement</Label>
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
              {isFilterGroupsError ? (
                <div className="flex flex-col items-start gap-2">
                  <p className="text-sm text-destructive">Impossible de charger les filtres : {filterGroupsError.message}</p>
                  <Button type="button" variant="outline" size="sm" onClick={() => refetchFilterGroups()}>
                    Réessayer
                  </Button>
                </div>
              ) : (
                filterGroups?.map((group) => (
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
                ))
              )}
            </div>
          </DialogContent>
        </Dialog>
        {hasActiveFilters && (
          <Button type="button" variant="ghost" onClick={resetFilters}>
            Réinitialiser les filtres
          </Button>
        )}
      </div>

      {tags && tags.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tags.map((tag) => (
            <Button
              key={tag.bit}
              type="button"
              size="sm"
              variant={selectedTags.includes(tag.bit) ? 'default' : 'outline'}
              onClick={() => toggleTag(tag.bit)}
            >
              {tag.label}
            </Button>
          ))}
        </div>
      )}

      {isFetching && !data && <p className="text-sm text-muted-foreground">Chargement…</p>}
      {isError && <p className="text-sm text-destructive">Impossible de charger les résultats : {error.message}</p>}
      {!isError && data && data.items.length === 0 && <p className="text-sm text-muted-foreground">Aucune espèce trouvée.</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {data?.items.map((item) => (
          <PlantCard
            key={item.id}
            id={item.id}
            name={item.name}
            commonName={item.commonName}
            description={item.description}
            tagLabels={item.tagLabels}
          />
        ))}
      </div>

      {data && data.total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Précédent
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {page} sur {totalPages} ({data.total} résultats)
          </span>
          <Button variant="outline" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
            Suivant
          </Button>
        </div>
      )}
    </div>
  );
}

// A separate component (not inlined in the `.map()` above) so each visible card can independently
// call `useWikipediaSummary` — React Query then only ever fetches a thumbnail for the ≤24 species
// actually rendered on the current page, never all 9120 up front.
function PlantCard({
  id,
  name,
  commonName,
  description,
  tagLabels,
}: {
  id: number;
  name: string;
  commonName: string | null;
  description: string | null;
  tagLabels: string[];
}) {
  const { data: wikipedia } = useWikipediaSummary(name);

  return (
    <Link to="/plants/$id" params={{ id }} className="flex h-full">
      <Card className="h-full w-full gap-3 overflow-hidden p-0 hover:bg-muted">
        <div className="aspect-video w-full shrink-0 overflow-hidden bg-muted">
          {wikipedia?.thumbnailUrl ? (
            <img src={wikipedia.thumbnailUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Sprout size={28} className="text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1 p-4 pt-0">
          <span className="text-sm font-medium text-foreground">
            {commonName ?? name}
            {commonName && <span className="font-normal text-muted-foreground italic"> — {name}</span>}
          </span>
          {tagLabels.length > 0 && <p className="text-xs text-muted-foreground">{tagLabels.join(' · ')}</p>}
          {description && <p className="line-clamp-2 text-xs text-muted-foreground">{description}</p>}
        </div>
      </Card>
    </Link>
  );
}
