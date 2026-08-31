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

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset to page 1 whenever any filter input changes, none of them are read inside the effect body
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
        <Input
          placeholder="Rechercher une espèce…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-xs"
        />
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
          // `/plants/$id` is created by Task 5 of this plan, not yet present in this worktree —
          // TanStack Router's generated route types don't know about it yet, so `to`/`params` need
          // a temporary escape hatch here. The route still resolves correctly at runtime (file-based
          // routing matches on the literal path string, not on the generated types) and this cast
          // becomes unnecessary (but harmless) the moment Task 5 lands.
          <Link key={item.id} to={'/plants/$id' as never} params={{ id: String(item.id) } as never}>
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
