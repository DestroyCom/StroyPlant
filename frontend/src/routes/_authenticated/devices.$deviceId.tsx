import { useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { ArrowLeft, BatteryMedium, Check, ChevronDown, Droplets, Info, Pencil, RefreshCw, Sprout, Sun, Thermometer, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AutoWateringSection } from '@/components/auto-watering-section';
import { AutonomousWateringSection } from '@/components/autonomous-watering-section';
import { DeviceKindIcon } from '@/components/device-kind-icon';
import { EditDeviceDialog } from '@/components/edit-device-dialog';
import { HistoryChart, type HistoryReferenceLine } from '@/components/history-chart';
import { LiveModeSection } from '@/components/live-mode-section';
import { SensorGauge } from '@/components/sensor-gauge';
import { SpeciesPickerDialog } from '@/components/species-picker-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDeviceKind, formatRelativeTime, statusBandClasses, statusDetail, statusHeadline } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import type { ParameterHealth, Reading } from '@/lib/types';
import { cn } from '@/lib/utils';

type Period = '24h' | '7j' | '30j';
type GaugeTone = 'primary' | 'accent' | 'info' | 'danger' | 'warning' | 'notice';

const PERIOD_HOURS: Record<Period, number> = { '24h': 24, '7j': 24 * 7, '30j': 24 * 30 };

function toneFor(param: ParameterHealth | undefined, fallback: GaugeTone, options: { informational?: boolean } = {}): GaugeTone {
  if (param?.status !== 'too_low' && param?.status !== 'too_high') return fallback;
  return options.informational ? 'notice' : 'warning';
}

// Species range displayed in the gauge legend — undefined if no species assigned or parameter
// not applicable (n/a) for this species. A null upper bound (indoor luminosity's floor-only
// comparison, see design spec Part B) renders as "≥ X" instead of "X–Y".
function rangeHint(param: ParameterHealth | undefined, unit: string, scale = 1): string | undefined {
  if (!param?.speciesRange) return undefined;
  const [min, max] = param.speciesRange;
  if (max == null) return `≥ ${Math.round(min / scale)}${unit} attendu`;
  return `${Math.round(min / scale)}–${Math.round(max / scale)}${unit} attendu`;
}

// Reference lines (min/max expected for the assigned species) displayed on the history
// chart — same source as rangeHint, undefined if no species assigned or parameter n/a. Omits the
// max line entirely when there's no upper bound (nothing meaningful to draw).
function referenceLinesFor(param: ParameterHealth | undefined, scale = 1): HistoryReferenceLine[] | undefined {
  if (!param?.speciesRange) return undefined;
  const [min, max] = param.speciesRange;
  const lines: HistoryReferenceLine[] = [{ value: min / scale, label: 'Min attendu' }];
  if (max != null) lines.push({ value: max / scale, label: 'Max attendu' });
  return lines;
}

// "Inhabituel pour cette plante" signal (design spec Part C) — additive to the existing
// species-range hint, never replaces it, and never changes the gauge's tone (personalDeviation is
// purely informational, same visual register as the conductivity notice below).
function personalDeviationHint(param: ParameterHealth | undefined): string | undefined {
  if (param?.personalDeviation === 'unusual_low') return 'Inhabituel (bas) pour cette plante';
  if (param?.personalDeviation === 'unusual_high') return 'Inhabituel (élevé) pour cette plante';
  return undefined;
}

interface ChartSpec {
  key: string;
  label: string;
  unit: string;
  getValue: (reading: Reading) => number | null;
  referenceLines?: HistoryReferenceLine[];
}

export const Route = createFileRoute('/_authenticated/devices/$deviceId')({
  loader: async ({ context, params }) => {
    const devices = await context.queryClient.ensureQueryData(trpc.devices.list.queryOptions());
    if (!devices.some((device) => device.id === params.deviceId)) {
      throw notFound();
    }
    await context.queryClient.ensureQueryData(trpc.devices.history.queryOptions({ deviceId: params.deviceId, hours: PERIOD_HOURS['24h'] }));
  },
  component: DeviceDetailPage,
});

function DeviceDetailPage() {
  const { deviceId } = Route.useParams();
  const { data: devices } = useSuspenseQuery(trpc.devices.list.queryOptions());
  const device = devices.find((item) => item.id === deviceId);
  if (!device) throw notFound();

  const [period, setPeriod] = useState<Period>('24h');
  const [techOpen, setTechOpen] = useState(true);
  const [speciesOpen, setSpeciesOpen] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  const { data: history } = useQuery(trpc.devices.history.queryOptions({ deviceId, hours: PERIOD_HOURS[period] }));
  const { data: wateringEvents } = useQuery(trpc.devices.wateringEvents.queryOptions({ deviceId }));
  const { data: health } = useQuery(trpc.health.deviceHealth.queryOptions({ deviceId }, { refetchInterval: 60_000 }));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const queryClient = useQueryClient();

  const waterMutation = useMutation(
    trpc.devices.water.mutationOptions({
      onSuccess: () => {
        toast.success('Arrosage déclenché', { description: `${device.name ?? device.id} est en train d'être arrosé.` });
        setConfirmOpen(false);
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.devices.wateringEvents.queryKey({ deviceId }) });
      },
      onError: (error) => {
        toast.error("Échec de l'arrosage", { description: error.message });
      },
    }),
  );

  // Manual "sync now" — reads the sensor immediately instead of waiting for the scanner's next
  // ~5min poll. Available for both device kinds (unlike watering, which is Parrot Pot only).
  const syncMutation = useMutation(
    trpc.devices.sync.mutationOptions({
      onSuccess: () => {
        toast.success('Capteur synchronisé');
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.devices.history.queryKey({ deviceId, hours: PERIOD_HOURS[period] }) });
      },
      onError: (error) => {
        toast.error('Échec de la synchronisation', { description: error.message });
      },
    }),
  );

  const reading = device.lastReading;
  const canWater = device.kind === 'PARROT_POT';
  // The Xiaomi LYWSD03MMC is a simple ambient temperature/humidity sensor, not planted in a
  // given plant — assigning a species only makes sense for the Parrot Pot (probe in the soil).
  const supportsSpeciesProfile = device.kind === 'PARROT_POT';
  const { band, icon } = statusBandClasses(device, health);
  const trendParameterKey = device.kind === 'PARROT_POT' ? 'soilMoisturePercent' : 'humidityPercent';
  const trendHint =
    health?.trend === 'degrading' ? 'tendance à la baisse' : health?.trend === 'improving' ? 'tendance à la hausse' : undefined;

  const charts: ChartSpec[] =
    device.kind === 'PARROT_POT'
      ? [
          {
            key: 'soilMoisturePercent',
            label: 'Humidité du sol',
            unit: '%',
            getValue: (r) => r.soilMoisturePercent,
            referenceLines: referenceLinesFor(health?.parameters.soilMoisturePercent),
          },
          {
            key: 'temperatureC',
            label: 'Température',
            unit: '°',
            getValue: (r) => r.temperatureC,
            referenceLines: referenceLinesFor(health?.parameters.temperatureC),
          },
          {
            key: 'luminosity',
            // "Luminosité instantanée" (not "(DLI)"): this chart plots raw per-reading instantaneous
            // values, but the Health Engine's speciesRange is now a DAILY TOTAL threshold (Part H) —
            // drawing it as a reference line here would falsely claim "below minimum ~20h/day" on a
            // healthy device. No referenceLines for this one chart (final whole-branch review, 2026-08-03).
            label: 'Luminosité instantanée',
            unit: ' mol/m²/j',
            getValue: (r) => r.luminosity,
          },
          {
            key: 'soilConductivityUsCm',
            label: 'Fertilité du sol',
            unit: ' µS/cm',
            getValue: (r) => r.soilConductivityUsCm,
            referenceLines: referenceLinesFor(health?.parameters.soilConductivityUsCm),
          },
        ]
      : [
          {
            key: 'temperatureC',
            label: 'Température',
            unit: '°',
            getValue: (r) => r.temperatureC,
            referenceLines: referenceLinesFor(health?.parameters.temperatureC),
          },
          {
            key: 'humidityPercent',
            label: 'Humidité',
            unit: '%',
            getValue: (r) => r.humidityPercent,
            referenceLines: referenceLinesFor(health?.parameters.humidityPercent),
          },
        ];

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
        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          <span>
            {device.name ?? device.id} · {formatDeviceKind(device.kind)}
            {device.location && ` · ${device.location}`}
            {device.environment && ` · ${device.environment === 'INDOOR' ? 'Intérieur' : 'Extérieur'}`}
          </span>
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="text-muted-foreground normal-case hover:text-foreground"
            aria-label="Modifier l'appareil"
          >
            <Pencil size={13} />
          </button>
        </div>
        <h1 className="max-w-lg text-[24px] leading-tight font-black tracking-tight text-foreground sm:text-[32px]">
          {statusHeadline(device, health)}
        </h1>
        <p className="mt-3.5 max-w-md text-base text-muted-foreground">{statusDetail(device)}</p>
        <div className="mt-5.5 flex items-center gap-2.5">
          <Button
            variant="outline"
            size="lg"
            className="h-11"
            disabled={syncMutation.isPending}
            onClick={() => syncMutation.mutate({ deviceId })}
          >
            <RefreshCw size={16} className={syncMutation.isPending ? 'animate-spin' : undefined} />
            {syncMutation.isPending ? 'Synchronisation…' : 'Synchroniser'}
          </Button>
          {canWater && (
            <Button variant="accent" size="lg" className="h-11" onClick={() => setConfirmOpen(true)}>
              Arroser maintenant
            </Button>
          )}
        </div>
      </div>

      {supportsSpeciesProfile && (
        <div className="my-7 rounded-lg border border-border-subtle p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-bold text-foreground">Espèce</div>
              <div className="text-sm text-muted-foreground">
                {device.plantProfile ? device.plantProfile.name : 'Aucune espèce assignée — les alertes de santé sont désactivées'}
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => setSpeciesOpen(true)}>
              {device.plantProfile ? 'Changer' : 'Assigner une espèce'}
            </Button>
          </div>

          {health && health.status !== 'no_profile' && (
            <Badge
              className="mt-3"
              variant={health.status === 'warning' ? 'destructive' : health.status === 'warming_up' ? 'outline' : 'success'}
            >
              {health.status === 'warning' ? 'Attention' : health.status === 'warming_up' ? "Période d'observation" : 'Tout va bien'}
            </Badge>
          )}

          <button
            type="button"
            onClick={() => setExplainOpen((open) => !open)}
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Info size={12} />
            Comment ce statut est calculé ?
          </button>
          {explainOpen && (
            <p className="mt-2 text-xs text-muted-foreground">
              StroyPlant compare les mesures de ce capteur aux besoins connus de l'espèce assignée. Juste après avoir assigné une espèce, le
              badge affiche « période d'observation » le temps d'accumuler quelques jours de mesures — ensuite, une alerte n'apparaît que si
              une valeur sort durablement de la plage attendue pour cette plante. Sans espèce assignée, aucun jugement n'est porté.
            </p>
          )}
        </div>
      )}

      {supportsSpeciesProfile && (
        <SpeciesPickerDialog open={speciesOpen} onOpenChange={setSpeciesOpen} deviceId={deviceId} currentProfile={device.plantProfile} />
      )}

      {canWater && <AutoWateringSection deviceId={deviceId} hasSpeciesAssigned={device.plantProfile != null} />}
      {canWater && (
        <AutonomousWateringSection
          deviceId={deviceId}
          plantProfile={device.plantProfile}
          autonomousWateringActive={device.autonomousWateringActive}
        />
      )}

      <LiveModeSection deviceId={deviceId} kind={device.kind} />

      {canWater && (
        <div className="my-7 flex items-center justify-between gap-3 rounded-lg border border-border-subtle p-4">
          <div>
            <div className="text-sm font-bold text-foreground">Calibration Plant Dr</div>
            <div className="text-sm text-muted-foreground">Filet de sécurité côté pot, en complément de l'arrosage automatique.</div>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link to="/devices/$deviceId/calibration" params={{ deviceId }}>
              Configurer
            </Link>
          </Button>
        </div>
      )}

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
                    <SensorGauge
                      label="Humidité du sol"
                      value={reading.soilMoisturePercent}
                      tone={toneFor(health?.parameters.soilMoisturePercent, 'primary')}
                      icon={<Droplets size={16} />}
                      hint={[
                        rangeHint(health?.parameters.soilMoisturePercent, '%'),
                        trendParameterKey === 'soilMoisturePercent' && trendHint,
                        personalDeviationHint(health?.parameters.soilMoisturePercent),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  )}
                  {reading.temperatureC != null && (
                    <SensorGauge
                      label="Température"
                      value={reading.temperatureC}
                      max={40}
                      unit="°"
                      tone={toneFor(health?.parameters.temperatureC, 'info')}
                      icon={<Thermometer size={16} />}
                      hint={[rangeHint(health?.parameters.temperatureC, '°'), personalDeviationHint(health?.parameters.temperatureC)]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  )}
                  {reading.waterTankLevelPercent != null && (
                    <SensorGauge label="Réservoir" value={reading.waterTankLevelPercent} tone="accent" icon={<Droplets size={16} />} />
                  )}
                  {(health?.parameters.luminosity != null || reading.luminosity != null) &&
                    (health?.parameters.luminosity?.status === 'calibrating' ? (
                      <div className="flex w-28 flex-col items-center gap-2">
                        <div className="flex h-21 w-21 items-center justify-center rounded-full border border-dashed border-muted-foreground/40">
                          <Sun size={16} className="text-muted-foreground" />
                        </div>
                        <span className="text-center text-xs text-muted-foreground">Luminosité (DLI)</span>
                        <span className="text-center text-[11px] text-muted-foreground/70">Historique de lumière insuffisant</span>
                      </div>
                    ) : (
                      <div className="flex w-28 flex-col items-center gap-1">
                        <SensorGauge
                          label="Luminosité (DLI)"
                          value={
                            health?.parameters.luminosity?.value != null
                              ? health.parameters.luminosity.value / 1000
                              : (reading.luminosity ?? 0)
                          }
                          max={30}
                          unit=" mol/m²/j"
                          tone={toneFor(health?.parameters.luminosity, 'accent')}
                          icon={<Sun size={16} />}
                          hint={[
                            rangeHint(health?.parameters.luminosity, ' mol/m²/j', 1000),
                            health?.parameters.luminosity?.liveValue != null &&
                              `Instantané : ${(health.parameters.luminosity.liveValue / 1000).toFixed(2)} mol/m²/j`,
                            personalDeviationHint(health?.parameters.luminosity),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        />
                        {health?.luminosityRecentDaysTooLow && (
                          <span className="text-center text-[11px] text-warning-foreground">
                            Lumière insuffisante depuis 3 jours — envisagez de rapprocher la plante d'une fenêtre.
                          </span>
                        )}
                      </div>
                    ))}
                  {health?.parameters.soilConductivityUsCm?.status === 'calibrating' ? (
                    <div className="flex w-28 flex-col items-center gap-2">
                      <div className="flex h-21 w-21 items-center justify-center rounded-full border border-dashed border-muted-foreground/40">
                        <Sprout size={16} className="text-muted-foreground" />
                      </div>
                      <span className="text-center text-xs text-muted-foreground">Fertilité du sol</span>
                      <span className="text-center text-[11px] text-muted-foreground/70">Calibration en cours</span>
                    </div>
                  ) : (
                    reading.soilConductivityUsCm != null && (
                      <SensorGauge
                        label="Fertilité du sol"
                        value={reading.soilConductivityUsCm}
                        max={1000}
                        unit=" µS/cm"
                        tone={toneFor(health?.parameters.soilConductivityUsCm, 'primary', { informational: true })}
                        icon={<Sprout size={16} />}
                        hint={[
                          rangeHint(health?.parameters.soilConductivityUsCm, ' µS/cm'),
                          (health?.parameters.soilConductivityUsCm?.status === 'too_low' ||
                            health?.parameters.soilConductivityUsCm?.status === 'too_high') &&
                            "n'affecte pas le statut global",
                          personalDeviationHint(health?.parameters.soilConductivityUsCm),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      />
                    )
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
                      tone={toneFor(health?.parameters.temperatureC, 'info')}
                      icon={<Thermometer size={16} />}
                      hint={[rangeHint(health?.parameters.temperatureC, '°'), personalDeviationHint(health?.parameters.temperatureC)]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  )}
                  {reading.humidityPercent != null && (
                    <SensorGauge
                      label="Humidité"
                      value={reading.humidityPercent}
                      tone={toneFor(health?.parameters.humidityPercent, 'primary')}
                      icon={<Droplets size={16} />}
                      hint={[
                        rangeHint(health?.parameters.humidityPercent, '%'),
                        trendParameterKey === 'humidityPercent' && trendHint,
                        personalDeviationHint(health?.parameters.humidityPercent),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    />
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
                <TabsContent value={period} className="flex flex-col gap-6">
                  {history && history.length > 0 ? (
                    charts.map((chart) => (
                      <div key={chart.key}>
                        <div className="mb-1 text-xs font-medium text-muted-foreground">{chart.label}</div>
                        <HistoryChart
                          data={history
                            .map((point) => ({ timestamp: point.timestamp, value: chart.getValue(point) ?? Number.NaN }))
                            .filter((point) => !Number.isNaN(point.value))}
                          label={chart.label}
                          unit={chart.unit}
                          referenceLines={chart.referenceLines}
                        />
                      </div>
                    ))
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

      <EditDeviceDialog open={editOpen} onOpenChange={setEditOpen} device={device} />

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
            <Button variant="accent" disabled={waterMutation.isPending} onClick={() => waterMutation.mutate({ deviceId })}>
              {waterMutation.isPending ? 'Arrosage…' : 'Arroser maintenant'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
