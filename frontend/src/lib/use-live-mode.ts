import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from './trpc';
import type { DeviceKind, Reading } from './types';

export type LiveModeStatus = 'connecting' | 'live' | 'unavailable';

// Bounds the cached array's size independently of the time-window filter below — without this, a
// tab left open and visible for hours (indefinite auto-reconnect across many 5-minute cutoff
// cycles) could accumulate thousands of points for whatever period is currently selected, a real
// chart-rendering perf risk this task's own new "reconnect indefinitely while visible" behavior
// introduces. Matches the old LiveModeSection's MAX_BUFFER_SIZE concept (~5min at ~1 sample/s).
const MAX_CACHED_HISTORY_POINTS = 300;

// Remplace l'ancien composant visuel `LiveModeSection` (docs/superpowers/specs/2026-09-02-live-
// mode-default-design.md) : plus de zone/bouton séparés, ce hook headless démarre le direct
// automatiquement à l'ouverture de la page et pousse chaque échantillon directement dans les caches
// déjà utilisés par le bloc "Détails techniques" existant :
// - Les gauges se mettent déjà à jour gratuitement via `use-live-readings.ts` (souscription globale
//   déjà en place, fusionne tout événement LIVE dans devices.list.lastReading).
// - Le graphique historique est mis à jour ici, en ajoutant chaque échantillon au cache
//   devices.history de la période actuellement affichée (borné à sa fenêtre temporelle pour ne pas
//   grossir indéfiniment si l'onglet reste ouvert avec plusieurs cycles de reconnexion).
export function useLiveMode(deviceId: string, _kind: DeviceKind, hours: number): { status: LiveModeStatus; retry: () => void } {
  const queryClient = useQueryClient();
  const { data: session, isLoading: statusLoading } = useQuery(trpc.liveSession.status.queryOptions(undefined, { refetchInterval: 5000 }));
  const [isLive, setIsLive] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // true dès qu'on a déjà retenté une fois depuis le dernier échantillon réel/clic manuel — au-delà
  // d'une tentative, on arrête d'insister automatiquement (décision validée avec DestCom : 1 essai
  // auto puis bouton manuel, pour ne jamais marteler un appareil injoignable depuis un onglet resté
  // ouvert).
  const hasRetriedRef = useRef(false);
  const hasAttemptedResumeRef = useRef(false);

  const startMutation = useMutation(
    trpc.liveSession.start.mutationOptions({
      onSuccess: () => setIsLive(true),
      onError: () => handleFailure(),
    }),
  );
  const stopMutation = useMutation(trpc.liveSession.stop.mutationOptions({ onSuccess: () => setIsLive(false) }));

  function handleFailure() {
    setIsLive(false);
    if (!hasRetriedRef.current && document.visibilityState === 'visible') {
      hasRetriedRef.current = true;
      startMutation.mutate({ deviceId });
    } else {
      setUnavailable(true);
    }
  }

  function retry() {
    hasRetriedRef.current = false;
    setUnavailable(false);
    startMutation.mutate({ deviceId });
  }

  // Reprend une session déjà active sur ce device au montage (ex: rechargement de page pendant que
  // le direct tournait) au lieu de tenter d'en démarrer une nouvelle qui échouerait en CONFLICT sur
  // sa propre session. Sinon, démarre automatiquement — c'est le comportement par défaut de ce
  // sous-projet. Volontairement déclenché une seule fois (hasAttemptedResumeRef), pas à chaque
  // changement de `session` (même raison que l'ancien composant : éviter de re-déclencher après nos
  // propres appels start/stop).
  // biome-ignore lint/correctness/useExhaustiveDependencies: startMutation is stable enough for this one-shot effect, only statusLoading/session/deviceId should re-trigger it
  useEffect(() => {
    if (statusLoading || hasAttemptedResumeRef.current) return;
    hasAttemptedResumeRef.current = true;
    if (session?.deviceId === deviceId) {
      setIsLive(true);
      return;
    }
    startMutation.mutate({ deviceId });
  }, [statusLoading, session, deviceId]);

  useSubscription(
    trpc.liveSession.onSample.subscriptionOptions(
      { deviceId },
      {
        enabled: isLive,
        onData(event) {
          if (event.type === 'ended') {
            if (event.reason === 'error') {
              toast.error('Session live interrompue', { description: event.detail });
              handleFailure();
            } else if (event.reason === 'timeout') {
              // Coupure automatique après 5min (limite serveur) — routine, pas un échec : on
              // relance directement tant que l'onglet est au premier plan, sans compter contre le
              // budget "1 tentative auto" (voir handleFailure, réservé aux vraies pannes).
              setIsLive(false);
              if (document.visibilityState === 'visible') startMutation.mutate({ deviceId });
            } else {
              // 'stopped' — arrêt délibéré (démontage, onglet passé en arrière-plan, ou repli
              // d'arrosage backend, Task 6) : pas un échec, pas de retry automatique ici.
              setIsLive(false);
            }
            return;
          }

          // Un échantillon réel prouve que la connexion est saine — réarme le budget "1 tentative
          // auto" pour une future panne.
          hasRetriedRef.current = false;

          queryClient.setQueryData<Reading[]>(trpc.devices.history.queryKey({ deviceId, hours }), (readings) => {
            if (!readings) return readings;
            const cutoffMs = Date.now() - hours * 3_600_000;
            const trimmed = [...readings, event.reading].filter((point) => new Date(point.timestamp).getTime() >= cutoffMs);
            return trimmed.length > MAX_CACHED_HISTORY_POINTS ? trimmed.slice(-MAX_CACHED_HISTORY_POINTS) : trimmed;
          });
        },
        onError: () => {
          toast.error('Session live interrompue', { description: 'La connexion temps réel a été perdue.' });
          handleFailure();
        },
      },
    ),
  );

  // S'arrête dès que l'onglet passe en arrière-plan (libère la connexion GATT partagée), reprend
  // dès qu'il redevient visible — mais seulement si ce n'est pas déjà `unavailable` (une vraie
  // panne ne doit pas se relancer juste parce que l'utilisateur revient sur l'onglet, ça compterait
  // comme une 2e tentative auto silencieuse).
  // biome-ignore lint/correctness/useExhaustiveDependencies: startMutation/stopMutation are stable enough here, only isLive/unavailable/deviceId should re-bind the listener
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === 'hidden') {
        if (isLive) stopMutation.mutate({ deviceId });
      } else if (document.visibilityState === 'visible' && !isLive && !unavailable) {
        startMutation.mutate({ deviceId });
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [isLive, unavailable, deviceId]);

  // Quitter la page arrête la session immédiatement plutôt que de la laisser tourner jusqu'au
  // cutoff sans que personne ne regarde.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only re-run this cleanup if deviceId itself changes, not on every stopMutation identity change
  useEffect(() => {
    return () => {
      stopMutation.mutate({ deviceId });
    };
  }, [deviceId]);

  return { status: isLive ? 'live' : unavailable ? 'unavailable' : 'connecting', retry };
}
