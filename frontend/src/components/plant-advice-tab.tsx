import { useQuery } from '@tanstack/react-query';
import { Droplets, FlaskConical, Sun, Thermometer } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { tankLitersLabel } from '@/lib/format';
import { fertilizerAdviceText, lightAdviceText, temperatureAdviceText, waterAdviceText } from '@/lib/plantAdviceText';
import { trpc } from '@/lib/trpc';

function AdviceCard({ icon, label, liveValues, text }: { icon: ReactNode; label: string; liveValues?: string; text: string }) {
  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground">{icon}</span>
        <h3 className="text-sm font-semibold text-foreground">{label}</h3>
        {liveValues && <span className="ml-auto text-sm font-medium text-foreground">{liveValues}</span>}
      </div>
      <p className="whitespace-pre-line text-sm text-muted-foreground">{text}</p>
    </Card>
  );
}

export function PlantAdviceTab({ deviceId, deviceKind }: { deviceId: string; deviceKind: 'PARROT_POT' | 'XIAOMI_LYWSD03MMC' }) {
  const { data: advice, isLoading, error } = useQuery(trpc.health.plantAdvice.queryOptions({ deviceId }, { refetchInterval: 60_000 }));

  if (isLoading) return <p className="text-sm text-muted-foreground">Chargement…</p>;
  if (error || !advice) return <p className="text-sm text-destructive">Impossible de charger les conseils pour cet appareil.</p>;

  return (
    <div className="flex flex-col gap-4">
      {advice.water && (
        <AdviceCard
          icon={<Droplets size={16} />}
          label="Humidité de la terre"
          liveValues={
            [
              advice.water.soilMoisturePercent != null ? `${Math.round(advice.water.soilMoisturePercent)}%` : null,
              advice.water.waterTankLevelPercent != null
                ? `Réservoir ${Math.round(advice.water.waterTankLevelPercent)}% (${tankLitersLabel(advice.water.waterTankLevelPercent)})`
                : null,
            ]
              .filter(Boolean)
              .join(' · ') || undefined
          }
          text={waterAdviceText(advice.water)}
        />
      )}
      {advice.temperature && (
        <AdviceCard
          icon={<Thermometer size={16} />}
          label="Température"
          liveValues={advice.temperature.temperatureC != null ? `${Math.round(advice.temperature.temperatureC)}°` : undefined}
          text={temperatureAdviceText(advice.temperature, deviceKind)}
        />
      )}
      {advice.light && <AdviceCard icon={<Sun size={16} />} label="Lumière" text={lightAdviceText(advice.light)} />}
      {advice.fertilizer && <AdviceCard icon={<FlaskConical size={16} />} label="Engrais" text={fertilizerAdviceText(advice.fertilizer)} />}
    </div>
  );
}
