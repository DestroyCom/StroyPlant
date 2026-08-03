import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

// Rolling baseline window and warm-up period (docs/STROYPLANT_SPEC.md section 7.3) — configured
// here instead of env vars, same move as MqttSettingsSection and for the same reason (a single
// source of truth, editable without a redeploy).
export function HealthEngineSettingsSection() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(trpc.health.getSettings.queryOptions());

  const [baselineWindowDays, setBaselineWindowDays] = useState(14);
  const [warmupMinDays, setWarmupMinDays] = useState(3);
  const [timezone, setTimezone] = useState('UTC');

  useEffect(() => {
    if (!settings) return;
    setBaselineWindowDays(settings.baselineWindowDays);
    setWarmupMinDays(settings.warmupMinDays);
    setTimezone(settings.timezone);
  }, [settings]);

  const upsertMutation = useMutation(
    trpc.health.upsertSettings.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.health.getSettings.queryKey() });
        toast.success('Réglages du moteur de santé enregistrés');
      },
      onError: (error) => {
        toast.error("Échec de l'enregistrement", { description: error.message });
      },
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Moteur de santé</CardTitle>
        <CardDescription>
          Fenêtre glissante utilisée pour la baseline personnelle de chaque appareil, sa période de chauffe, et le fuseau horaire utilisé
          pour calculer la lumière reçue par jour (heure locale, minuit à minuit).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="health-baseline-window">Fenêtre de baseline (jours)</Label>
          <Input
            id="health-baseline-window"
            type="number"
            min={1}
            max={365}
            value={baselineWindowDays}
            onChange={(event) => setBaselineWindowDays(Number(event.target.value))}
            className="w-24"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="health-warmup-min">Chauffe minimum (jours)</Label>
          <Input
            id="health-warmup-min"
            type="number"
            min={0}
            max={365}
            value={warmupMinDays}
            onChange={(event) => setWarmupMinDays(Number(event.target.value))}
            className="w-24"
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="health-timezone">Fuseau horaire</Label>
          <Input
            id="health-timezone"
            type="text"
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            placeholder="Europe/Paris"
            className="w-40"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={upsertMutation.isPending}
          onClick={() => upsertMutation.mutate({ baselineWindowDays, warmupMinDays, timezone })}
        >
          Enregistrer
        </Button>
      </CardContent>
    </Card>
  );
}
