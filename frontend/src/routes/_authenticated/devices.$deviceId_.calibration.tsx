import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ArrowLeft, Droplet } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';

export const Route = createFileRoute('/_authenticated/devices/$deviceId_/calibration')({
  loader: async ({ context, params }) => {
    const devices = await context.queryClient.ensureQueryData(trpc.devices.list.queryOptions());
    if (!devices.some((device) => device.id === params.deviceId)) throw notFound();
  },
  component: CalibrationPage,
});

function CalibrationPage() {
  const { deviceId } = Route.useParams();
  const { data: devices } = useSuspenseQuery(trpc.devices.list.queryOptions());
  const device = devices.find((item) => item.id === deviceId);
  if (device?.kind !== 'PARROT_POT') throw notFound();

  const queryClient = useQueryClient();
  const { data: calibration, isLoading } = useQuery(trpc.plantDr.getCalibration.queryOptions({ deviceId }));
  const dryVwcPercent = device.plantProfile?.soilMoistureMinPercent;

  // The mutation itself only confirms the calibration run was queued (see the backend's
  // calibrateWet doc comment — its 2 sequential BLE operations can take longer than Cloudflare's
  // origin timeout, so the result is no longer carried by the mutation's own HTTP response).
  // Actual completion is observed by polling calibrationRunStatus, same shape as
  // live-mode-section.tsx's precedent for discoverySession/liveSession status.
  const { data: runState } = useQuery({
    ...trpc.plantDr.calibrationRunStatus.queryOptions({ deviceId }),
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1500 : false),
  });
  const isRunning = runState?.status === 'running';
  const lastHandledFinishRef = useRef<number | null>(null);

  useEffect(() => {
    if (!runState || runState.status === 'idle' || runState.status === 'running') return;
    if (lastHandledFinishRef.current === runState.finishedAt) return;
    lastHandledFinishRef.current = runState.finishedAt;

    if (runState.status === 'success') {
      void queryClient.invalidateQueries({ queryKey: trpc.plantDr.getCalibration.queryKey({ deviceId }) });
      toast.success('Calibration écrite sur le pot', {
        description: `Seuil sec ${runState.dryVwcPercent}% · seuil humide ${runState.wetVwcPercent.toFixed(1)}%`,
      });
    } else {
      toast.error('Échec de la calibration', { description: runState.message });
    }
  }, [runState, queryClient, deviceId]);

  const calibrateMutation = useMutation(
    trpc.plantDr.calibrateWet.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.plantDr.calibrationRunStatus.queryKey({ deviceId }) });
      },
      onError: (error) => {
        toast.error('Échec du lancement de la calibration', { description: error.message });
      },
    }),
  );

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/devices/$deviceId"
        params={{ deviceId }}
        className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} />
        {device.name ?? device.id}
      </Link>

      <h1 className="text-[22px] leading-tight font-black tracking-tight text-foreground md:text-[30px]">Calibration Plant Dr</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        Configure l'algorithme d'arrosage embarqué directement sur le pot — un filet de sécurité qui continue à arroser au minimum même si
        StroyPlant est hors ligne ou hors de portée BLE. Ça s'ajoute à la programmation automatique côté serveur, ça ne la remplace pas.
      </p>

      <div className="mt-7 rounded-lg border border-border-subtle p-4">
        <div className="text-sm font-bold text-foreground">Calibration actuelle sur le pot</div>
        {isLoading && <div className="mt-2 text-sm text-muted-foreground">Lecture en cours…</div>}
        {calibration && (
          <div className="mt-2 flex gap-6 text-sm text-muted-foreground">
            <div>
              Seuil sec : <span className="font-medium text-foreground">{calibration.dryVwcPercent}%</span>
            </div>
            <div>
              Seuil humide : <span className="font-medium text-foreground">{calibration.wetVwcPercent}%</span>
            </div>
          </div>
        )}
      </div>

      <div className="mt-5 rounded-lg border border-border-subtle p-4">
        <div className="text-sm font-bold text-foreground">Lancer une calibration</div>
        {dryVwcPercent == null ? (
          <p className="mt-2 text-sm text-muted-foreground">
            Assigne d'abord une espèce à ce pot (depuis sa fiche) — le seuil sec est dérivé de l'humidité minimale connue pour l'espèce.
          </p>
        ) : (
          <>
            <p className="mt-2 text-sm text-muted-foreground">
              Arrose le pot normalement, attends quelques minutes que l'eau se répartisse, puis lance la calibration : StroyPlant lit
              l'humidité actuelle du sol et l'écrit comme seuil "humide" sur le pot (seuil sec = {dryVwcPercent}%, dérivé de l'espèce
              assignée).
            </p>
            <Button
              variant="accent"
              className="mt-3.5"
              disabled={calibrateMutation.isPending || isRunning}
              onClick={() => calibrateMutation.mutate({ deviceId })}
            >
              <Droplet size={16} />
              {calibrateMutation.isPending || isRunning ? 'Calibration en cours…' : 'Capturer le point humide maintenant'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
