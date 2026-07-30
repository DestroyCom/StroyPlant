import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { DeviceCard } from '@/components/device-card';
import { Button } from '@/components/ui/button';
import { isDeviceOnline, isTankLow } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import type { Device } from '@/lib/types';

export const Route = createFileRoute('/_authenticated/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(trpc.devices.list.queryOptions()),
  component: DashboardPage,
});

function summarySentence(devices: Device[]): string {
  if (devices.length === 0) return 'Aucun appareil détecté pour le moment.';
  const offline = devices.filter((device) => !isDeviceOnline(device.lastSeenAt)).length;
  const tankLow = devices.filter(isTankLow).length;
  if (offline === 0 && tankLow === 0) return 'Tous tes appareils vont bien aujourd’hui !';
  const issues: string[] = [];
  if (offline > 0) issues.push(`${offline} hors ligne`);
  if (tankLow > 0) issues.push(`${tankLow} réservoir${tankLow > 1 ? 's' : ''} bas`);
  return `${devices.length - offline} en ligne, ${issues.join(', ')}.`;
}

function DashboardPage() {
  const { data: devices } = useSuspenseQuery(trpc.devices.list.queryOptions());
  const queryClient = useQueryClient();

  // "Forcer la synchro" — poll every named device right now, bypassing the scanner's own 5min
  // per-device throttle. The mutation only confirms the reads were queued (not that they've
  // finished): each one is already pushed live via the readings.onReading subscription as it
  // completes, same as automatic polling — see backend/src/api/trpc/routers/devices.ts.
  const forceSyncMutation = useMutation(
    trpc.devices.forceSyncAll.mutationOptions({
      onSuccess: ({ triggered }) => {
        toast.success('Synchronisation lancée', {
          description: `${triggered} appareil${triggered > 1 ? 's' : ''} en cours de lecture — les valeurs arrivent au fil de l'eau.`,
        });
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
      },
      onError: (error) => {
        toast.error('Échec de la synchronisation', { description: error.message });
      },
    }),
  );

  return (
    <div>
      <div className="mb-8 flex flex-col items-start gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="mb-1.5 text-sm font-medium text-muted-foreground">Bonjour !</div>
          <h1 className="text-[22px] leading-tight font-black tracking-tight text-foreground sm:text-[30px]">{summarySentence(devices)}</h1>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-1 shrink-0"
          disabled={forceSyncMutation.isPending || devices.length === 0}
          onClick={() => forceSyncMutation.mutate()}
        >
          <RefreshCw size={14} className={forceSyncMutation.isPending ? 'animate-spin' : undefined} />
          Forcer la synchro
        </Button>
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun appareil détecté pour l'instant. Ils apparaissent automatiquement dès que le scanner BLE les découvre à proximité.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5">
          {devices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))}
        </div>
      )}
    </div>
  );
}
