import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { trpc } from '@/lib/trpc';
import type { PlantProfile } from '@/lib/types';
import { SpeciesSearch } from './species-search';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

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
  const queryClient = useQueryClient();

  const removeMutation = useMutation(
    trpc.health.assignPlantProfile.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.health.deviceHealth.queryKey({ deviceId }) });
        toast.success('Espèce retirée');
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

        <SpeciesSearch deviceId={deviceId} onAssigned={() => onOpenChange(false)} />

        {currentProfile && (
          <Button
            variant="outline"
            disabled={removeMutation.isPending}
            onClick={() => removeMutation.mutate({ deviceId, plantProfileId: null })}
          >
            Retirer l'espèce actuelle
          </Button>
        )}
      </DialogContent>
    </Dialog>
  );
}
