# Mode live par défaut — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** À l'ouverture de `/devices/$deviceId`, démarrer automatiquement une session live qui met à
jour en direct les gauges et graphiques déjà affichés (bloc "Détails techniques") au lieu d'un
bouton manuel + une zone séparée — plus un arrosage quasi instantané pendant que le direct tourne,
et une unité de luminosité live corrigée (lux/klux au lieu de mol/m²/j).

**Architecture:** Le provider `DeviceProvider.subscribeLive` expose désormais, une fois la connexion
GATT établie, un petit `LiveConnectionHandle` permettant d'écrire sur le service d'arrosage sans
rouvrir de connexion. `liveSession/manager.ts` garde ce handle le temps de la session ; la mutation
`devices.water` l'utilise en premier (quasi instantané), avec repli automatique et toujours confirmé
vers le chemin `connectionQueue` existant en cas d'échec. Côté frontend, l'ancien composant
`LiveModeSection` (zone visuelle séparée) devient un hook headless (`useLiveMode`) qui pousse chaque
échantillon directement dans les caches TanStack Query déjà consommés par la page (gauges via
l'infra existante `use-live-readings.ts`, graphique historique via un nouvel ajout borné au cache
`devices.history`).

**Tech Stack:** Fastify/tRPC, Prisma/SQLite, `node-ble` (BlueZ) + provider `mock`, React 19 +
TanStack Query/Router, `node:test` (backend uniquement — le frontend n'a pas d'infra de tests
automatisés dans ce projet, voir Global Constraints).

**Spec:** `docs/superpowers/specs/2026-09-02-live-mode-default-design.md`

## Global Constraints

- Jamais d'échec silencieux sur un déclenchement d'arrosage (`CLAUDE.md` section 7.1, précédent
  WatchFlower) — tout chemin doit se conclure par un `WateringEvent` explicite ou une erreur remontée
  à l'appelant, jamais un `catch` qui avale.
