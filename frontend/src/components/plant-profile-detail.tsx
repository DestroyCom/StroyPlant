import type { AppRouter } from '@stroyplant/backend/api/trpc/router';
import type { inferRouterOutputs } from '@trpc/server';
import { NeedsGauge } from '@/components/needs-gauge';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

// `inferRouterOutputs` (not the project's usual manual types.ts mirror, see CLAUDE.md's "Frontend —
// technical detail" for why that mirror normally avoids it) is safe here specifically because
// `plants.getById`'s output has no Date fields — the mirror's whole reason for existing (Date
// fields losing their reviver over the wire) doesn't apply to this one procedure's shape.
type RouterOutputs = inferRouterOutputs<AppRouter>;
export type PlantProfileDetailData = NonNullable<RouterOutputs['plants']['getById']>;

function formatRange(min: number | null, max: number | null, unit: string, decimals = 0): string | null {
  if (min == null && max == null) return null;
  if (min != null && max != null) return `${min.toFixed(decimals)}–${max.toFixed(decimals)}${unit}`;
  if (min != null) return `≥ ${min.toFixed(decimals)}${unit}`;
  return `≤ ${(max as number).toFixed(decimals)}${unit}`;
}

// Parrot's own generic per-category defaults, not real per-species measurements — see
// docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md. Kept raw in storage, this
// is the display-time filter (moved verbatim from plants_.$id.tsx).
function dropSentinel(
  min: number | null,
  max: number | null,
  isMinSentinel: (value: number) => boolean,
  isMaxSentinel: (value: number) => boolean,
): [number | null, number | null] {
  return [min != null && isMinSentinel(min) ? null : min, max != null && isMaxSentinel(max) ? null : max];
}

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

export function PlantProfileDetail({ plant }: { plant: PlantProfileDetailData }) {
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

  if (!plant.hasParrotData) {
    return (
      <Card className="flex flex-col gap-2 p-4">
        <h2 className="text-sm font-semibold text-foreground">Fiche limitée — données partielles</h2>
        <p className="text-sm text-muted-foreground">Plages disponibles : {availableRanges || 'aucune donnée numérique disponible'}</p>
      </Card>
    );
  }

  return (
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
                formatRange(lightMin != null ? lightMin / 1000 : null, lightMax != null ? lightMax / 1000 : null, ' mol/m²/j', 1) ?? undefined
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
          text={formatZone(plant.hardinessZoneMinValue, plant.hardinessZoneMaxValue, plant.hardinessZoneMinText, plant.hardinessZoneMaxText)}
        />
        <TextSection
          title="Zone de chaleur"
          text={plant.heatZoneMinText || plant.heatZoneMaxText ? [plant.heatZoneMinText, plant.heatZoneMaxText].filter(Boolean).join(' — ') : null}
        />
      </TabsContent>
    </Tabs>
  );
}
