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

function formatRange(min: number | null, max: number | null, unit: string, decimals = 0): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${min.toFixed(decimals)}–${max.toFixed(decimals)}${unit}`;
  if (min != null) return `≥ ${min.toFixed(decimals)}${unit}`;
  return `≤ ${(max as number).toFixed(decimals)}${unit}`;
}

// Parrot's own generic per-category defaults, not real per-species measurements — confirmed
// against the source data (docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md):
// ec_min=-1 (soilConductivityMinUsCm=-1000 after unit conversion) and dli_max=99
// (lightMaxMmol=99000 after the ×1000 mmol conversion). Kept raw in storage (an explicit past
// decision), but this page is the first UI to show them to a user — treat the sentinel side of the
// range as unknown rather than displaying a meaningless negative conductivity or an inflated max.
function dropSentinel(
  min: number | null,
  max: number | null,
  isMinSentinel: (value: number) => boolean,
  isMaxSentinel: (value: number) => boolean,
): [number | null, number | null] {
  return [min != null && isMinSentinel(min) ? null : min, max != null && isMaxSentinel(max) ? null : max];
}

// Combines the numeric zone code range (e.g. "10"–"11") with its descriptive text, matching the
// official app's own "Rusticité : 10 - 11 / <texte>" layout.
function formatZone(minValue: string | null, maxValue: string | null, minText: string | null, maxText: string | null): string | null {
  const range = minValue || maxValue ? [minValue, maxValue].filter(Boolean).join('–') : null;
  const text = [minText, maxText].filter(Boolean).join(' — ') || null;
  if (range && text) return `${range} · ${text}`;
  return range ?? text;
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
  if (error) {
    const code = (error as { data?: { code?: string } })?.data?.code;
    const message = code === 'NOT_FOUND' ? "Cette espèce n'existe pas ou plus." : `Erreur : ${error.message}`;
    return <p className="text-sm text-destructive">{message}</p>;
  }
  if (!plant) return <p className="text-sm text-destructive">Cette espèce n'existe pas ou plus.</p>;

  const title = plant.commonName ?? plant.name;

  // Sentinel-guarded once, reused by both the full fiche's gauges and the degraded card's fallback
  // range list below — see dropSentinel's own comment for what these sentinels are.
  const [lightMin, lightMax] = dropSentinel(
    plant.lightMinMmol,
    plant.lightMaxMmol,
    () => false,
    (value) => value >= 99000,
  );
  const [conductivityMin, conductivityMax] = dropSentinel(
    plant.soilConductivityMinUsCm,
    plant.soilConductivityMaxUsCm,
    (value) => value < 0,
    () => false,
  );

  const availableRanges = [
    formatRange(plant.soilMoistureMinPercent, plant.soilMoistureMaxPercent, '%'),
    formatRange(plant.temperatureMinC, plant.temperatureMaxC, '°C'),
    formatRange(lightMin != null ? lightMin / 1000 : null, lightMax != null ? lightMax / 1000 : null, ' mol/m²/j', 1),
    formatRange(conductivityMin, conductivityMax, ' µS/cm'),
  ]
    .filter(Boolean)
    .join(' · ');

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
        <div className="flex flex-wrap gap-2">
          {plant.tagLabels.map((label) => (
            <Badge key={label} variant="secondary">
              {label}
            </Badge>
          ))}
        </div>
      </div>

      {/* Gated on hasParrotData rather than "no FR translation" (the spec's original wording) —
          the two are equivalent on all real data today (every Parrot-sourced profile has an FR
          translation, every translation-less profile is WatchFlower-only), but this isn't
          structurally guaranteed by the schema. If a future partial import ever breaks that
          invariant, this gate would silently show the full tabs with mostly-empty sections instead
          of the degraded card — re-check this condition if that's ever a live possibility. */}
      {!plant.hasParrotData ? (
        <Card className="flex flex-col gap-2 p-4">
          <h2 className="text-sm font-semibold text-foreground">Fiche limitée — données partielles</h2>
          <p className="text-sm text-muted-foreground">Plages disponibles : {availableRanges || 'aucune donnée numérique disponible'}</p>
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
                    attribute.group === 'shape' ||
                    attribute.group === 'bloomColor',
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
                  rangeLabel={
                    formatRange(lightMin != null ? lightMin / 1000 : null, lightMax != null ? lightMax / 1000 : null, ' mol/m²/j', 1) ??
                    undefined
                  }
                />
              )}
              {plant.fertilizerCategory != null && (
                <NeedsGauge
                  label="Engrais"
                  value={plant.fertilizerCategory}
                  rangeLabel={formatRange(conductivityMin, conductivityMax, ' µS/cm') ?? undefined}
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
            {plant.fertilizerTypeLabels.length > 0 && (
              <div className="flex flex-col gap-1.5 border-b border-border py-3 last:border-none">
                <h3 className="text-sm font-semibold text-foreground">Types d'engrais recommandés</h3>
                <div className="flex flex-wrap gap-2">
                  {plant.fertilizerTypeLabels.map((label) => (
                    <Badge key={label} variant="outline">
                      {label}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            <TextSection title="Elagage" text={plant.pruning} />
            <TextSection title="Éléments nuisibles" text={plant.pests} />
            <TextSection title="Conseils complémentaires" text={plant.detailCare} />
            <TextSection
              title="Zone de rusticité"
              text={formatZone(
                plant.hardinessZoneMinValue,
                plant.hardinessZoneMaxValue,
                plant.hardinessZoneMinText,
                plant.hardinessZoneMaxText,
              )}
            />
            <TextSection
              title="Zone de chaleur"
              text={
                plant.heatZoneMinText || plant.heatZoneMaxText
                  ? [plant.heatZoneMinText, plant.heatZoneMaxText].filter(Boolean).join(' — ')
                  : null
              }
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
