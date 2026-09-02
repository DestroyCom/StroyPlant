import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getErrorMessage } from './format-error';
import { trpc } from './trpc';
import type { DeviceKind, Reading } from './types';

export type LiveModeStatus = 'connecting' | 'live' | 'unavailable';

const STATUS_POLL_INTERVAL_MS = 5000;

// Marge appliquée avant que l'effet de réconciliation ne fasse confiance à un instantané
// `liveSession.status` : une requête de polling peut avoir été émise AVANT notre dernier
// start/stop local et n'atterrir qu'après, donc décrire un état serveur déjà périmé. Exiger que
// l'instantané soit plus récent que notre dernière action d'au moins un intervalle de polling
// complet garantit que le serveur a bien été interrogé après elle. Conséquence : la récupération
// après un événement terminal manqué prend ~6-11s au lieu d'être instantanée — largement
// acceptable pour un filet de sécurité qui, sinon, n'existerait pas du tout.
const RECONCILE_GRACE_MS = STATUS_POLL_INTERVAL_MS + 1000;

// Bounds how many LIVE-sourced points the cached array can hold, independently of the time-window
// filter below — without this, a tab left open and visible for hours (indefinite auto-reconnect
// across many 5-minute cutoff cycles) could accumulate thousands of live points for whatever
// period is currently selected, a real chart-rendering perf risk this task's own new "reconnect
// indefinitely while visible" behavior introduces. Matches the old LiveModeSection's
// MAX_BUFFER_SIZE concept (~5min at ~1 sample/s).
//
// IMPORTANT (final whole-branch review, 2026-09-02): this cap counts LIVE points only and may only
// ever evict LIVE points. It used to apply to the merged array and `slice(-300)` it, which silently
// truncated the server's real POLL history — on the "7 jours"/"30 jours" tabs (~2000 rows at a
// 5-minute poll interval) the chart collapsed to the last ~300 points the instant the first live
// sample landed, while the UI still claimed to show 7 or 30 days.
const MAX_CACHED_LIVE_POINTS = 300;

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
  const {
    data: session,
    isLoading: statusLoading,
    dataUpdatedAt: sessionUpdatedAt,
  } = useQuery(trpc.liveSession.status.queryOptions(undefined, { refetchInterval: STATUS_POLL_INTERVAL_MS }));
  const [isLive, setIsLive] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // true dès qu'on a déjà retenté une fois depuis le dernier échantillon réel/clic manuel — au-delà
  // d'une tentative, on arrête d'insister automatiquement (décision validée avec DestCom : 1 essai
  // auto puis bouton manuel, pour ne jamais marteler un appareil injoignable depuis un onglet resté
  // ouvert).
  const hasRetriedRef = useRef(false);
  const hasAttemptedResumeRef = useRef(false);
  // Horodatage de la dernière action start/stop déclenchée par CE hook — sert uniquement à
  // l'effet de réconciliation plus bas, pour ne jamais juger notre état local à partir d'un
  // instantané `liveSession.status` qui pourrait précéder cette action.
  const lastLocalTransitionAtRef = useRef(0);

  const startMutation = useMutation(
    trpc.liveSession.start.mutationOptions({
      onSuccess: () => {
        lastLocalTransitionAtRef.current = Date.now();
        setUnavailable(false);
        setIsLive(true);
      },
      onError: async (error) => {
        // Un CONFLICT peut être notre PROPRE session : `retryLive()` (appelé après un arrosage,
        // devices.$deviceId.tsx) ou le montage de la page peuvent relancer un start alors qu'un
        // premier start est encore en vol et a déjà créé la session. Le backend rejette
        // légitimement ce 2e start, mais le traiter comme une panne consommerait le budget de
        // retry et afficherait « Réessayer le direct » alors qu'une session parfaitement saine
        // tourne en dessous. On demande donc au serveur qui détient la session avant de conclure.
        try {
          const current = await queryClient.fetchQuery(trpc.liveSession.status.queryOptions());
          if (current?.deviceId === deviceId) {
            lastLocalTransitionAtRef.current = Date.now();
            setUnavailable(false);
            setIsLive(true);
            return;
          }
        } catch {
          // Statut injoignable : on ne peut rien conclure de mieux, on retombe sur le chemin
          // d'échec normal ci-dessous.
        }
        // Vrai échec (autre appareil déjà en direct, appareil injoignable, erreur réseau) — un id
        // de toast stable évite d'en empiler deux quand la tentative auto échoue à son tour.
        toast.error('Direct indisponible', { id: `live-mode-start-${deviceId}`, description: getErrorMessage(error) });
        handleFailure();
      },
    }),
  );
  const stopMutation = useMutation(
    trpc.liveSession.stop.mutationOptions({
      onSuccess: () => {
        lastLocalTransitionAtRef.current = Date.now();
        setIsLive(false);
      },
    }),
  );

  function startLive() {
    lastLocalTransitionAtRef.current = Date.now();
    startMutation.mutate({ deviceId });
  }

  function handleFailure() {
    setIsLive(false);
    if (!hasRetriedRef.current && document.visibilityState === 'visible') {
      hasRetriedRef.current = true;
      startLive();
    } else {
      setUnavailable(true);
    }
  }

  function retry() {
    hasRetriedRef.current = false;
    setUnavailable(false);
    startLive();
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
      lastLocalTransitionAtRef.current = Date.now();
      setIsLive(true);
      return;
    }
    startLive();
  }, [statusLoading, session, deviceId]);

  // Filet de sécurité : si un événement terminal ('ended'/erreur) est manqué par la souscription WS
  // — souscription attachée juste après le start, redémarrage du backend en cours de session, trou
  // de reconnexion WS — rien ne ramenait ce hook à la réalité : `isLive` restait vrai indéfiniment
  // avec des données figées, sans bouton « Réessayer le direct », récupérable seulement par un
  // rechargement complet de la page. Ce risque est nettement plus exposé depuis que le direct
  // démarre automatiquement à chaque visite de la page (avant, il fallait l'activer manuellement).
  //
  // Réutilise l'instantané `liveSession.status` DÉJÀ interrogé toutes les 5s (aucune requête
  // supplémentaire). Ne s'exécute jamais tant qu'un start/stop de ce hook est en vol, ni sur un
  // instantané qui pourrait précéder notre dernière action locale (voir RECONCILE_GRACE_MS) : le
  // seul cas traité est « le serveur ne connaît plus de session pour cet appareil alors qu'on se
  // croit en direct », traité exactement comme une vraie panne pour que la mécanique retry/bouton
  // manuel reprenne la main.
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleFailure is redefined on every render but only reads refs/state setters; this effect must react to the polled session snapshot, not to that identity
  useEffect(() => {
    if (statusLoading || startMutation.isPending || stopMutation.isPending) return;
    if (!isLive) return;
    if (sessionUpdatedAt <= lastLocalTransitionAtRef.current + RECONCILE_GRACE_MS) return;
    if (session?.deviceId === deviceId) return;
    handleFailure();
  }, [session, sessionUpdatedAt, statusLoading, startMutation.isPending, stopMutation.isPending, isLive, deviceId]);

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
              if (document.visibilityState === 'visible') startLive();
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
            const merged = [...readings, event.reading].filter((point) => new Date(point.timestamp).getTime() >= cutoffMs);
            // Only LIVE points are ever evicted by the count cap — the POLL rows in this array are
            // the server's real history for the selected period and dropping any of them would
            // silently shorten the chart's span (see MAX_CACHED_LIVE_POINTS above).
            const livePoints = merged.filter((point) => point.source === 'LIVE');
            if (livePoints.length <= MAX_CACHED_LIVE_POINTS) return merged;
            const overflowIds = new Set(livePoints.slice(0, livePoints.length - MAX_CACHED_LIVE_POINTS).map((point) => point.id));
            return merged.filter((point) => !overflowIds.has(point.id));
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
        if (isLive) {
          lastLocalTransitionAtRef.current = Date.now();
          stopMutation.mutate({ deviceId });
        }
      } else if (document.visibilityState === 'visible' && !isLive && !unavailable) {
        startLive();
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
