import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { HistoryChart, type HistoryPoint } from '@/components/history-chart';
import { Button } from '@/components/ui/button';
import { trpc } from '@/lib/trpc';
import type { DeviceKind } from '@/lib/types';

const LIVE_SESSION_MAX_DURATION_MS = 5 * 60_000;
const MAX_BUFFER_SIZE = 300; // matches the 5min cap at ~1 sample/s

interface MetricSpec {
  key: 'soilMoisturePercent' | 'temperatureC' | 'luminosity' | 'humidityPercent';
  label: string;
  unit: string;
}

const PARROT_METRICS: MetricSpec[] = [
  { key: 'soilMoisturePercent', label: 'Humidité du sol', unit: '%' },
  { key: 'temperatureC', label: 'Température', unit: '°' },
  { key: 'luminosity', label: 'Luminosité (DLI)', unit: ' mol/m²/j' },
];
const XIAOMI_METRICS: MetricSpec[] = [
  { key: 'temperatureC', label: 'Température', unit: '°' },
  { key: 'humidityPercent', label: 'Humidité', unit: '%' },
];

// Real GATT notify on the Parrot Pot (~1/s, confirmed by docs/PARROT_OFFICIAL_BLE_SPEC.md and the
// decompiled official app's startLive()), best-effort on the Xiaomi (firmware-controlled rate, no
// equivalent "measure period" characteristic — see
// docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md). Single shared GATT connection
// project-wide: only one live session at a time, hence the `status` query below.
export function LiveModeSection({ deviceId, kind }: { deviceId: string; kind: DeviceKind }) {
  const queryClient = useQueryClient();
  const { data: status } = useQuery(trpc.liveSession.status.queryOptions(undefined, { refetchInterval: 5000 }));
  const [isLive, setIsLive] = useState(false);
  const [remainingMs, setRemainingMs] = useState(LIVE_SESSION_MAX_DURATION_MS);
  const startedAtRef = useRef(0);
  const [buffers, setBuffers] = useState<Record<string, HistoryPoint[]>>({});

  const metrics = kind === 'PARROT_POT' ? PARROT_METRICS : XIAOMI_METRICS;
  const activeElsewhere = status != null && status.deviceId !== deviceId;

  function endSession() {
    setIsLive(false);
    void queryClient.invalidateQueries({ queryKey: trpc.liveSession.status.queryKey() });
  }

  const startMutation = useMutation(
    trpc.liveSession.start.mutationOptions({
      onSuccess: () => {
        setBuffers({});
        startedAtRef.current = Date.now();
        setRemainingMs(LIVE_SESSION_MAX_DURATION_MS);
        setIsLive(true);
      },
      onError: (error) => {
        toast.error('Mode live indisponible', { description: error.message });
      },
    }),
  );

  const stopMutation = useMutation(trpc.liveSession.stop.mutationOptions({ onSuccess: endSession }));

  useSubscription(
    trpc.liveSession.onSample.subscriptionOptions(
      { deviceId },
      {
        enabled: isLive,
        onData(event) {
          if (event.type === 'ended') {
            if (event.reason === 'error') {
              toast.error('Session live interrompue', { description: event.detail });
            }
            endSession();
            return;
          }
          setBuffers((prev) => {
            const next = { ...prev };
            for (const metric of metrics) {
              const value = event.reading[metric.key];
              if (value == null) continue;
              const points = next[metric.key] ?? [];
              next[metric.key] = [...points, { timestamp: event.reading.timestamp, value }].slice(-MAX_BUFFER_SIZE);
            }
            return next;
          });
        },
        onError: () => {
          endSession();
        },
      },
    ),
  );

  useEffect(() => {
    if (!isLive) return;
    const interval = setInterval(() => {
      setRemainingMs(Math.max(0, LIVE_SESSION_MAX_DURATION_MS - (Date.now() - startedAtRef.current)));
    }, 1000);
    return () => clearInterval(interval);
  }, [isLive]);

  // Leaving the page (route change/unmount) stops the session immediately instead of leaving it
  // running until the 5min cap with nobody watching it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run this cleanup if deviceId itself changes, not on every stopMutation identity change
  useEffect(() => {
    return () => {
      stopMutation.mutate({ deviceId });
    };
  }, [deviceId]);

  return (
    <div className="my-7 rounded-lg border border-border-subtle p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-bold text-foreground">Mode live</div>
          <div className="text-sm text-muted-foreground">
            {isLive
              ? `Se coupe automatiquement dans ${Math.ceil(remainingMs / 1000)}s`
              : activeElsewhere
                ? `Session déjà active sur un autre appareil`
                : 'Graph mis à jour en direct (coupure automatique après 5 min).'}
          </div>
        </div>
        {isLive ? (
          <Button variant="outline" size="sm" onClick={() => stopMutation.mutate({ deviceId })} disabled={stopMutation.isPending}>
            Arrêter
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={activeElsewhere || startMutation.isPending}
            onClick={() => startMutation.mutate({ deviceId })}
          >
            Démarrer
          </Button>
        )}
      </div>

      {isLive && (
        <div className="mt-4 flex flex-col gap-6">
          {metrics.map((metric) => (
            <div key={metric.key}>
              <div className="mb-1 text-xs font-medium text-muted-foreground">{metric.label}</div>
              <HistoryChart data={buffers[metric.key] ?? []} label={metric.label} unit={metric.unit} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
