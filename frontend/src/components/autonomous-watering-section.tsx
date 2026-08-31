import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface AutonomousWateringSectionProps {
  deviceId: string;
  plantProfile: { soilMoistureIrrigatePercent: number | null; soilMoistureCommandPercent: number | null; tags: number | null } | null;
  autonomousWateringActive: boolean;
}

const CACTUS_TAG_BIT = 1;

type WateringMode = 'PERFECT_DROP' | 'PLANT_SITTER' | 'MANUAL' | 'CUSTOM';

const MODE_OPTIONS: { value: WateringMode; label: string; description: string }[] = [
  {
    value: 'PERFECT_DROP',
    label: 'Perfect Drop',
    description: "Système d'arrosage automatique pour une croissance optimale de votre plante au quotidien.",
  },
  {
    value: 'PLANT_SITTER',
    label: 'Plant Sitter',
    description: "Système d'arrosage automatique optimisant la consommation d'eau pour assurer jusqu'à un mois d'autonomie.",
  },
  {
    value: 'MANUAL',
    label: 'Manuel',
    description: "Arrosage manuel de votre plante. L'arrosage automatique de votre plante sera alors désactivé.",
  },
  {
    value: 'CUSTOM',
    label: 'Custom',
    description: "Configuration des paramètres d'arrosage automatique de votre plante.",
  },
];

