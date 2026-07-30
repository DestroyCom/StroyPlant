import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AutoWateringSection } from '@/components/auto-watering-section';
import { SpeciesSearch } from '@/components/species-search';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { trpc } from '@/lib/trpc';
import type { Environment, PlantProfile } from '@/lib/types';
import { cn } from '@/lib/utils';

// The naming step (claiming the device — rename/addByAddress) already happened on /devices/add
// before landing here — that's the one mandatory step. Everything below is skippable, each
// backed by the same procedures the device detail page already uses independently, so abandoning
// the wizard at any point never leaves the device in a broken state, only with defaults.
type ConfigStepId = 'location' | 'species' | 'watering';
type StepId = ConfigStepId | 'done';

const STEP_LABELS: Record<ConfigStepId, string> = {
  location: 'Emplacement',
  species: 'Espèce',
  watering: 'Arrosage',
};

const ENVIRONMENT_OPTIONS: { value: Environment | 'UNSET'; label: string }[] = [
  { value: 'UNSET', label: 'Non spécifié' },
  { value: 'INDOOR', label: 'Intérieur' },
  { value: 'OUTDOOR', label: 'Extérieur' },
];

export const Route = createFileRoute('/_authenticated/devices/add_/$deviceId/onboarding')({
  loader: async ({ context, params }) => {
    const devices = await context.queryClient.ensureQueryData(trpc.devices.list.queryOptions());
    if (!devices.some((device) => device.id === params.deviceId)) {
      throw notFound();
    }
  },
  component: OnboardingPage,
});

function StepIndicator({ steps, currentIndex }: { steps: ConfigStepId[]; currentIndex: number }) {
  return (
    <div className="mb-8 flex items-center gap-2">
      {steps.map((step, index) => (
        <div key={step} className="flex items-center gap-2">
          <div
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
              index < currentIndex && 'bg-accent-brand text-accent-brand-foreground',
              index === currentIndex && 'bg-primary text-primary-foreground',
              index > currentIndex && 'bg-muted text-muted-foreground',
            )}
          >
            {index < currentIndex ? <Check size={14} /> : index + 1}
          </div>
          <span className={cn('text-xs', index === currentIndex ? 'font-medium text-foreground' : 'text-muted-foreground')}>
            {STEP_LABELS[step]}
          </span>
          {index < steps.length - 1 && <div className="h-px w-6 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function LocationStep({ deviceId, onDone, onSkip }: { deviceId: string; onDone: () => void; onSkip: () => void }) {
  const [location, setLocation] = useState('');
  const [environment, setEnvironment] = useState<Environment | 'UNSET'>('UNSET');
  const queryClient = useQueryClient();

  const updateMutation = useMutation(
    trpc.devices.updateDetails.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        onDone();
      },
      onError: (error) => {
        toast.error('Échec de la mise à jour', { description: error.message });
      },
    }),
  );

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">Où se trouve cette plante ? Cette information est indicative pour l'instant.</p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="onboarding-location">Emplacement</Label>
        <Input
          id="onboarding-location"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          placeholder="Salon, balcon…"
          autoFocus
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
      <div className="mt-2 flex justify-end gap-3">
        <Button variant="ghost" onClick={onSkip} disabled={updateMutation.isPending}>
          Passer
        </Button>
        <Button
          variant="accent"
          disabled={updateMutation.isPending}
          onClick={() =>
            updateMutation.mutate({
              deviceId,
              location: location.trim() || null,
              environment: environment === 'UNSET' ? null : environment,
            })
          }
        >
          Suivant
        </Button>
      </div>
    </div>
  );
}

