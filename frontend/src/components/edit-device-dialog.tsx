import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getErrorMessage } from '@/lib/format-error';
import { trpc } from '@/lib/trpc';
import type { Device, Environment } from '@/lib/types';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';

const ENVIRONMENT_OPTIONS: { value: Environment | 'UNSET'; label: string }[] = [
  { value: 'UNSET', label: 'Non spécifié' },
  { value: 'INDOOR', label: 'Intérieur' },
  { value: 'OUTDOOR', label: 'Extérieur' },
];

export function EditDeviceDialog({ open, onOpenChange, device }: { open: boolean; onOpenChange: (open: boolean) => void; device: Device }) {
  const [name, setName] = useState(device.name ?? '');
  const [location, setLocation] = useState(device.location ?? '');
  const [environment, setEnvironment] = useState<Environment | 'UNSET'>(device.environment ?? 'UNSET');
  const queryClient = useQueryClient();

  // Reset to the device's current values only on the actual open transition (open flips
  // false -> true), not on every render while open. `device` comes from the `devices.list` query,
  // which the live-readings subscription refreshes in the background (queryClient.setQueryData)
  // every few seconds — that gives a new `device` object on every push even though nothing the
  // user is editing changed, and re-running this on every such update would silently wipe
  // whatever the user had just typed/selected before they hit save.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setName(device.name ?? '');
      setLocation(device.location ?? '');
      setEnvironment(device.environment ?? 'UNSET');
    }
    wasOpen.current = open;
  }, [open, device]);

  const updateMutation = useMutation(
    trpc.devices.updateDetails.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        toast.success('Appareil mis à jour');
        onOpenChange(false);
      },
      onError: (error) => {
        toast.error('Échec de la mise à jour', { description: getErrorMessage(error) });
      },
    }),
  );

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    updateMutation.mutate({
      deviceId: device.id,
      name: name.trim(),
      location: location.trim() || null,
      environment: environment === 'UNSET' ? null : environment,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Modifier l'appareil</DialogTitle>
            <DialogDescription>Nom, emplacement et environnement — n'affecte pas le scoring santé pour l'instant.</DialogDescription>
          </DialogHeader>

          <div className="mt-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-name">Nom</Label>
              <Input id="device-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="device-location">Emplacement</Label>
              <Input
                id="device-location"
                value={location}
                onChange={(event) => setLocation(event.target.value)}
                placeholder="Salon, balcon…"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Environnement</Label>
              <Tabs value={environment} onValueChange={(value) => setEnvironment(value as Environment | 'UNSET')}>
                <TabsList className="w-full">
                  {ENVIRONMENT_OPTIONS.map((option) => (
                    <TabsTrigger key={option.value} value={option.value} className="flex-1">
                      {option.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>
          </div>

          <DialogFooter className="mt-5">
            <Button type="submit" variant="accent" disabled={!name.trim() || updateMutation.isPending}>
              {updateMutation.isPending ? 'Enregistrement…' : 'Enregistrer'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
