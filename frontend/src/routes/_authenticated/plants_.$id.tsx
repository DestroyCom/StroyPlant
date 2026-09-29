import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { ArrowLeft, ExternalLink, Sprout } from 'lucide-react';
import { PlantProfileDetail } from '@/components/plant-profile-detail';
import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/format-error';
import { trpc } from '@/lib/trpc';
import { useWikipediaSummary, wikipediaSearchUrl } from '@/lib/use-wikipedia-summary';

export const Route = createFileRoute('/_authenticated/plants_/$id')({
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


function PlantDetailPage() {
  const { id } = Route.useParams();
  const router = useRouter();
  const { data: plant, isLoading, error } = useQuery(trpc.plants.getById.queryOptions({ id }));
  // Called unconditionally, before any early return below, per the rules of hooks — `plant?.name`
  // is undefined until the query above resolves, which the hook itself handles (query disabled).
  const { data: wikipedia } = useWikipediaSummary(plant?.name);

  if (isLoading) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (error) {
    const code = (error as { data?: { code?: string } })?.data?.code;
    const message = code === 'NOT_FOUND' ? "Cette espèce n'existe pas ou plus." : `Erreur : ${getErrorMessage(error)}`;
    return <p className="text-sm text-destructive">{message}</p>;
  }
  if (!plant) return <p className="text-sm text-destructive">Cette espèce n'existe pas ou plus.</p>;

  const title = plant.commonName ?? plant.name;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => router.history.back()}
              aria-label="Retour à la Base de plantes"
              className="shrink-0"
            >
              <ArrowLeft size={18} />
            </Button>
            <div className="flex flex-col">
              <h1 className="text-xl font-bold text-foreground">{title}</h1>
              <span className="text-sm italic text-muted-foreground">{plant.name}</span>
            </div>
          </div>
          {plant.tagLabels.length > 0 && <p className="text-xs text-muted-foreground">{plant.tagLabels.join(' · ')}</p>}
          <a
            href={wikipedia?.pageUrl ?? wikipediaSearchUrl(plant.name)}
            target="_blank"
            rel="noreferrer"
            className="flex w-fit items-center gap-1 text-xs text-primary hover:underline"
          >
            {wikipedia ? 'Voir sur Wikipédia' : 'Rechercher sur Wikipédia'}
            <ExternalLink size={11} />
          </a>
        </div>
        {wikipedia?.thumbnailUrl ? (
          <img
            src={wikipedia.thumbnailUrl}
            alt=""
            className="aspect-square w-full max-w-48 shrink-0 self-center rounded-xl object-cover sm:w-40 sm:self-start"
          />
        ) : (
          <div className="flex aspect-square w-full max-w-48 shrink-0 items-center justify-center self-center rounded-xl bg-muted sm:w-40 sm:self-start">
            <Sprout size={32} className="text-muted-foreground" />
          </div>
        )}
      </div>

      <PlantProfileDetail plant={plant} />
    </div>
  );
}