// Only meaningful for a Parrot Pot — mounted next to AutoWateringSection on the device detail
// page, gated by the same canWater check. See docs/superpowers/specs/2026-08-31-parrot-pot-
// official-app-parity-design.md.
export function AutonomousWateringSection({ deviceId, plantProfile, autonomousWateringActive }: AutonomousWateringSectionProps) {
  const queryClient = useQueryClient();
  const isCactus = plantProfile?.tags != null && (plantProfile.tags & CACTUS_TAG_BIT) !== 0;
  // Perfect Drop / Plant Sitter need the assigned species' own Parrot classic thresholds — a
  // WatchFlower-only species has none, and resolveWateringModeThresholds (backend) silently
  // resolves that combination to `{eligible:false}` → the device gets pushed mode=0 (Manual) with
  // no visible sign the requested mode was rejected. Gate the buttons instead of letting that
  // happen silently (matches the pre-rewrite AutonomousWateringSection's own hasParrotData check).
  const hasParrotData = plantProfile?.soilMoistureIrrigatePercent != null && plantProfile?.soilMoistureCommandPercent != null;

  const { data: schedule } = useQuery(trpc.schedule.get.queryOptions({ deviceId }));
  const { data: config, isLoading } = useQuery(trpc.wateringConfig.getConfig.queryOptions({ deviceId }));

  const [wateringMode, setWateringMode] = useState<WateringMode>('PERFECT_DROP');
  const [customVwcIrrPercent, setCustomVwcIrrPercent] = useState(30);
  const [customVwcCmdPercent, setCustomVwcCmdPercent] = useState(45);
  const [customNIrrDays, setCustomNIrrDays] = useState(1);

  useEffect(() => {
    if (!schedule) return;
    setWateringMode(schedule.wateringMode);
    if (schedule.customVwcIrrPercent != null) setCustomVwcIrrPercent(schedule.customVwcIrrPercent);
    if (schedule.customVwcCmdPercent != null) setCustomVwcCmdPercent(schedule.customVwcCmdPercent);
    if (schedule.customNIrrDays != null) setCustomNIrrDays(schedule.customNIrrDays);
  }, [schedule]);

  // The mutation only confirms the push was queued (same reasoning as calibrateWet — the BLE
  // sequence can exceed Cloudflare's origin timeout). Actual completion is observed by polling
  // pushRunStatus, same shape as the Plant Dr calibration page's precedent.
  const { data: runState } = useQuery({
    ...trpc.wateringConfig.pushRunStatus.queryOptions({ deviceId }),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });
  const isRunning = runState?.status === 'running';
  const lastHandledFinishRef = useRef<number | null>(null);

  useEffect(() => {
    if (!runState || runState.status === 'idle' || runState.status === 'running') return;
    if (lastHandledFinishRef.current === runState.finishedAt) return;
    lastHandledFinishRef.current = runState.finishedAt;

    if (runState.status === 'success') {
      void queryClient.invalidateQueries({ queryKey: trpc.wateringConfig.getConfig.queryKey({ deviceId }) });
      void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
      toast.success(runState.enabled ? 'Arrosage autonome activé sur le pot' : 'Arrosage autonome désactivé sur le pot');
    } else {
      toast.error('Échec de la configuration', { description: runState.message });
    }
  }, [runState, queryClient, deviceId]);

  const upsertScheduleMutation = useMutation(
    trpc.schedule.upsert.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.schedule.get.queryKey({ deviceId }) });
        void queryClient.invalidateQueries({ queryKey: trpc.wateringConfig.pushRunStatus.queryKey({ deviceId }) });
      },
      onError: (error) => {
        toast.error("Échec de l'enregistrement du mode", { description: error.message });
        // The optimistic setWateringMode below has no other rollback path — without this the
        // selector keeps showing the mode the user clicked even though the device is still on
        // whatever mode the server last confirmed, until an unrelated refetch happens to correct it.
        if (schedule) setWateringMode(schedule.wateringMode);
      },
    }),
  );

  // "Repousser maintenant" — re-runs the config push for the CURRENTLY active mode with no field
  // change, for recovery after a transient BLE failure. schedule.upsert's own modeChanged guard
  // only pushes when the mode/custom fields actually differ from what's persisted, so re-clicking
  // an already-selected mode is otherwise a complete no-op with no way to retry a failed push.
  const repushMutation = useMutation(
    trpc.wateringConfig.push.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.wateringConfig.pushRunStatus.queryKey({ deviceId }) });
      },
      onError: (error) => {
        toast.error('Échec du lancement', { description: error.message });
      },
    }),
  );

  function saveMode(nextMode: WateringMode) {
    if (!schedule) return;
    setWateringMode(nextMode);
    // CUSTOM only switches the local selection to reveal its own form below — it must never push
    // the form's current values on click, since the very first time a user opens this tab those
    // are still the component's hardcoded initial defaults, never something the user actually
    // entered/confirmed. Only the form's own "Enregistrer" button (saveCustomValues) pushes for
    // CUSTOM. Every other mode keeps pushing immediately on click, unchanged.
    if (nextMode === 'CUSTOM') return;
    // Custom fields deliberately omitted (not sent as null) — schedule.upsert's zod input treats
    // them as optional, so leaving them out preserves whatever the user last entered in Custom
    // mode, rather than wiping it every time they switch to a different mode. If they come back to
    // Custom later, their previous values are still there instead of resetting to the defaults.
    upsertScheduleMutation.mutate({
      deviceId,
      active: schedule.active,
      allowedStartHour: schedule.allowedStartHour,
      allowedEndHour: schedule.allowedEndHour,
      cooldownHours: schedule.cooldownHours,
      wateringMode: nextMode,
    });
  }

  function saveCustomValues() {
    if (!schedule) return;
    upsertScheduleMutation.mutate({
      deviceId,
      active: schedule.active,
      allowedStartHour: schedule.allowedStartHour,
      allowedEndHour: schedule.allowedEndHour,
      cooldownHours: schedule.cooldownHours,
      wateringMode: 'CUSTOM',
      customVwcIrrPercent,
      customVwcCmdPercent,
      customNIrrDays,
    });
  }

  return (
    <div className="my-7 rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-bold text-foreground">Mode d'arrosage (sur le pot)</div>
        <Badge variant={autonomousWateringActive ? 'success' : 'secondary'}>{autonomousWateringActive ? 'Actif' : 'Inactif'}</Badge>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {MODE_OPTIONS.map((option) => {
          const needsParrotData = option.value === 'PERFECT_DROP' || option.value === 'PLANT_SITTER';
          const disabled = upsertScheduleMutation.isPending || isRunning || !schedule || (needsParrotData && !hasParrotData);
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              aria-pressed={wateringMode === option.value}
              onClick={() => saveMode(option.value)}
              className={`rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                wateringMode === option.value ? 'border-primary bg-primary/5' : 'border-border-subtle hover:bg-muted'
              }`}
            >
              <div className="text-sm font-medium text-foreground">{option.label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{option.description}</div>
            </button>
          );
        })}
      </div>

      {!hasParrotData && (
        <div className="mt-3 text-xs text-muted-foreground">
          Cette espèce n'a pas de données Parrot — seuls les modes Manuel et Custom sont disponibles.
        </div>
      )}

      {isCactus && (wateringMode === 'PERFECT_DROP' || wateringMode === 'PLANT_SITTER') && (
        <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Cette espèce est une plante grasse/cactus — l'arrosage automatique risque de faire déborder la soucoupe. Le mode Manuel est
          recommandé.
        </div>
      )}

      {wateringMode === 'CUSTOM' && (
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-vwc-irr">Seuil déclenchement (%)</Label>
            <Input
              id="custom-vwc-irr"
              type="number"
              min={0}
              max={100}
              value={customVwcIrrPercent}
              onChange={(event) => setCustomVwcIrrPercent(Number(event.target.value))}
              className="w-20"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-vwc-cmd">Cible (%)</Label>
            <Input
              id="custom-vwc-cmd"
              type="number"
              min={0}
              max={100}
              value={customVwcCmdPercent}
              onChange={(event) => setCustomVwcCmdPercent(Number(event.target.value))}
              className="w-20"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="custom-n-irr">Délai anti-répétition (jours)</Label>
            <Input
              id="custom-n-irr"
              type="number"
              min={0}
              max={90}
              value={customNIrrDays}
              onChange={(event) => setCustomNIrrDays(Number(event.target.value))}
              className="w-20"
            />
          </div>
          <Button variant="outline" size="sm" disabled={upsertScheduleMutation.isPending || isRunning} onClick={saveCustomValues}>
            Enregistrer
          </Button>
        </div>
      )}

      <div className="mt-4">
        {isLoading && <div className="text-sm text-muted-foreground">Lecture en cours…</div>}
        {config && (
          <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
            <div>
              Seuil déclenchement actif : <span className="font-medium text-foreground">{(config.vwcIrrRaw / 10).toFixed(1)}%</span>
            </div>
            <div>
              Cible active : <span className="font-medium text-foreground">{(config.vwcCmdRaw / 10).toFixed(1)}%</span>
            </div>
          </div>
        )}
        {(upsertScheduleMutation.isPending || isRunning) && (
          <div className="mt-2 text-sm text-muted-foreground">Configuration en cours…</div>
        )}
        <Button
          variant="outline"
          size="sm"
          className="mt-3.5"
          disabled={isRunning || repushMutation.isPending || !schedule}
          onClick={() => repushMutation.mutate({ deviceId })}
        >
          Repousser maintenant
        </Button>
      </div>
    </div>
  );
}