- `pnpm` exclusivement, TypeScript partout, pas de Python.
- **Convention de tests déjà établie dans ce projet, à ne pas réinventer ici** : seules les fonctions
  pures sans I/O ont des tests automatisés backend (`node:test`, ex. `readFloatLESafe`,
  `wateringConfig.test.ts`). Tout ce qui touche Prisma, une vraie connexion GATT, ou l'état
  singleton d'un EventEmitter (`liveSession/manager.ts`, `watering.ts`, les providers) est vérifié
  manuellement (curl + provider mock), jamais testé automatiquement — c'est déjà le cas pour
  `liveSession/manager.ts`, `watering.ts` et les 3 providers aujourd'hui, aucun fichier `.test.ts`
  n'existe pour eux. Le frontend n'a **aucune** infrastructure de tests automatisés dans ce
  monorepo (`frontend/package.json` n'a pas de script `test`) — vérification via `pnpm typecheck`
  (jamais la commande racine `tsc --noEmit`, qui est un no-op silencieux, voir `CLAUDE.md`
  "Gotchas") + vérification manuelle/Playwright.
- `cd backend && pnpm exec tsc --noEmit && pnpm test` et `cd frontend && pnpm typecheck` doivent
  rester clean après chaque tâche.
- Ne jamais committer avec `Co-Authored-By` (règle globale utilisateur).

---

### Task 1: Contrat `LiveConnectionHandle` sur `DeviceProvider`

**Files:**
- Modify: `backend/src/providers/types.ts`

**Interfaces:**
- Produces: `LiveConnectionHandle` (interface, `triggerWatering(): Promise<void>`) ; `subscribeLive`
  gagne un 5e paramètre optionnel `onConnectionReady?: (handle: LiveConnectionHandle) => void`.

- [ ] **Step 1: Ajouter le type et étendre la signature**

Dans `backend/src/providers/types.ts`, juste avant `export interface DeviceProvider {` :

```ts
// Permet à un appelant qui a déjà accès à une session live (donc une connexion GATT déjà ouverte)
// de déclencher une action dessus sans repasser par connectionQueue.run() — ce qui, pour un
// arrosage, attendrait sinon la fin complète de la session live (jusqu'à 5min, voir
// docs/superpowers/specs/2026-09-02-live-mode-default-design.md, "Key constraint"). Doit toujours
// rejeter explicitement en cas d'échec — jamais un no-op silencieux, l'appelant est responsable du
// repli vers le chemin normal (docs/STROYPLANT_SPEC.md section 7.1).
export interface LiveConnectionHandle {
  triggerWatering(): Promise<void>;
}
```

Puis modifier la signature de `subscribeLive` dans `DeviceProvider` :

```ts
  // Streams live sensor samples (real GATT notify on the Parrot Pot, best-effort on the Xiaomi —
  // see docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md) until `signal` aborts.
  // Resolves cleanly on abort. Throws on any unrecoverable failure (GATT error, unexpected
  // disconnect) — callers must treat a thrown error as the session having ended abnormally, never
  // retry it themselves (a live session that already streamed real samples must not silently
  // restart from scratch). `onSample` is awaited before the provider processes the next
  // notification, so persistence (which it triggers) never races itself.
  //
  // `onConnectionReady`, when provided, is called once the GATT connection is established (before
  // notifications start) with a LiveConnectionHandle for reusing that same connection — only
  // node-ble and mock implement it for PARROT_POT (see docs/superpowers/specs/2026-09-02-live-mode-
  // default-design.md); other providers/kinds simply never call it.
  subscribeLive(
    deviceId: string,
    kind: DeviceKind,
    onSample: (reading: SensorReading) => Promise<void>,
    signal: AbortSignal,
    onConnectionReady?: (handle: LiveConnectionHandle) => void,
  ): Promise<void>;
```

- [ ] **Step 2: Vérifier que ça compile (les 3 providers n'implémentent pas encore le 5e paramètre, ce qui est valide en TypeScript — un paramètre en moins est compatible avec une signature qui en a un de plus, optionnel)**

Run: `cd backend && pnpm exec tsc --noEmit`
Expected: aucune erreur.

- [ ] **Step 3: Commit**

```bash
git add backend/src/providers/types.ts
git commit -m "feat: add LiveConnectionHandle to the provider contract"
```

---

### Task 2: `mock` provider implémente le handle

**Files:**
- Modify: `backend/src/providers/mock/index.ts`

**Interfaces:**
- Consumes: `LiveConnectionHandle` (Task 1)
- Produces: rien de nouveau exposé — juste une implémentation concrète du contrat pour les tests
  manuels des tâches suivantes.

- [ ] **Step 1: Extraire la logique d'arrosage dans une fonction partagée**

Remplacer le corps actuel de `triggerAction` (`backend/src/providers/mock/index.ts:318-344`) — il
duplique actuellement toute la logique de mutation du pot mock ; on l'extrait pour la réutiliser
aussi depuis `subscribeLive`. Juste avant `return { name: 'mock', ... }` (le retour de l'objet
provider, cherchez la fonction factory qui contient `pots`/`applyPotDecay`), ajouter :

```ts
function applyMockWatering(deviceId: string, label: string): void {
  const pot = pots.get(deviceId);
  if (!pot) throw new Error(`Mock device ${deviceId} inconnu ou sans actionneur (Xiaomi ne s'arrose pas)`);
  applyPotDecay(pot);

  if (pot.waterTankLevelPercent <= 0) {
    log({ direction: 'WRITE', label, deviceId, result: 'ERROR', detail: 'Reservoir empty — watering impossible' });
    throw new Error('Reservoir empty — watering impossible');
  }

  pot.waterTankLevelPercent = Math.max(0, pot.waterTankLevelPercent - 15);
  pot.soilMoisturePercent = Math.min(55, pot.soilMoisturePercent + 25);
  log({
    direction: 'WRITE',
    label,
    deviceId,
    result: 'OK',
    detail: `nouveau tank=${pot.waterTankLevelPercent}% soil=${pot.soilMoisturePercent.toFixed(1)}%`,
  });
}
```

- [ ] **Step 2: Remplacer `triggerAction` par un simple appel à la fonction partagée**

```ts
    async triggerAction(deviceId: string, action): Promise<void> {
      if (action !== 'water') throw new Error(`Unsupported action: ${action}`);
      applyMockWatering(deviceId, 'Watering trigger (mock)');
    },
```

- [ ] **Step 3: Appeler `onConnectionReady` dans `subscribeLive`**

Au tout début du corps de `subscribeLive` (`backend/src/providers/mock/index.ts:252`), avant le
`await new Promise<void>(...)` existant :

```ts
    async subscribeLive(deviceId: string, kind, onSample, signal, onConnectionReady): Promise<void> {
      if (kind === 'PARROT_POT' && onConnectionReady) {
        onConnectionReady({
          async triggerWatering() {
            applyMockWatering(deviceId, 'Watering trigger (mock, via live connection)');
          },
        });
      }

      await new Promise<void>((resolve, reject) => {
```

(le reste du corps de la fonction ne change pas)

- [ ] **Step 4: Vérifier manuellement**

Run: `cd backend && pnpm exec tsc --noEmit`
Expected: clean.

Vérification comportementale manuelle (pas de test automatisé, cf. Global Constraints) — un script
scratch rapide :

```bash
cd backend && cat > /tmp/mock-live-handle-check.ts << 'EOF'
import { createMockProvider } from './src/providers/mock/index.js';

const provider = createMockProvider();
const controller = new AbortController();
let handle: { triggerWatering: () => Promise<void> } | undefined;

const sessionPromise = provider.subscribeLive(
  'MOCK-POT-NORMAL',
  'PARROT_POT',
  async () => {},
  controller.signal,
  (h) => { handle = h; },
);

await new Promise((r) => setTimeout(r, 50));
if (!handle) throw new Error('onConnectionReady never called');
await handle.triggerWatering();
console.log('OK: triggerWatering via handle succeeded on MOCK-POT-NORMAL');

controller.abort();
await sessionPromise;
EOF
pnpm exec tsx /tmp/mock-live-handle-check.ts
rm /tmp/mock-live-handle-check.ts
```

Expected output: `OK: triggerWatering via handle succeeded on MOCK-POT-NORMAL`, no error.

- [ ] **Step 5: Commit**

```bash
git add backend/src/providers/mock/index.ts
git commit -m "feat: mock provider implements LiveConnectionHandle"
```

---

### Task 3: `node-ble` provider implémente le handle

**Files:**
- Modify: `backend/src/providers/node-ble/index.ts`

**Interfaces:**
- Consumes: `LiveConnectionHandle` (Task 1), `WATERING_SERVICE_UUID`/`UUIDS.watering.trigger`/
  `WATER_TRIGGER_PAYLOAD` (déjà importés dans ce fichier, voir `triggerAction` existant).
- Produces: rien de nouveau exposé.

- [ ] **Step 1: Ajouter le paramètre et construire le handle dans la branche Parrot Pot de `subscribeLive`**

Dans `backend/src/providers/node-ble/index.ts`, la signature de `subscribeLive` (ligne ~880) gagne
le 5e paramètre :

```ts
    async subscribeLive(deviceId: string, kind, onSample, signal, onConnectionReady): Promise<void> {
```

Puis, dans la branche Parrot Pot (après `const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');`,
ligne ~971, et AVANT `const sensorService = await gatt.getPrimaryService(SENSOR_SERVICE_UUID);`) :

```ts
        const gatt = await withTimeout(device.gatt(), CONNECT_TIMEOUT_MS, 'gatt');

        if (kind === 'PARROT_POT' && onConnectionReady) {
          onConnectionReady({
            async triggerWatering() {
              const wateringService = await gatt.getPrimaryService(WATERING_SERVICE_UUID);
              const trigger = await trackedCharacteristic(wateringService, UUIDS.watering.trigger, characteristics);
              await trigger.writeValueWithResponse(WATER_TRIGGER_PAYLOAD);
              log({
                direction: 'WRITE',
                label: 'Watering trigger (via live connection)',
                uuid: UUIDS.watering.trigger,
                deviceId,
                payloadHex: WATER_TRIGGER_PAYLOAD.toString('hex'),
                result: 'OK',
              });
            },
          });
        }

        const sensorService = await gatt.getPrimaryService(SENSOR_SERVICE_UUID);
```

Note : `characteristics` est le tableau déjà déclaré en haut du bloc `try` de cette fonction (ligne
~967, `const characteristics: GattCharacteristic[] = [];`) — le service d'arrosage utilise
volontairement le même tableau que le service capteurs, donc `releaseDbusListeners` (déjà appelé
dans le `finally` final de la fonction, ligne ~1116) nettoie aussi cette caractéristique sans code
supplémentaire.

- [ ] **Step 2: Vérifier que ça compile**

Run: `cd backend && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/providers/node-ble/index.ts
git commit -m "feat: node-ble provider implements LiveConnectionHandle"
```

**Note pour la suite du projet** : ce chemin n'est validable qu'avec du hardware réel (écriture sur
`39e1f900` pendant que des notifications tournent sur `39e1fa00`, sur la même connexion BlueZ) — le
mock ne peut pas le couvrir. Voir Task 11.

---

### Task 4: `liveSession/manager.ts` — exposer le handle actif

**Files:**
- Modify: `backend/src/liveSession/manager.ts`

**Interfaces:**
- Consumes: `LiveConnectionHandle` (Task 1)
- Produces: `getActiveLiveConnectionHandle(deviceId: string): LiveConnectionHandle | null`

- [ ] **Step 1: Ajouter l'état module-level et le passer à `subscribeLive`**

Dans `backend/src/liveSession/manager.ts`, ajouter l'import du type (ligne 7, à côté de
`DeviceProvider, SensorReading`) :

```ts
import type { DeviceProvider, LiveConnectionHandle, SensorReading } from '../providers/types.js';
```

Ajouter la variable module-level, juste après `let activeSession: ActiveSession | null = null;`
(ligne 44) :

```ts
let liveConnectionHandle: LiveConnectionHandle | null = null;
```

Ajouter la fonction exportée, juste après `getActiveLiveSession` (ligne 51) :

```ts
// Non-null uniquement si une session live est active POUR CE deviceId ET que sa connexion GATT est
// déjà établie (le provider appelle onConnectionReady après connexion, avant les notifications —
// il y a donc une brève fenêtre au tout début d'une session où ceci retourne null même si
// activeSession existe déjà).
export function getActiveLiveConnectionHandle(deviceId: string): LiveConnectionHandle | null {
  if (activeSession?.deviceId !== deviceId) return null;
  return liveConnectionHandle;
}
```

Dans `startLiveSession`, passer un callback à `subscribeLive` (ligne ~101) :

```ts
  connectionQueue
    .run(() => provider.subscribeLive(deviceId, kind, onSample, controller.signal, (handle) => { liveConnectionHandle = handle; }))
```

Et nettoyer dans le `.finally()` existant (ligne ~114-117), à côté de `activeSession = null;` :

```ts
    .finally(() => {
      clearTimeout(timeoutHandle);
      activeSession = null;
      liveConnectionHandle = null;
    })
```

- [ ] **Step 2: Vérifier que ça compile**

Run: `cd backend && pnpm exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add backend/src/liveSession/manager.ts
git commit -m "feat: liveSession manager exposes the active LiveConnectionHandle"
```

---

### Task 5: `watering.ts` — factoriser l'enregistrement du résultat

**Files:**
- Modify: `backend/src/watering.ts`

**Interfaces:**
- Produces: `recordWateringOutcome(deviceId: string, triggerSource: TriggerSource, result: WateringResult): Promise<WateringResult>`
  (nouveau, exporté). `triggerWatering(...)` garde exactement la même signature et le même
  comportement observable qu'aujourd'hui — refactor pur, aucun changement de contrat pour ses
  appelants existants (scheduler, MQTT, `devices.water` avant Task 6).

- [ ] **Step 1: Extraire `recordWateringOutcome` et faire de `triggerWatering` un simple appelant**

Remplacer tout le corps de `backend/src/watering.ts` à partir de `export async function
triggerWatering` :

```ts
// Shared by the manual trigger (devices.water — direct path AND the live-connection fast path,
// Task 6), the auto-watering scheduler (Batch 5), and the HA MQTT watering button (Batch 7) so the
// never-fire-and-forget contract (docs/STROYPLANT_SPEC.md section 7.1, identified WatchFlower bug)
// is enforced in exactly one place: every attempt, from any caller, is written to WateringEvent
// with an explicit success/failure, never just logged and dropped — and, when MQTT is enabled,
// also republished to `wateringResultTopic` so the outcome stays visible in Home Assistant
// regardless of which surface triggered it.
export async function recordWateringOutcome(
  deviceId: string,
  triggerSource: TriggerSource,
  result: WateringResult,
): Promise<WateringResult> {
  await prisma.wateringEvent.create({
    data: { deviceId, triggerSource, success: result.success, errorDetail: result.errorDetail },
  });
  if (!result.success) {
    log({ direction: 'WRITE', label: `${triggerSource} watering trigger failed`, deviceId, result: 'ERROR', detail: result.errorDetail });
  }

  const mqttState = getMqttState();
  if (mqttState) publishWateringResult(mqttState.client, deviceId, result, mqttState.baseTopic);
  return result;
}

export async function triggerWatering(
  deviceId: string,
  triggerSource: TriggerSource,
  provider: DeviceProvider,
  connectionQueue: ConnectionQueue,
): Promise<WateringResult> {
  let result: WateringResult;
  try {
    await connectionQueue.run(() => provider.triggerAction(deviceId, 'water'));
    result = { success: true };
  } catch (error) {
    result = { success: false, errorDetail: error instanceof Error ? error.message : String(error) };
  }
  return recordWateringOutcome(deviceId, triggerSource, result);
}
```

(`WateringResult`, les imports et le reste du fichier au-dessus ne changent pas.)

- [ ] **Step 2: Vérifier que ça compile et que les tests passent**

Run: `cd backend && pnpm exec tsc --noEmit && pnpm test`
Expected: clean, aucune régression (aucun test n'existe pour ce fichier, cf. Global Constraints —
c'est le `tsc` qui garantit que les appelants existants du scheduler/MQTT restent compatibles).

- [ ] **Step 3: Vérification manuelle du comportement observable inchangé**

Contre le provider mock (backend démarré en local, `DEVICE_PROVIDER=mock` ou équivalent dev déjà en
place) :

```bash
curl -s -X POST http://localhost:3000/api/trpc/devices.water \
  -H 'Content-Type: application/json' -b <cookie de session admin> \
  -d '{"deviceId":"MOCK-POT-DECLINE"}'
```

Expected : échec explicite (réservoir vide), un `WateringEvent{success:false}` créé — comportement
identique à avant ce refactor.

- [ ] **Step 4: Commit**

```bash
git add backend/src/watering.ts
git commit -m "refactor: extract recordWateringOutcome from triggerWatering"
```

---

### Task 6: `devices.water` — chemin rapide via la connexion live + repli explicite

**Files:**
- Modify: `backend/src/api/trpc/routers/devices.ts`

**Interfaces:**
- Consumes: `getActiveLiveConnectionHandle`, `stopLiveSession` (Task 4), `recordWateringOutcome`,
  `triggerWatering` (Task 5), `withTimeout` (`backend/src/ble/parrot/retry.ts`, déjà existant).

- [ ] **Step 1: Ajouter les imports**

Dans `backend/src/api/trpc/routers/devices.ts`, ligne 10, remplacer :

```ts
import { triggerWatering } from '../../../watering.js';
```

par :

```ts
import { recordWateringOutcome, triggerWatering } from '../../../watering.js';
```

Et ajouter deux nouveaux imports (après la ligne 9, `persistReading, persistSyncFailure`) :

```ts
import { withTimeout } from '../../../ble/parrot/retry.js';
import { getActiveLiveConnectionHandle, stopLiveSession } from '../../../liveSession/manager.js';
```

- [ ] **Step 2: Ajouter la constante de timeout et réécrire la mutation `water`**

Juste avant `export const devicesRouter = router({` (ou en haut du fichier avec les autres
constantes locales), ajouter :

```ts
// Le chemin rapide (écriture sur la connexion live déjà ouverte) doit échouer vite pour ne jamais
// retarder le repli vers le chemin normal plus que nécessaire — bien plus court que
// CONNECT_TIMEOUT_MS (18s), qui couvre l'ouverture d'une connexion complète, pas une simple
// écriture sur une connexion déjà établie.
const LIVE_WATERING_FAST_PATH_TIMEOUT_MS = 5000;
```

Remplacer la mutation `water` existante (`backend/src/api/trpc/routers/devices.ts:159-166`) :

```ts
  water: protectedProcedure.input(z.object({ deviceId: z.string() })).mutation(async ({ ctx, input }) => {
    const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
    if (!device) throw new TRPCError({ code: 'NOT_FOUND', message: 'Device not found' });

    // Chemin rapide : une session live est en cours sur ce device, on réutilise sa connexion GATT
    // déjà ouverte au lieu d'attendre la fin de la session (jusqu'à 5min) pour passer par
    // connectionQueue (voir docs/superpowers/specs/2026-09-02-live-mode-default-design.md, "Key
    // constraint"). Un échec ici n'est PAS enregistré comme un échec d'arrosage — ce n'est qu'une
    // tentative interne, le vrai résultat est celui du repli ci-dessous, qui, lui, est toujours
    // enregistré (docs/STROYPLANT_SPEC.md section 7.1).
    const liveHandle = getActiveLiveConnectionHandle(device.id);
    if (liveHandle) {
      try {
        await withTimeout(liveHandle.triggerWatering(), LIVE_WATERING_FAST_PATH_TIMEOUT_MS, 'live-watering-fast-path');
        await recordWateringOutcome(device.id, 'MANUAL', { success: true });
        return { ok: true as const };
      } catch {
        // Libère la queue au plus vite pour le repli ci-dessous plutôt que de laisser la session
        // live continuer à la tenir jusqu'à sa fin naturelle.
        stopLiveSession(device.id);
      }
    }

    const result = await triggerWatering(device.id, 'MANUAL', ctx.provider, ctx.connectionQueue);
    if (!result.success) throw new TRPCError({ code: 'BAD_GATEWAY', message: result.errorDetail });
    return { ok: true as const };
  }),
```

- [ ] **Step 3: Vérifier que ça compile et que les tests passent**

Run: `cd backend && pnpm exec tsc --noEmit && pnpm test`
Expected: clean.

- [ ] **Step 4: Vérification manuelle — 3 scénarios contre le provider mock**

Démarrer le backend en dev (mock provider), avec une session admin :

1. **Sans session live active** : `devices.water` sur `MOCK-POT-NORMAL` → succès, comportement
   identique à avant (chemin normal uniquement, `liveHandle` est `null`).
2. **Avec une session live active sur ce device** (`liveSession.start` avant) : `devices.water` sur
   le même device → doit résoudre quasi instantanément (pas d'attente de connectionQueue), un seul
   `WateringEvent{success:true}` créé (pas de doublon).
3. **Simuler un échec du chemin rapide** : temporairement faire lancer une exception dans le mock
   `triggerWatering` du handle (Task 2) pour ce test, appeler `devices.water` avec une session live
   active → vérifier que la session live se termine (`liveSession.status` retourne `null` juste
   après), qu'un seul `WateringEvent` est créé au final (celui du chemin normal, pas de doublon côté
   chemin rapide), et que le résultat correspond au chemin normal (succès ou `BAD_GATEWAY` selon
   l'état du mock). Annuler la modification temporaire après ce test.

- [ ] **Step 5: Commit**

```bash
git add backend/src/api/trpc/routers/devices.ts
git commit -m "feat: devices.water tries the live connection first, falls back explicitly"
```

---

### Task 7: Formule lux/klux pour la luminosité live

**Files:**
- Modify: `frontend/src/lib/format.ts`
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`

**Interfaces:**
- Produces: `molToLuxLabel(mol: number): string`

- [ ] **Step 1: Ajouter `molToLuxLabel` dans `format.ts`**

Ajouter à la fin de `frontend/src/lib/format.ts` :

```ts
// Formule et seuils tirés de la décompilation officielle Flower Power (Utility.convertMolToLux +
// BridgeGraphicView/DataKeeper), pas devinés — voir docs/superpowers/specs/2026-09-02-live-mode-
// default-design.md, "Evidence this is real". `mol` est notre luminosity/fa0b, déjà en mol/m²/j
// linéaire (confirmé empiriquement, CLAUDE.md Part H) — pas de transformation log à appliquer.
export function molToLuxLabel(mol: number): string {
  const lux = mol * 4659.293;
  if (lux < 500) return '0 lux';
  if (lux < 10000) return `${Math.round(lux)} lux`;
  return `${Math.round(lux / 1000)} klux`;
}
```

- [ ] **Step 2: Utiliser la fonction dans la gauge luminosité**

Dans `frontend/src/routes/_authenticated/devices.$deviceId.tsx`, ajouter l'import (ligne 18, à côté
des autres imports de `@/lib/format`) :

```ts
import { formatDeviceKind, formatRelativeTime, molToLuxLabel, statusBandClasses, statusDetail, statusHeadline } from '@/lib/format';
```

Remplacer la ligne (dans le hint de la gauge "Luminosité (DLI)", ~ligne 414-415) :

```ts
                            health?.parameters.luminosity?.liveValue != null &&
                              `Instantané : ${(health.parameters.luminosity.liveValue / 1000).toFixed(2)} mol/m²/j`,
```

par :

```ts
                            health?.parameters.luminosity?.liveValue != null &&
                              `Instantané : ${molToLuxLabel(health.parameters.luminosity.liveValue / 1000)}`,
```

(le reste de la gauge — valeur principale en mol/m²/j comparée au seuil Health Engine journalier —
ne change pas, voir la spec "Décisions validées avec DestCom", point luminosité.)

- [ ] **Step 3: Vérifier**

Run: `cd frontend && pnpm typecheck`
Expected: clean.

Vérification manuelle rapide (raisonnement, pas de script — cohérent avec l'absence d'infra de test
frontend) : `molToLuxLabel(0.0001)` → lux ≈ 0.47 → "0 lux" (floor) ; `molToLuxLabel(1)` → lux ≈ 4659
→ "4659 lux" ; `molToLuxLabel(3)` → lux ≈ 13978 → "14 klux". Cohérent avec les captures officielles
citées dans la spec ("8232 live lux" / "72 live klux").

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/format.ts frontend/src/routes/_authenticated/devices.\$deviceId.tsx
git commit -m "fix: display live luminosity in lux/klux instead of mol/m²/j"
```

---

### Task 8: Hook headless `useLiveMode` (remplace `LiveModeSection`)

**Files:**
- Create: `frontend/src/lib/use-live-mode.ts`
- Delete: `frontend/src/components/live-mode-section.tsx`

**Interfaces:**
- Consumes: `trpc.liveSession.{status,start,stop,onSample}` (inchangés), `trpc.devices.history`
  (`queryKey`, déjà utilisé ailleurs), `Reading`/`DeviceKind` (`@/lib/types`), `getErrorMessage`
  (`@/lib/format-error`).
- Produces: `useLiveMode(deviceId: string, kind: DeviceKind, hours: number): { status:
  'connecting' | 'live' | 'unavailable'; retry: () => void }`

- [ ] **Step 1: Créer le hook**

```ts
// frontend/src/lib/use-live-mode.ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSubscription } from '@trpc/tanstack-react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { trpc } from './trpc';
import type { DeviceKind, Reading } from './types';

export type LiveModeStatus = 'connecting' | 'live' | 'unavailable';

// Remplace l'ancien composant visuel `LiveModeSection` (docs/superpowers/specs/2026-09-02-live-
// mode-default-design.md) : plus de zone/bouton séparés, ce hook headless démarre le direct
// automatiquement à l'ouverture de la page et pousse chaque échantillon directement dans les caches
// déjà utilisés par le bloc "Détails techniques" existant :
// - Les gauges se mettent déjà à jour gratuitement via `use-live-readings.ts` (souscription globale
//   déjà en place, fusionne tout événement LIVE dans devices.list.lastReading).
// - Le graphique historique est mis à jour ici, en ajoutant chaque échantillon au cache
//   devices.history de la période actuellement affichée (borné à sa fenêtre temporelle pour ne pas
//   grossir indéfiniment si l'onglet reste ouvert avec plusieurs cycles de reconnexion).
export function useLiveMode(deviceId: string, kind: DeviceKind, hours: number): { status: LiveModeStatus; retry: () => void } {
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
  useEffect(() => {
    if (statusLoading || hasAttemptedResumeRef.current) return;
    hasAttemptedResumeRef.current = true;
    if (session?.deviceId === deviceId) {
      setIsLive(true);
      return;
    }
    startMutation.mutate({ deviceId });
    // biome-ignore lint/correctness/useExhaustiveDependencies: startMutation is stable enough for this one-shot effect, only statusLoading/session/deviceId should re-trigger it
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
            return [...readings, event.reading].filter((point) => new Date(point.timestamp).getTime() >= cutoffMs);
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
    // biome-ignore lint/correctness/useExhaustiveDependencies: startMutation/stopMutation are stable enough here, only isLive/unavailable/deviceId should re-bind the listener
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
```

Note : le paramètre `kind` est accepté pour cohérence d'API avec l'ancien composant et un futur
usage (ex. filtrer un comportement par type d'appareil) mais n'est pas utilisé dans le corps
actuel — TypeScript ne signale pas un paramètre de fonction non lu comme `noUnusedParameters` (ça ne
s'applique qu'aux variables locales), donc pas d'erreur de build à anticiper ici.

- [ ] **Step 2: Supprimer l'ancien composant**

```bash
git rm frontend/src/components/live-mode-section.tsx
```

- [ ] **Step 3: Vérifier que ça compile (la page qui l'importe sera corrigée en Task 9, donc une erreur d'import manquant est attendue à ce stade — ne pas s'en inquiéter avant Task 9)**

Run: `cd frontend && pnpm typecheck`
Expected: erreur sur l'import de `LiveModeSection` dans `devices.$deviceId.tsx` — normal, corrigé
dans la tâche suivante. Si d'autres erreurs apparaissent ailleurs dans `use-live-mode.ts` lui-même,
les corriger avant de continuer.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/lib/use-live-mode.ts
git commit -m "feat: add headless useLiveMode hook, remove LiveModeSection component"
```

---

### Task 9: Intégrer `useLiveMode` dans la page detail

**Files:**
- Modify: `frontend/src/routes/_authenticated/devices.$deviceId.tsx`

**Interfaces:**
- Consumes: `useLiveMode` (Task 8)

- [ ] **Step 1: Remplacer l'import et le montage du composant**

Remplacer (ligne 11) :

```ts
import { LiveModeSection } from '@/components/live-mode-section';
```

par :

```ts
import { useLiveMode } from '@/lib/use-live-mode';
```

Dans `DeviceDetailPage`, ajouter l'appel au hook juste après la définition de `period`/`history`
(après la ligne `const { data: history } = useQuery(...)`, ~ligne 93) :

```ts
  const { status: liveStatus, retry: retryLive } = useLiveMode(deviceId, device.kind, PERIOD_HOURS[period]);
```

Supprimer complètement la ligne `<LiveModeSection deviceId={deviceId} kind={device.kind} />`
(ligne 296).

- [ ] **Step 2: Ajouter l'indicateur compact près des boutons existants**

Remplacer le bloc des boutons (`backend/src/routes/.../devices.$deviceId.tsx:223-239` — le `<div
className="mt-5.5 flex items-center gap-2.5">` contenant "Synchroniser"/"Arroser maintenant") par :

```tsx
        <div className="mt-5.5 flex items-center gap-2.5">
          {liveStatus === 'live' && (
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-teal-500" />
              Direct
            </span>
          )}
          {liveStatus === 'connecting' && <span className="text-xs font-medium text-muted-foreground">Connexion…</span>}
          {liveStatus === 'unavailable' && (
            <Button variant="outline" size="sm" onClick={retryLive}>
              Réessayer le direct
            </Button>
          )}
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
```

- [ ] **Step 3: Reprendre le direct automatiquement après un arrosage qui l'a interrompu**

Le repli d'arrosage (Task 6) peut couper la session live si le chemin rapide échoue. Pour ne pas
laisser la page sur "non live" après un arrosage réussi via le chemin normal, ajouter dans
`waterMutation`'s `onSuccess` (ligne ~102-107) :

```ts
  const waterMutation = useMutation(
    trpc.devices.water.mutationOptions({
      onSuccess: () => {
        toast.success('Arrosage déclenché', { description: `${device.name ?? device.id} est en train d'être arrosé.` });
        setConfirmOpen(false);
        void queryClient.invalidateQueries({ queryKey: trpc.devices.list.queryKey() });
        void queryClient.invalidateQueries({ queryKey: trpc.devices.wateringEvents.queryKey({ deviceId }) });
        if (liveStatus !== 'live') retryLive();
      },
      onError: (error) => {
        toast.error("Échec de l'arrosage", { description: getErrorMessage(error) });
      },
    }),
  );
```

- [ ] **Step 4: Vérifier**

Run: `cd frontend && pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Vérification manuelle en navigateur (provider mock)**

Démarrer `pnpm dev` (backend mock + frontend), ouvrir `/devices/MOCK-POT-NORMAL` :

1. Le direct démarre automatiquement (indicateur "Direct" apparaît sans clic) et les gauges +
   graphique 24h bougent visiblement au fil des secondes.
2. Changer de période (7j/30j) — pas d'erreur, le graphique de la nouvelle période se charge
   normalement (les points live continuent d'alimenter uniquement le cache de la période
   sélectionnée à ce moment-là).
3. Quitter la page (retour dashboard) puis revenir — le direct redémarre proprement (pas d'état
   "Session déjà active" bloqué).
4. Simuler un onglet en arrière-plan (`document.dispatchEvent(new Event('visibilitychange'))` après
   avoir stubbé `document.visibilityState` via les devtools, ou onglet réellement mis en arrière-plan)
   → le direct s'arrête ; revenir au premier plan → reprend automatiquement.
5. **Échec de connexion initial + bouton "Réessayer le direct"** : le mock résout un device par son
   id dans ses `Map`s internes (`pots`/`xiaomiSensors`, `backend/src/providers/mock/index.ts`) — un
   device connu de Prisma mais absent de ces `Map`s reproduit un vrai échec de connexion. Créer
   temporairement un device via `devices.addByAddress` avec une adresse bidon (ex.
   `AA:BB:CC:DD:EE:FF`), ouvrir sa page detail → le hook tente une connexion, échoue
   (`Mock device AA:BB:CC:DD:EE:FF inconnu`), affiche "Réessayer le direct" après le seul essai
   automatique (pas de boucle). Cliquer dessus → nouvel essai, même échec, bouton toujours affiché
   (pas de 2e tentative automatique). Supprimer ce device de test ensuite.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/routes/_authenticated/devices.\$deviceId.tsx
git commit -m "feat: wire useLiveMode into the device detail page, remove the live mode toggle"
```

---

### Task 10: Déploiement + vérification finale sur hardware réel

**Files:** aucun — tâche opérationnelle, pas de code.

Cette tâche ne peut être exécutée que par DestCom (accès SSH production, décision de déployer) —
à traiter comme une checklist à cocher au fur et à mesure, pas une implémentation :

- [ ] Build + push l'image Docker (`.github/workflows/docker-publish.yml`, déjà automatique sur push
  `main`) incluant ce sous-projet ET le fix température déjà présent sur `main` (commit `b14a9f4`,
  voir la spec section "Hors scope").
- [ ] `docker compose pull && up -d` sur le serveur de production.
- [ ] Confirmer sur les 3 pots réels (`A0:14:3D:CD:A3:D3`, `A0:14:3D:CD:A0:73`,
  `A0:14:3D:CD:CD:87:33`) que `temperatureC` revient à des valeurs plausibles (~20°C, pas 39°C) —
  le fix température lui-même, pas ce sous-projet.
- [ ] Ouvrir la page detail d'un pot réel, confirmer que le direct démarre automatiquement, que les
  gauges/graphique bougent en direct, et que l'unité de luminosité affiche "X lux"/"X klux" au lieu
  de "X mol/m²/j" dans le sous-texte "Instantané".
- [ ] Déclencher un arrosage manuel sur `87:33` (pot de test, sans plante — jamais sur un pot réel
  avec une vraie plante pour ce test, cf. `CLAUDE.md` "Live-fire testing discipline") pendant que le
  direct tourne, confirmer que ça se déclenche quasi instantanément (chemin rapide) et que le direct
  continue sans interruption visible.
- [ ] Si le chemin rapide échoue en conditions réelles (log `Watering trigger (via live connection)`
  absent, repli visible dans les logs), documenter l'observation — c'est le scénario que Task 6
  couvre, pas une régression si le repli fonctionne correctement.

---
