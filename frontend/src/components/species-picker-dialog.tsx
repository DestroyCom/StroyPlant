import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import type { PlantProfile } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';

// The WatchFlower CSV has no French names (Latin + English only) — search/results
// will stay in those languages, a limitation of the data source, not of this component.
export function SpeciesPickerDialog({
  open,
  onOpenChange,
  deviceId,
  currentProfile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  currentProfile: PlantProfile | null;
}) {
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const queryClient = useQueryClient();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!open) {
      setSearch('');
      setDebouncedSearch('');
    }
  }, [open]);

  const { data: results, isFetching } = useQuery(
    trpc.health.plantProfiles.queryOptions({ search: debouncedSearch }, { enabled: debouncedSearch.trim().length >= 2 }),
  );

  const assignMutation = useMutation(
    trpc.health.assignPlantProfile.mutationOptions({
      onSuccess: (_device, variables) => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.health.deviceHealth.queryKey({ deviceId }) });
        toast.success(variables.plantProfileId == null ? 'Espèce retirée' : 'Espèce assignée');
        onOpenChange(false);
      },
      onError: (error) => {
        toast.error("Échec de l'assignation", { description: error.message });
      },
    }),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assigner une espèce</DialogTitle>
          <DialogDescription>
            Recherche par nom latin (la base n'a pas de noms français). Utilisé pour comparer les mesures aux besoins connus de l'espèce.
          </DialogDescription>
        </DialogHeader>

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

        {currentProfile && (
          <Button
            variant="outline"
            disabled={assignMutation.isPending}
            onClick={() => assignMutation.mutate({ deviceId, plantProfileId: null })}
          >
            Retirer l'espèce actuelle
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
