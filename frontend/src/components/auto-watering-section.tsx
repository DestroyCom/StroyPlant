import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Switch } from './ui/switch';

// Only shown for Parrot Pots with a species assigned — the Health Engine can't produce a soil
// moisture status without one, and the Scheduler backend never acts on a device without a
// plantProfileId regardless of what's configured here (backend/src/health/scheduler.ts).
export function AutoWateringSection({ deviceId, hasSpeciesAssigned }: { deviceId: string; hasSpeciesAssigned: boolean }) {
  const queryClient = useQueryClient();
  const { data: schedule } = useQuery(trpc.schedule.get.queryOptions({ deviceId }));

  const [active, setActive] = useState(false);
  const [allowedStartHour, setAllowedStartHour] = useState(6);
  const [allowedEndHour, setAllowedEndHour] = useState(20);
  const [cooldownHours, setCooldownHours] = useState(24);

  useEffect(() => {
    if (!schedule) return;
    setActive(schedule.active);
    setAllowedStartHour(schedule.allowedStartHour);
    setAllowedEndHour(schedule.allowedEndHour);
    setCooldownHours(schedule.cooldownHours);
  }, [schedule]);

  const upsertMutation = useMutation(
    trpc.schedule.upsert.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.schedule.get.queryKey({ deviceId }) });
        toast.success('Programmation enregistrée');
      },
      onError: (error) => {
        toast.error("Échec de l'enregistrement", { description: error.message });
      },
    }),
  );

  function handleActiveChange(next: boolean) {
    setActive(next);
    upsertMutation.mutate({ deviceId, active: next, allowedStartHour, allowedEndHour, cooldownHours });
  }

  function handleSaveWindow() {
    upsertMutation.mutate({ deviceId, active, allowedStartHour, allowedEndHour, cooldownHours });
  }

  return (
    <div className="my-7 rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-foreground">Arrosage automatique</div>
          <div className="text-sm text-muted-foreground">
            {hasSpeciesAssigned
              ? "Arrose automatiquement quand l'humidité du sol est jugée trop basse pour l'espèce assignée."
              : 'Assigne une espèce ci-dessus pour pouvoir activer cette fonctionnalité.'}
          </div>
        </div>
        {hasSpeciesAssigned && <Switch checked={active} onCheckedChange={handleActiveChange} disabled={upsertMutation.isPending} />}
      </div>

      {hasSpeciesAssigned && (
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="allowed-start-hour">Entre (h)</Label>
            <Input
              id="allowed-start-hour"
              type="number"
              min={0}
              max={23}
              value={allowedStartHour}
              onChange={(event) => setAllowedStartHour(Number(event.target.value))}
              className="w-16"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="allowed-end-hour">et (h)</Label>
            <Input
              id="allowed-end-hour"
              type="number"
              min={0}
              max={23}
              value={allowedEndHour}
              onChange={(event) => setAllowedEndHour(Number(event.target.value))}
              className="w-16"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cooldown-hours">Délai minimum entre 2 arrosages (h)</Label>
            <Input
              id="cooldown-hours"
              type="number"
              min={1}
              max={168}
              value={cooldownHours}
              onChange={(event) => setCooldownHours(Number(event.target.value))}
              className="w-20"
            />
          </div>
          <Button variant="outline" size="sm" disabled={upsertMutation.isPending} onClick={handleSaveWindow}>
            Enregistrer
          </Button>
        </div>
      )}
    </div>
  );
}
