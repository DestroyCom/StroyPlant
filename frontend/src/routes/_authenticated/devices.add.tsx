import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { RadioTower } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { DeviceKindIcon } from '@/components/device-kind-icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  const navigate = useNavigate();

  const renameMutation = useMutation(
    trpc.devices.rename.mutationOptions({
      onSuccess: (renamed) => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.devices.listUnnamed.queryKey() });
        toast.success('Appareil ajouté, configurons-le');
        void navigate({ to: '/devices/add/$deviceId/onboarding', params: { deviceId: renamed.id } });
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

function AddByAddressForm({ queryClient }: { queryClient: ReturnType<typeof useQueryClient> }) {
  const [macAddress, setMacAddress] = useState('');
  const [kind, setKind] = useState<'PARROT_POT' | 'XIAOMI_LYWSD03MMC'>('PARROT_POT');
  const [name, setName] = useState('');
  const navigate = useNavigate();

  const addMutation = useMutation(
    trpc.devices.addByAddress.mutationOptions({
      onSuccess: (created) => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        toast.success('Appareil ajouté, configurons-le');
        setMacAddress('');
        setName('');
        void navigate({ to: '/devices/add/$deviceId/onboarding', params: { deviceId: created.id } });
      },
      onError: (error) => {
        toast.error("Échec de l'ajout", { description: error.message });
      },
    }),
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!macAddress.trim() || !name.trim()) return;
    addMutation.mutate({ macAddress: macAddress.trim(), kind, name: name.trim() });
  }

  return (
    <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3 rounded-lg border border-border-subtle p-4 sm:flex-row sm:items-end">
      <div className="flex flex-col gap-2">
        <Label htmlFor="mac-address">Adresse BLE</Label>
        <Input
          id="mac-address"
          value={macAddress}
          onChange={(event) => setMacAddress(event.target.value)}
          placeholder="AA:BB:CC:DD:EE:FF"
          className="sm:w-48"
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="device-kind">Type</Label>
        <select
          id="device-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as 'PARROT_POT' | 'XIAOMI_LYWSD03MMC')}
          className="h-9 rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <option value="PARROT_POT">Parrot Pot</option>
          <option value="XIAOMI_LYWSD03MMC">Capteur Xiaomi</option>
        </select>
      </div>
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="device-name">Nom</Label>
        <Input id="device-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Nom de la plante" />
      </div>
      <Button type="submit" disabled={!macAddress.trim() || !name.trim() || addMutation.isPending}>
        Ajouter par adresse
      </Button>
    </form>
  );
}

function AddDevicePage() {
  const queryClient = useQueryClient();
  // The id of the session THIS page instance itself started — a ref, not state, because the
  // unmount cleanup closure below needs to read the LATEST value (set asynchronously once
  // start's mutation resolves), not the one captured at mount. Stays null if start never
  // resolved successfully (e.g. CONFLICT from another tab), so this instance's cleanup then has
  // nothing of its own to stop — see stopDiscoverySession's ownership check on the backend for
  // why this matters (a page instance must never stop a session it doesn't own).
  const ownSessionIdRef = useRef<string | null>(null);

  // Polled from the backend's actual session status, following live-mode-section.tsx's exact
  // precedent for the equivalent problem (a session with a backend-side auto-cutoff that the
  // frontend must not silently drift out of sync with) — not local state, so the UI correctly
  // reflects reality even after the 5-minute auto-cutoff fires with nobody around to notice.
  const { data: status } = useQuery(trpc.discoverySession.status.queryOptions(undefined, { refetchInterval: 5000 }));
  const discoveryActive = status != null;

  const startMutation = useMutation(
    trpc.discoverySession.start.mutationOptions({
      onSuccess: ({ sessionId }) => {
        ownSessionIdRef.current = sessionId;
        void queryClient.invalidateQueries({ queryKey: trpc.discoverySession.status.queryKey() });
      },
      onError: (error) => {
        // CONFLICT (another session already active, e.g. a second browser tab) — not fatal,
        // the page still works for naming already-discovered devices.
        toast.error('Recherche déjà en cours ailleurs', { description: error.message });
      },
    }),
  );
  const stopMutation = useMutation(trpc.discoverySession.stop.mutationOptions());

  // Start a discovery session when this page mounts, stop it when leaving — same lifecycle
  // pattern live-mode-section.tsx already uses for live sessions. Runs once per mount, not
  // per-render (empty dependency array is deliberate: startMutation/stopMutation are stable
  // across renders, and this must fire exactly once on mount/unmount).
  // biome-ignore lint/correctness/useExhaustiveDependencies: only run this once on mount/unmount, not on every startMutation/stopMutation identity change
  useEffect(() => {
    startMutation.mutate();
    return () => {
      // Only stop the session THIS instance actually started — if start hadn't resolved yet, or
      // failed (CONFLICT), there's nothing of ours to stop, and calling stop with no id would
      // risk killing whatever session happens to be active, possibly someone else's.
      const sessionId = ownSessionIdRef.current;
      if (sessionId) stopMutation.mutate({ sessionId });
    };
  }, []);

  // Refetch on a short interval only while a session is actually active — a discovery session
  // finding a device is the only thing that can change this list, and a plain interval is enough
  // for a screen the user is actively watching (no need for a push subscription). Passed directly
  // into the same suspense query rather than a second observer on the same key, so there's only
  // ever one source of truth for this list's refetch behavior.
  const { data: devices } = useSuspenseQuery({
    ...trpc.devices.listUnnamed.queryOptions(),
    refetchInterval: discoveryActive ? 3000 : false,
  });

  return (
    <div>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[30px] leading-tight font-black tracking-tight text-foreground">Ajouter un appareil</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Les appareils détectés apparaissent ici pendant que cette page est ouverte. Donne un nom à celui que tu veux suivre, ou
            ajoute-le directement par son adresse si tu la connais déjà.
          </p>
        </div>
        {discoveryActive && (
          <div className="mt-1 flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <RadioTower size={14} className="animate-pulse text-teal-500" />
            Recherche en cours…
          </div>
        )}
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun nouvel appareil en attente. Ils apparaîtront ici dès que la recherche en détecte un à proximité.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {devices.map((device) => (
            <UnnamedDeviceRow key={device.id} device={device} />
          ))}
        </div>
      )}

      <AddByAddressForm queryClient={queryClient} />
    </div>
  );
}
