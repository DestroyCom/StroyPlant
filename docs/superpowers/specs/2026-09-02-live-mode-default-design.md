# Mode live par défaut sur la page detail — design spec

Sous-projet 2 de `docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md`.

## Purpose

À l'ouverture de `/devices/$deviceId`, tenter une connexion live immédiate (comme l'app officielle
Flower Power) plutôt que d'attendre un clic sur "Démarrer le mode live". Les valeurs et les
graphiques déjà affichés par défaut (bloc "Détails techniques" : gauges + historique 24h/7j/30j) se
mettent à jour en direct pendant que la connexion est active, sans zone/bouton séparés. Si la
connexion échoue, repli propre sur les dernières données connues (POLL) — pas d'état cassé, pas
d'erreur bloquante.

Inclut deux corrections découvertes pendant le brainstorming de ce sous-projet : l'unité
d'affichage de la luminosité en mode live (actuellement `mol/m²/j` appliqué à une lecture
instantanée, incohérent), et un bug de température déjà corrigé sur `main` avant même le début de
ce chantier (voir "Hors scope" plus bas).

## Evidence this is real (not assumed)

- **Formule luminosité → lux/klux, tirée de la décompilation officielle** (pas devinée) :
  `Utility.convertMolToLux(mol) = mol × 4659.293`, floor à 0 si résultat < 500, dans
  `/Users/destcom/Documents/PERSO/parrot-pot-debug/analyse/decoded_jadx/sources/com/parrot/
  flowerpower/android/Utilities/Utility.java:3604`. Le seuil d'affichage lux→klux (10000) et le
  format (`%.0f` entier) viennent de `BridgeGraphicView.java:713-725` et
  `DataKeeper.java:1968-1979` (même fichier source). Notre `luminosity` (`fa0b`) est déjà en
  mol/m²/j linéaire, pas en log — confirmé empiriquement par les relevés réels documentés dans
  `CLAUDE.md` (Part H, ~0.1 la nuit / ~70 au zénith) — donc la formule s'applique directement, sans
  transformation `10^x` intermédiaire (celle-ci n'existe dans le code décompilé que parce que leur
  représentation interne de graphe stocke un log, ce qui n'est pas notre cas).
- **`connectionQueue` fait déjà la queue, ne rejette jamais** (`backend/src/ble/connectionQueue.ts`)
  — confirmé en lisant le code : une session live qui démarre pendant qu'un autre appareil est en
  cours de poll attend simplement son tour, elle n'échoue jamais pour cette raison. Aucun changement
  nécessaire sur ce point, contrairement à ce que le roadmap laissait supposer.
- **`devices.water` est déjà indépendant de toute session live** (`backend/src/api/trpc/routers/
  devices.ts:159-166`) — mais justement, cette indépendance passe par un nouvel appel à
  `connectionQueue.run()`, qui doit attendre la fin de la session live en cours si elle tient déjà
  la queue (voir "Contrainte" ci-dessous) — c'est le vrai problème à résoudre, pas une confirmation
  que tout va bien.

## Key constraint: la session live tient `connectionQueue` pendant toute sa durée

`liveSession/manager.ts`'s `startLiveSession()` enveloppe l'intégralité de
`provider.subscribeLive(...)` dans un seul `connectionQueue.run(...)` — cette tâche ne se termine
que quand la session live se termine (abort/erreur/cutoff), pas entre deux échantillons. Toute autre
opération BLE (poll, scheduler, arrosage manuel) mise en queue pendant ce temps attend la fin
complète de la session live.

Conséquence directe pour ce sous-projet : si "Arroser maintenant" passe par le chemin normal pendant
qu'une session live tourne, l'arrosage attend jusqu'à 5 min au lieu d'être quasi instantané — ce que
DestCom attend explicitement de ce chantier ("comme l'app officielle"). D'où le point "Arrosage
pendant le direct" ci-dessous.

## Décisions validées avec DestCom

1. **Pas de zone "Mode live" séparée.** `LiveModeSection` (composant + ses propres mini-graphiques)
   disparaît. C'est le bloc "Détails techniques" déjà existant (gauges + historique 24h/7j/30j,
   `frontend/src/routes/_authenticated/devices.$deviceId.tsx`) qui se met à jour en direct — même
   comportement que l'app d'origine, où il n'y a pas de vue "live" distincte de la vue normale.
2. **Reconnexion auto après le cutoff de 5 min tant que l'onglet reste au premier plan**
   (`document.visibilityState`) — s'arrête dès que l'onglet passe en arrière-plan ou que la page est
   quittée, pour ne jamais monopoliser la connexion GATT partagée sans que personne ne regarde.