function SpeciesStep({
  deviceId,
  onAssigned,
  onSkip,
  onNext,
  assignedProfile,
}: {
  deviceId: string;
  onAssigned: (profile: PlantProfile | null) => void;
  onSkip: () => void;
  onNext: () => void;
  assignedProfile: PlantProfile | null;
}) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Assigner une espèce permet de comparer les mesures aux besoins connus de la plante (Health Engine) et débloque l'arrosage
        automatique pour un Parrot Pot.
      </p>
      {assignedProfile ? (
        <div className="flex items-center justify-between rounded-lg border border-border-subtle p-3">
          <div>
            <div className="text-sm font-medium text-foreground">{assignedProfile.name}</div>
            {assignedProfile.commonName && <div className="text-xs text-muted-foreground">{assignedProfile.commonName}</div>}
          </div>
          <Button variant="outline" size="sm" onClick={() => onAssigned(null)}>
            Changer
          </Button>
        </div>
      ) : (
        <SpeciesSearch deviceId={deviceId} onAssigned={onAssigned} />
      )}
      <div className="mt-2 flex justify-end gap-3">
        <Button variant="ghost" onClick={onSkip}>
          Passer
        </Button>
        <Button variant="accent" onClick={onNext} disabled={!assignedProfile}>
          Suivant
        </Button>
      </div>
    </div>
  );
}

function WateringStep({ deviceId, onDone }: { deviceId: string; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Active l'arrosage automatique dès maintenant, ou ajuste-le plus tard depuis la fiche de l'appareil.
      </p>
      <AutoWateringSection deviceId={deviceId} hasSpeciesAssigned />
      <div className="mt-2 flex justify-end">
        <Button variant="accent" onClick={onDone}>
          Terminer
        </Button>
      </div>
    </div>
  );
}

function DoneStep({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  return (
    <div className="flex flex-col items-center gap-5 py-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-brand/15 text-accent-brand">
        <Check size={28} />
      </div>
      <div>
        <div className="text-lg font-bold text-foreground">« {deviceName} » est configuré</div>
        <p className="mt-1 text-sm text-muted-foreground">Tout est modifiable à tout moment depuis la fiche de l'appareil.</p>
      </div>
      <div className="flex gap-3">
        <Link to="/">
          <Button variant="outline">Tableau de bord</Button>
        </Link>
        <Link to="/devices/$deviceId" params={{ deviceId }}>
          <Button variant="accent">Voir la fiche</Button>
        </Link>
      </div>
    </div>
  );
}

function OnboardingPage() {
  const { deviceId } = Route.useParams();
  const { data: devices } = useSuspenseQuery(trpc.devices.list.queryOptions());
  const device = devices.find((item) => item.id === deviceId);
  if (!device) throw notFound();

  const [stepId, setStepId] = useState<StepId>('location');
  const [assignedProfile, setAssignedProfile] = useState<PlantProfile | null>(device.plantProfile);

  // Recomputed every render off current wizard state (not memoized on stale inputs) — the
  // watering step only ever makes sense for a Parrot Pot with a species actually assigned, so it
  // appears/disappears from the sequence live as the user assigns or changes their mind in the
  // species step, exactly like the identical gating on the device detail page's own
  // AutoWateringSection (hasSpeciesAssigned).
  const configSteps = useMemo<ConfigStepId[]>(() => {
    const steps: ConfigStepId[] = ['location', 'species'];
    if (device.kind === 'PARROT_POT' && assignedProfile != null) steps.push('watering');
    return steps;
  }, [device.kind, assignedProfile]);

  function goToStepAfter(current: ConfigStepId) {
    const index = configSteps.indexOf(current);
    const next = configSteps[index + 1];
    setStepId(next ?? 'done');
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6">
        <h1 className="text-[26px] leading-tight font-black tracking-tight text-foreground">Configurer « {device.name} »</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Chaque étape est facultative et modifiable plus tard.</p>
      </div>

      {stepId !== 'done' && <StepIndicator steps={configSteps} currentIndex={configSteps.indexOf(stepId)} />}

      {stepId === 'location' && (
        <LocationStep deviceId={deviceId} onDone={() => goToStepAfter('location')} onSkip={() => goToStepAfter('location')} />
      )}

      {stepId === 'species' && (
        <SpeciesStep
          deviceId={deviceId}
          assignedProfile={assignedProfile}
          onAssigned={setAssignedProfile}
          onSkip={() => goToStepAfter('species')}
          onNext={() => goToStepAfter('species')}
        />
      )}

      {stepId === 'watering' && <WateringStep deviceId={deviceId} onDone={() => goToStepAfter('watering')} />}

      {stepId === 'done' && <DoneStep deviceId={deviceId} deviceName={device.name ?? deviceId} />}
    </div>
  );
}
