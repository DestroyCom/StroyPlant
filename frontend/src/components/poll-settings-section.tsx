import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

// How often each named device gets polled (ble/namedDevicePoller.ts) — configured here instead of
// the old PARROT_POLL_INTERVAL_MS env var, same move as MqttSettingsSection/
// HealthEngineSettingsSection and for the same reason (a single source of truth, editable without
// a redeploy). A device that keeps failing still backs off beyond this base interval on its own
// (namedDevicePoller.ts's per-device exponential backoff) — this setting only controls the normal,
// healthy-device cadence.
export function PollSettingsSection() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(trpc.pollSettings.get.queryOptions());

  const [pollIntervalMinutes, setPollIntervalMinutes] = useState(5);

  useEffect(() => {
    if (!settings) return;
    setPollIntervalMinutes(settings.pollIntervalMinutes);
  }, [settings]);

  const upsertMutation = useMutation(
    trpc.pollSettings.upsert.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.pollSettings.get.queryKey() });
        toast.success('Intervalle de synchronisation enregistré');
      },
      onError: (error) => {
        toast.error("Échec de l'enregistrement", { description: error.message });
      },
    }),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Synchronisation</CardTitle>
        <CardDescription>À quelle fréquence chaque appareil nommé est sondé automatiquement.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="poll-interval-minutes">Intervalle (minutes)</Label>
          <Input
            id="poll-interval-minutes"
            type="number"
            min={1}
            max={1440}
            value={pollIntervalMinutes}
            onChange={(event) => setPollIntervalMinutes(Number(event.target.value))}
            className="w-24"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={upsertMutation.isPending}
          onClick={() => upsertMutation.mutate({ pollIntervalMinutes })}
        >
          Enregistrer
        </Button>
      </CardContent>
    </Card>
  );
}