3. **Échec de connexion initiale : 1 tentative auto, puis bouton manuel "Réessayer le direct"** — pas
   de retry en boucle contre un appareil injoignable.
4. **Arrosage pendant le direct** : tente l'écriture sur la connexion GATT déjà ouverte par la
   session live (service `39e1f900`, distinct du service capteurs `39e1fa00` utilisé par les
   notifications — pas d'écriture concurrente sur la même caractéristique). En cas d'échec/timeout,
   coupe la session live puis repasse immédiatement par le chemin normal
   (`triggerWatering()`/`connectionQueue`), qui écrit toujours un `WateringEvent` explicite et
   remonte une vraie erreur en cas de nouvel échec. **Jamais d'échec avalé silencieusement** — non
   négociable (`CLAUDE.md`, section 7.1, précédent WatchFlower). Marqué comme chemin à valider sur
   hardware réel avant confiance totale (pas testable de façon concluante contre le provider mock).

## Data model

Aucun changement Prisma. Ce sous-projet est entièrement provider-interface + tRPC + frontend.

## Backend: provider interface

Nouveau type dans `backend/src/providers/types.ts` :

```ts
export interface LiveConnectionHandle {
  // Tente un déclenchement d'arrosage sur la connexion GATT déjà ouverte par la session live en
  // cours, sans repasser par connectionQueue. Rejette (jamais de no-op silencieux) sur tout échec
  // — l'appelant doit alors couper la session live et repasser par triggerWatering().
  triggerWatering(signal: AbortSignal): Promise<void>;
}
```

`subscribeLive(deviceId, kind, onSample, signal, onConnectionReady?)` gagne un 5e paramètre
optionnel, appelé une fois la connexion GATT établie (avant `startNotifications()`), avec un
`LiveConnectionHandle` fermé sur le `device`/`gatt` déjà ouverts. Seul `node-ble` (prod) et `mock`
(pour les tests) l'implémentent pour `PARROT_POT` ; `noble-bridge` ne supporte déjà pas
`subscribeLive` (throw "not implemented"), pas concerné ; Xiaomi n'a pas d'action de type arrosage,
pas concerné non plus.

## Backend: session manager

`liveSession/manager.ts` garde une référence au handle reçu via `onConnectionReady`, exposée par une
nouvelle fonction `getActiveLiveConnectionHandle(deviceId): LiveConnectionHandle | null` (retourne
`null` si aucune session active, si elle concerne un autre appareil, ou si la connexion n'est pas
encore prête). Le handle est nettoyé dans le même `.finally()` qui remet déjà `activeSession = null`
aujourd'hui.

## Backend: tRPC surface

`devices.water` (`backend/src/api/trpc/routers/devices.ts`) : si
`getActiveLiveConnectionHandle(deviceId)` retourne un handle, tente `handle.triggerWatering(signal)`
sous un timeout court ; en cas de succès, enregistre le même `WateringEvent{success:true}` que le
chemin normal (réutilise la logique déjà factorisée dans `triggerWatering()`/`watering.ts`, pas de
duplication). En cas d'échec ou timeout, appelle `stopLiveSession(deviceId)` puis retombe sur l'appel
existant à `triggerWatering(...)`, inchangé.

`liveSession.start`/`status`/`onSample` : inchangés dans leur forme (toujours démarrés/arrêtés
explicitement par le frontend — c'est le frontend qui décide de démarrer automatiquement à
l'ouverture de la page, pas le backend qui impose un comportement "toujours actif").

## Frontend

`LiveModeSection` devient un hook headless (pas de rendu de bloc dédié) monté dans
`DeviceDetailPage` :

- Démarre une session live au montage (remplace le bouton "Démarrer").
- Relance automatiquement au cutoff tant que `document.visibilityState === 'visible'` ; s'arrête à
  la mise en arrière-plan ou au démontage (réutilise le `useEffect` de cleanup déjà existant dans le
  composant actuel).
- Sur chaque échantillon (`liveSession.onSample`) :
  - Les gauges se mettent déjà à jour gratuitement — `use-live-readings.ts` fusionne déjà tout
    événement `LIVE` dans le cache `devices.list`'s `lastReading` (fusion champ par champ, ne
    remplace jamais par `null` ce qu'un échantillon live ne rapporte pas). Aucun changement là.
  - Nouveau : l'échantillon est aussi ajouté au cache `devices.history` (toutes les variantes de
    période actuellement en cache pour ce `deviceId`, via `queryClient.setQueriesData` +
    `trpc.devices.history.queryFilter({deviceId})`), avec un filtrage qui ne garde que les points
    dans la fenêtre de la période concernée (`Date.now() - hours×3600000`) pour ne pas grossir
    indéfiniment si l'onglet reste ouvert avec plusieurs cycles de reconnexion. C'est ce qui fait
    bouger le graphique en direct — la seule vraie nouveauté par rapport à l'infra existante
    (jusqu'ici, `use-live-readings.ts` ignorait délibérément les échantillons `LIVE` pour
    `devices.history`, précisément pour éviter de polluer un graphique qu'aucune page n'affichait en
    direct — cette raison ne tient plus une fois que la page detail EST la vue live par défaut).
- Remplace le bloc "Mode live" actuel par un indicateur compact près du header (à côté de
  "Synchroniser"/"Arroser maintenant") : point animé + "Direct" quand actif, "Reconnexion…" pendant
  une tentative, ou "Direct indisponible" + bouton "Réessayer le direct" après un échec initial. Pas
  de nouvelle zone bordée avec ses propres graphiques.

Luminosité : nouvelle fonction `molToLuxLabel(mol: number): string` implémentant la formule
ci-dessus (floor 500 lux → 0, seuil 10000 lux → klux, arrondi entier). Remplace uniquement le sous-
texte "Instantané : X mol/m²/j" déjà présent dans le hint de la gauge "Luminosité (DLI)"
(`devices.$deviceId.tsx`, dérivé de `health.parameters.luminosity.liveValue`) par "Instantané : X
lux"/"X klux" — c'est cette valeur ponctuelle, pas la gauge principale, que l'app officielle affiche
en lux/klux. La gauge principale (total journalier en mol/m²/j, Part H) est un concept différent
— comparaison à un seuil Health Engine, pas une lecture live — et reste inchangée.

## Error handling (jamais silencieux, `CLAUDE.md` section 7.1)

- Échec de connexion live initial → message explicite + bouton retry manuel, jamais une page qui a
  juste l'air figée.
- Échec du chemin rapide "arrosage pendant le direct" → repli automatique et **toujours confirmé**
  (voir Décision 4) — jamais un clic "Arroser" qui semble avoir marché sans l'avoir fait.
- Perte de connexion live en cours de session (déjà géré par l'infra existante :
  `liveSession.onSample`'s `onError`/événement `ended` avec `reason: 'error'`) — inchangé, toast +
  repli sur les données POLL déjà affichées.

## Hors scope pour ce sous-projet

- **Bug de température live à 39°C** : root-causé et corrigé sur `main` avant le début de ce
  brainstorming (commit `b14a9f4`, voir `docs/superpowers/specs/2026-09-02-parrot-fa07-led-state-
  not-moisture.md`) — `fa09` (lu par erreur comme température) remplacé par `fa0a`. **Pas encore
  déployé en prod** au moment de l'écriture de cette spec. Aucun travail de conception ici : le plan
  d'implémentation de ce sous-projet doit inclure une étape "déployer + confirmer sur les 3 pots
  réels" plutôt qu'un correctif de code.
- Le repli visuel "connexion échouée → historique + infos connues" ne nécessite aucune nouvelle UI :
  le bloc "Détails techniques" (déjà ouvert par défaut, `techOpen = true`) sert déjà ce rôle
  puisqu'il affiche les dernières données POLL indépendamment de l'état du live.

## Testing plan (provider mock — pas de hardware BLE réel dans cet environnement)

- Auto-start au montage de la page, reconnexion après cutoff simulé (paramètre `maxDurationMs`
  déjà overridable dans `startLiveSession`), arrêt à la mise en arrière-plan de l'onglet (simulable
  via `document.dispatchEvent` en test/Playwright).
- Échec de connexion initial (mock configuré pour échouer) → bouton retry apparaît, un nouveau clic
  relance correctement.
- Gauges ET graphique historique se mettent à jour pendant une session live simulée (vérifier que le
  cache `devices.history` grossit puis se re-borne correctement à la fenêtre de la période).
- Arrosage pendant une session live mock : chemin rapide réussit (mock implémente
  `LiveConnectionHandle`), puis un second scénario où le mock fait échouer le chemin rapide —
  vérifie que la session live est coupée et que le chemin normal prend le relais avec un
  `WateringEvent` correctement enregistré dans les deux cas (succès et échec final).
- `molToLuxLabel()` : cas unitaires sur les seuils (500 lux floor, 10000 lux → klux, arrondis).
- **Non couvert par le mock, à valider sur hardware réel avant de considérer ce point comme fiable** :
  l'écriture concurrente sur le service `39e1f900` pendant que des notifications actives tournent
  sur `39e1fa00` sur la même connexion GATT réelle (BlueZ/node-ble) — c'est le seul vrai risque
  technique non couvert par les tests automatisés de ce projet.
