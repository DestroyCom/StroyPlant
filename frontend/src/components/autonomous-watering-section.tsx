import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import { Badge } from './ui/badge';
import { Button } from './ui/button';

interface AutonomousWateringSectionProps {
  deviceId: string;
  plantProfile: { soilMoistureIrrigatePercent: number | null; soilMoistureCommandPercent: number | null } | null;
  autonomousWateringActive: boolean;
}

// Only meaningful for a Parrot Pot with a species assigned — mounted next to AutoWateringSection
// on the device detail page, gated by the same canWater check. See docs/superpowers/specs/
// 2026-08-30-parrot-device-side-autonomous-watering-design.md.
export function AutonomousWateringSection({ deviceId, plantProfile, autonomousWateringActive }: AutonomousWateringSectionProps) {
  const queryClient = useQueryClient();
  const hasParrotData = plantProfile?.soilMoistureIrrigatePercent != null && plantProfile?.soilMoistureCommandPercent != null;

  const { data: config, isLoading } = useQuery({ ...trpc.wateringConfig.getConfig.queryOptions({ deviceId }), enabled: hasParrotData });

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

  const pushMutation = useMutation(
    trpc.wateringConfig.push.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.wateringConfig.pushRunStatus.queryKey({ deviceId }) });
      },
      onError: (error) => {
        toast.error('Échec du lancement', { description: error.message });
      },
    }),
  );

  return (
    <div className="my-7 rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-foreground">Arrosage autonome (sur le pot)</div>
          <div className="text-sm text-muted-foreground">
            {!hasParrotData
              ? 'Espèce sans données Parrot — le pot ne peut pas décider seul, StroyPlant reste le seul décideur.'
              : autonomousWateringActive
                ? 'Le pot décide et arrose lui-même en continu. StroyPlant ne sert plus que de filet de sécurité en cas de gros écart.'
                : "Le pot suit encore StroyPlant pour toute décision d'arrosage."}
          </div>
        </div>
        <Badge variant={autonomousWateringActive ? 'success' : 'secondary'}>{autonomousWateringActive ? 'Actif' : 'Inactif'}</Badge>
      </div>

      {hasParrotData && (
        <div className="mt-4">
          {isLoading && <div className="text-sm text-muted-foreground">Lecture en cours…</div>}
          {config && (
            <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
              <div>
                Seuil déclenchement :{' '}
                <span className="font-medium text-foreground">{config.vwcIrrRaw != null ? (config.vwcIrrRaw / 10).toFixed(1) : '—'}%</span>
              </div>
              <div>
                Cible :{' '}
                <span className="font-medium text-foreground">{config.vwcCmdRaw != null ? (config.vwcCmdRaw / 10).toFixed(1) : '—'}%</span>
              </div>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-3.5"
            disabled={pushMutation.isPending || isRunning}
            onClick={() => pushMutation.mutate({ deviceId })}
          >
            {pushMutation.isPending || isRunning ? 'Configuration en cours…' : 'Repousser la configuration'}
          </Button>
        </div>
      )}
    </div>
  );
}
