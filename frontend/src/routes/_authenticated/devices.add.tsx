import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeviceKindIcon } from '@/components/device-kind-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDeviceKind, formatRelativeTime } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import type { Device } from '@/lib/types';

export const Route = createFileRoute('/_authenticated/devices/add')({
  loader: ({ context }) => context.queryClient.ensureQueryData(trpc.devices.listUnnamed.queryOptions()),
  component: AddDevicePage,
});

function UnnamedDeviceRow({ device }: { device: Device }) {
  const [name, setName] = useState('');
  const queryClient = useQueryClient();

  const renameMutation = useMutation(
    trpc.devices.rename.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.devices.listUnnamed.queryKey() });
        toast.success('Appareil ajouté au tableau de bord');
      },
      onError: (error) => {
        toast.error("Échec de l'ajout", { description: error.message });
      },
    }),
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    renameMutation.mutate({ deviceId: device.id, name: name.trim() });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center">
      <div className="flex items-center gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted">
          <DeviceKindIcon kind={device.kind} size={20} className="text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-medium text-foreground">{device.id}</div>
          <div className="text-xs text-muted-foreground">
            {formatDeviceKind(device.kind)} · vu {formatRelativeTime(device.lastSeenAt)}
          </div>
        </div>
      </div>
      <div className="flex gap-3 sm:contents">
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Nom de la plante"
          className="min-w-0 flex-1 sm:w-48 sm:flex-none"
        />
        <Button type="submit" disabled={!name.trim() || renameMutation.isPending}>
          Ajouter
        </Button>
      </div>
    </form>
  );
}

function AddDevicePage() {
  const { data: devices } = useSuspenseQuery(trpc.devices.listUnnamed.queryOptions());

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-[30px] leading-tight font-black tracking-tight text-foreground">Ajouter un appareil</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Les appareils détectés par le scanner BLE apparaissent ici avant d'être ajoutés au tableau de bord. Donne un nom à celui que tu
          veux suivre.
        </p>
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun nouvel appareil en attente. Ils apparaîtront ici dès que le scanner BLE en détecte un à proximité.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {devices.map((device) => (
            <UnnamedDeviceRow key={device.id} device={device} />
          ))}
        </div>
      )}
    </div>
  );
}
