import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ArrowLeft, BatteryMedium, Check, ChevronDown, Droplets, Sun, Thermometer, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { DeviceKindIcon } from '@/components/device-kind-icon';
import { HistoryChart } from '@/components/history-chart';
import { SensorGauge } from '@/components/sensor-gauge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { triggerWatering } from '@/lib/api';
import { formatDeviceKind, formatRelativeTime, statusBandClasses, statusDetail, statusHeadline } from '@/lib/format';
import { deviceHistoryQuery, devicesQuery, wateringEventsQuery } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Period = '24h' | '7j' | '30j';

const PERIOD_HOURS: Record<Period, number> = { '24h': 24, '7j': 24 * 7, '30j': 24 * 30 };

export const Route = createFileRoute('/_authenticated/devices/$deviceId')({
  loader: async ({ context, params }) => {
    const devices = await context.queryClient.ensureQueryData(devicesQuery);
    if (!devices.some((device) => device.id === params.deviceId)) {
      throw notFound();
    }
    await context.queryClient.ensureQueryData(deviceHistoryQuery(params.deviceId, PERIOD_HOURS['24h']));
  },
  component: DeviceDetailPage,
});

function DeviceDetailPage() {
  const { deviceId } = Route.useParams();
  const { data: devices } = useSuspenseQuery(devicesQuery);
  const device = devices.find((item) => item.id === deviceId);
  if (!device) throw notFound();

  const [period, setPeriod] = useState<Period>('24h');
  const [techOpen, setTechOpen] = useState(false);
  const { data: history } = useQuery(deviceHistoryQuery(deviceId, PERIOD_HOURS[period]));
  const { data: wateringEvents } = useQuery(wateringEventsQuery(deviceId));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryClient = useQueryClient();

  const waterMutation = useMutation({
    mutationFn: () => triggerWatering(deviceId),
    onSuccess: () => {
      toast.success('Arrosage déclenché', { description: `${device.name ?? device.id} est en train d'être arrosé.` });
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: devicesQuery.queryKey });
      void queryClient.invalidateQueries({ queryKey: wateringEventsQuery(deviceId).queryKey });
    },
    onError: (error: Error) => {
      toast.error("Échec de l'arrosage", { description: error.message });
    },
  });

  const reading = device.lastReading;
  const canWater = device.kind === 'PARROT_POT';
  const { band, icon } = statusBandClasses(device);

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/" className="mb-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft size={16} />
        Tableau de bord
      </Link>

      <div className="flex flex-col items-center py-8 text-center">
        <div className={cn('mb-5 flex h-33 w-33 items-center justify-center rounded-full', band)}>
          <div className="flex h-26 w-26 items-center justify-center rounded-full bg-card shadow-md">
            <DeviceKindIcon kind={device.kind} size={44} className={icon} />
          </div>
        </div>
        <div className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {device.name ?? device.id} · {formatDeviceKind(device.kind)}
        </div>
        <h1 className="max-w-lg text-[32px] leading-tight font-black tracking-tight text-foreground">{statusHeadline(device)}</h1>
        <p className="mt-3.5 max-w-md text-base text-muted-foreground">{statusDetail(device)}</p>
        {canWater && (
          <Button variant="accent" size="lg" className="mt-5.5 h-11" onClick={() => setConfirmOpen(true)}>
            Arroser maintenant
          </Button>
        )}
      </div>

      {canWater && (
        <div className="my-7">
          <div className="mb-3 text-sm font-bold text-foreground">Derniers arrosages</div>
          {!wateringEvents || wateringEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucun arrosage enregistré pour l'instant.</p>
          ) : (
            <div className="flex flex-col">
              {wateringEvents.map((event, index) => (
                <div key={event.id} className="flex gap-3">
                  <div className="flex flex-col items-center">
                    <div
                      className={cn(
                        'mt-1 flex h-5 w-5 items-center justify-center rounded-full',
                        event.success ? 'bg-teal-100 text-teal-700' : 'bg-destructive/10 text-destructive',
                      )}
                    >
                      {event.success ? <Check size={12} /> : <X size={12} />}
                    </div>
                    {index !== wateringEvents.length - 1 && <div className="w-0.5 flex-1 bg-border-subtle" />}
                  </div>
                  <div className="pb-4.5 text-sm text-foreground">
                    {event.success ? 'Arrosage manuel déclenché' : "Échec de l'arrosage"} {formatRelativeTime(event.timestamp)}
                    {!event.success && event.errorDetail && <div className="mt-0.5 text-xs text-muted-foreground">{event.errorDetail}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="border-t border-border-subtle pt-4">
        <button
          type="button"
          onClick={() => setTechOpen((open) => !open)}
          className="flex w-full items-center justify-between py-2 text-left"
        >
          <span className="text-sm font-bold text-muted-foreground">Détails techniques</span>
          <ChevronDown size={18} className={cn('text-muted-foreground transition-transform', techOpen && 'rotate-180')} />
        </button>

        {techOpen && (
          <div className="flex flex-col gap-7 py-5">
            {!reading && <p className="text-sm text-muted-foreground">Aucune lecture pour l'instant.</p>}
            <div className="flex flex-wrap gap-8">
              {reading && device.kind === 'PARROT_POT' && (
                <>
                  {reading.soilMoisturePercent != null && (
                    <SensorGauge label="Humidité du sol" value={reading.soilMoisturePercent} tone="primary" icon={<Droplets size={16} />} />
                  )}
                  {reading.temperatureC != null && (
                    <SensorGauge
                      label="Température"
                      value={reading.temperatureC}
                      max={40}
                      unit="°"
                      tone="info"
                      icon={<Thermometer size={16} />}
                    />
                  )}
                  {reading.waterTankLevelPercent != null && (
                    <SensorGauge label="Réservoir" value={reading.waterTankLevelPercent} tone="accent" icon={<Droplets size={16} />} />
                  )}
                  {reading.luminosity != null && (
                    <div className="flex w-28 flex-col items-center justify-center gap-2 text-center">
                      <Sun size={20} className="text-muted-foreground" />
                      <span className="text-sm font-bold text-foreground">{Math.round(reading.luminosity)}</span>
                      <span className="text-xs text-muted-foreground">Luminosité (unité non confirmée)</span>
                    </div>
                  )}
                </>
              )}
              {reading && device.kind === 'XIAOMI_LYWSD03MMC' && (
                <>
                  {reading.temperatureC != null && (
                    <SensorGauge
                      label="Température"
                      value={reading.temperatureC}
                      max={40}
                      unit="°"
                      tone="info"
                      icon={<Thermometer size={16} />}
                    />
                  )}
                  {reading.humidityPercent != null && (
                    <SensorGauge label="Humidité" value={reading.humidityPercent} tone="primary" icon={<Droplets size={16} />} />
                  )}
                  {reading.batteryPercent != null && (
                    <SensorGauge label="Batterie" value={reading.batteryPercent} tone="accent" icon={<BatteryMedium size={16} />} />
                  )}
                </>
              )}
            </div>

            <div>
              <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
                <TabsList>
                  <TabsTrigger value="24h">24h</TabsTrigger>
                  <TabsTrigger value="7j">7 jours</TabsTrigger>
                  <TabsTrigger value="30j">30 jours</TabsTrigger>
                </TabsList>
                <TabsContent value={period}>
                  {history && history.length > 0 ? (
                    <HistoryChart
                      data={history
                        .map((point) => ({
                          timestamp: point.timestamp,
                          value: (device.kind === 'PARROT_POT' ? point.soilMoisturePercent : point.humidityPercent) ?? Number.NaN,
                        }))
                        .filter((point) => !Number.isNaN(point.value))}
                      label={device.kind === 'PARROT_POT' ? 'Humidité du sol' : 'Humidité'}
                      unit="%"
                    />
                  ) : (
                    <p className="rounded-md bg-muted py-8 text-center text-sm text-muted-foreground">
                      Aucun historique pour cette période.
                    </p>
                  )}
                </TabsContent>
              </Tabs>
            </div>
          </div>
        )}
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Déclencher l'arrosage maintenant ?</DialogTitle>
            <DialogDescription>
              La pompe de {device.name ?? device.id} va se déclencher immédiatement. Vérifie que le réservoir contient de l'eau.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Annuler</Button>
            </DialogClose>
            <Button variant="accent" disabled={waterMutation.isPending} onClick={() => waterMutation.mutate()}>
              {waterMutation.isPending ? 'Arrosage…' : 'Arroser maintenant'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
