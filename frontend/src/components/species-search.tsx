import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getErrorMessage } from '@/lib/format-error';
import { trpc } from '@/lib/trpc';
import type { PlantProfile } from '@/lib/types';
import { Input } from './ui/input';

// Shared by SpeciesPickerDialog (device detail page) and the onboarding wizard's species step —
// same search-and-assign behavior, only the surrounding chrome (dialog vs. wizard step) differs.
// The WatchFlower CSV has no French names (Latin + English only) — search/results stay in those
// languages, a limitation of the data source, not of this component.
export function SpeciesSearch({ deviceId, onAssigned }: { deviceId: string; onAssigned?: (profile: PlantProfile | null) => void }) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: results, isFetching } = useQuery(
    trpc.health.plantProfiles.queryOptions({ search: debouncedSearch }, { enabled: debouncedSearch.trim().length >= 2 }),
  );

  const assignMutation = useMutation(
    trpc.health.assignPlantProfile.mutationOptions({
      onSuccess: (device, variables) => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.health.deviceHealth.queryKey({ deviceId }) });
        toast.success(variables.plantProfileId == null ? 'Espèce retirée' : 'Espèce assignée');
        onAssigned?.(device.plantProfile);
      },
      onError: (error) => {
        toast.error("Échec de l'assignation", { description: getErrorMessage(error) });
      },
    }),
  );

  return (
    <div className="flex flex-col gap-3">
      <Input placeholder="Rechercher une espèce…" value={search} onChange={(event) => setSearch(event.target.value)} autoFocus />
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {search.trim().length < 2 && <p className="py-2 text-sm text-muted-foreground">Tape au moins 2 caractères pour chercher.</p>}
        {search.trim().length >= 2 && isFetching && <p className="py-2 text-sm text-muted-foreground">Recherche…</p>}
        {search.trim().length >= 2 && !isFetching && results?.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">Aucune espèce trouvée.</p>
        )}
        {results?.map((profile) => (
          <button
            key={profile.id}
            type="button"
            disabled={assignMutation.isPending}
            onClick={() => assignMutation.mutate({ deviceId, plantProfileId: profile.id })}
            className="flex flex-col items-start rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="text-sm font-medium text-foreground">{profile.name}</span>
            {profile.commonName && <span className="text-xs text-muted-foreground">{profile.commonName}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
