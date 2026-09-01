import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Sprout } from 'lucide-react';
import { NeedsGauge } from '@/components/needs-gauge';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';

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
                .filter(
                  (attribute) =>
                    attribute.group === 'type' ||
                    attribute.group === 'lifetime' ||
                    attribute.group === 'leafColor' ||
                    attribute.group === 'shape',
                )
                .map((attribute) => (
                  <TextSection
                    key={`${attribute.group}-${attribute.valueLabel}`}
                    title={attribute.groupLabel}
                    text={attribute.valueLabel}
                  />
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
                <NeedsGauge
                  label="Arrosage"
                  value={plant.waterCategory}
                  rangeLabel={formatRange(plant.soilMoistureMinPercent, plant.soilMoistureMaxPercent, '%') ?? undefined}
                />
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
