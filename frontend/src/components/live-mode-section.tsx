import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { HistoryChart, type HistoryPoint } from '@/components/history-chart';
import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/lib/format-error';
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
  const { data: status, isLoading: statusLoading } = useQuery(trpc.liveSession.status.queryOptions(undefined, { refetchInterval: 5000 }));
  const [isLive, setIsLive] = useState(false);
  const [remainingMs, setRemainingMs] = useState(LIVE_SESSION_MAX_DURATION_MS);
  const startedAtRef = useRef(0);
  const [buffers, setBuffers] = useState<Record<string, HistoryPoint[]>>({});
  // Transient "Session terminée" message shown after a non-manual end (timeout or error) — a
  // manual stop (reason 'stopped') needs no message, the user already sees the button revert.
  const [endedNotice, setEndedNotice] = useState<string | null>(null);

  const metrics = kind === 'PARROT_POT' ? PARROT_METRICS : XIAOMI_METRICS;
  const activeElsewhere = status != null && status.deviceId !== deviceId;
  // Guards the resume-on-mount effect below so it only ever acts once per mount, on the first
  // status resolution — NOT every time `isLive` locally flips (see its own comment for why that
  // distinction matters).
  const hasAttemptedResumeRef = useRef(false);

  function endSession(notice?: string) {
    setIsLive(false);
    setEndedNotice(notice ?? null);
    void queryClient.invalidateQueries({ queryKey: trpc.liveSession.status.queryKey() });
  }

  // Auto-clear the transient "ended" notice after a few seconds instead of leaving it stuck.
  useEffect(() => {
    if (!endedNotice) return;
    const timeout = setTimeout(() => setEndedNotice(null), 6000);
    return () => clearTimeout(timeout);
  }, [endedNotice]);

  // If the backend already reports THIS device as the active session the first time the status
  // query resolves after mount (e.g. a hard reload happened while live mode was running — the
  // unmount cleanup below can't run in that case since the whole JS context is torn down first),
  // resume watching it instead of showing a plain "Démarrer" that would just error out against
  // its own session (manager.ts's own-device CONFLICT). liveSession.onSample doesn't require
  // having called start() ourselves, so this is a straight resume, countdown computed from the
  // session's real startedAt rather than reset to the full 5 minutes.
  //
  // Deliberately one-shot (guarded by hasAttemptedResumeRef, not just an `isLive` check): a naive
  // "re-run whenever status/isLive changes" version re-fires right after our OWN endSession() —
  // at that point `isLive` has just flipped to false but the invalidated status query hasn't
  // re-fetched yet, so `status` is still the stale "active on this device" object from before we
  // ended it, and the effect would immediately flip isLive back to true, masking the "session
  // terminée" notice with a phantom resumed session. Checked only once, right after mount, this
  // race can't happen — by the time we end our own session mid-mount, the resume check has long
  // since run and settled.
  useEffect(() => {
    if (statusLoading || hasAttemptedResumeRef.current) return;
    hasAttemptedResumeRef.current = true;
    if (status?.deviceId !== deviceId) return;
    startedAtRef.current = new Date(status.startedAt).getTime();
    setRemainingMs(Math.max(0, LIVE_SESSION_MAX_DURATION_MS - (Date.now() - startedAtRef.current)));
    setIsLive(true);
  }, [statusLoading, status, deviceId]);

  const startMutation = useMutation(
    trpc.liveSession.start.mutationOptions({
      onSuccess: () => {
        setBuffers({});
        setEndedNotice(null);
        startedAtRef.current = Date.now();
        setRemainingMs(LIVE_SESSION_MAX_DURATION_MS);
        setIsLive(true);
      },
      onError: (error) => {
        toast.error('Mode live indisponible', { description: getErrorMessage(error) });
      },
    }),
  );

  const stopMutation = useMutation(trpc.liveSession.stop.mutationOptions({ onSuccess: () => endSession() }));

  useSubscription(
    trpc.liveSession.onSample.subscriptionOptions(
      { deviceId },
      {
        enabled: isLive,
        onData(event) {
          if (event.type === 'ended') {
            if (event.reason === 'error') {
              toast.error('Session live interrompue', { description: event.detail });
              endSession(event.detail ? `Session terminée : ${event.detail}` : 'Session terminée suite à une erreur.');
            } else if (event.reason === 'timeout') {
              endSession('Session terminée : coupure automatique après 5 minutes.');
            } else {
              // 'stopped' — a manual stop (this page's own button, or another caller); the
              // button reverting is feedback enough, no extra message.
              endSession();
            }
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
          toast.error('Session live interrompue', { description: 'La connexion temps réel a été perdue.' });
          endSession('Session terminée suite à une erreur de connexion.');
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
              : endedNotice
                ? endedNotice
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
            disabled={activeElsewhere || startMutation.isPending || statusLoading}
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
