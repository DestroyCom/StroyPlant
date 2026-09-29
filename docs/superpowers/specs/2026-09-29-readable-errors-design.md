# Sous-projet 5 — Affichage d'erreurs lisible (design)

Sous-projet 5 de `docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md`. Brainstorming du
2026-09-29 avec DestCom, les 3 décisions structurantes ci-dessous ont été validées explicitement.

## Problème

L'UI affiche des messages techniques bruts à l'utilisateur, sous des titres génériques
("Échec de la synchronisation", "Échec de l'arrosage") : `le-connection-abort-by-local`,
`TIMEOUT: gatt (18000ms)`, etc. Trois sources :

1. **Erreurs BLE persistées** — `SyncEvent.errorDetail` / `WateringEvent.errorDetail`, affichées
   telles quelles dans la page Historique (`history.tsx`) et dans "Derniers arrosages" de la page
   détail (`devices.$deviceId.tsx`).
2. **Messages de nos propres `TRPCError`** — mélange d'anglais (`Device not found`,
   `Plant Dr is Parrot Pot only`…) et de français, remontés dans les toasts.
3. **Le cas proxy `<!DOCTYPE`** — déjà traité depuis le 2026-09-01 par
   `frontend/src/lib/format-error.ts`'s `getErrorMessage()`, qui est aussi déjà le point de passage
   unique de tous les toasts d'erreur.

### Inventaire réel (prod, 2026-09-29, lecture seule)

`SyncEvent` : 3888 lignes, toutes avec `errorDetail`. `WateringEvent` : 3 échecs sur 71.
MAC et durées normalisées pour le comptage :

| Nb | Motif brut |
|---|---|
| 3046 | `le-connection-abort-by-local` |
| 286 | `TIMEOUT: connect (<N>ms)` |
| 232 | `TIMEOUT: gatt (<N>ms)` |
| 187 | `operation timed out` |
| 49 | `Malformed soilMoisturePercent (fa07) buffer: 1 byte(s), expected 4 (hex=00)` |
| 41 | `Attempt to access memory outside buffer bounds` |
| 39 | `Operation already in progress` |
| 4 | `Operation failed with ATT error: 0x0e` |
| 2 | `br-connection-canceled` |
| 1 | `TIMEOUT: notification LYWSD03MMC (<N>ms)` |
| 1 | `Refusing activation, D-Bus is shutting down.` |

(`WateringEvent` : 3× `le-connection-abort-by-local`.)

## Décisions validées

1. **Le message technique d'origine reste accessible, replié** — message clair en principal, un
   lien discret "Détails techniques" déplie le brut. Rejeté : le cacher entièrement (plus
   consultable que par SQL/logs), l'afficher en permanence en petit (le bruit reste à l'écran).
2. **Niveau de détail : cause + action** — ce qui s'est passé ET s'il faut agir. Rejeté : cause
   seule en une ligne.
3. **Traduction côté frontend, à l'affichage (approche A)** — la base garde le brut inchangé.
   Rejetés : traduction backend avec un champ `errorMessage` en plus (plus de câblage, et le seul
   autre consommateur, MCP, est une IA à qui le brut sert mieux) ; codes d'erreur structurés émis
   par les providers BLE (toucherait toute la couche BLE, disproportionné face à 11 motifs
   reconnaissables par regex).

Conséquences directes de (3) : aucune migration, l'historique existant (3888 lignes) est traduit
gratuitement ; la déduplication de `persistSyncFailure` (`backend/src/readings.ts`), qui compare
les `errorDetail` bruts, n'est pas affectée.

## Design

### 1. `frontend/src/lib/describe-error.ts` (nouveau, fonction pure)

```ts
type ErrorContext = 'sync' | 'watering' | 'action';
interface DescribedError { message: string; hint: string | null; raw: string; known: boolean }
function describeError(raw: string, context: ErrorContext): DescribedError;
```

Table ordonnée de motifs (regex, insensible à la casse) → message ; **la première correspondance
gagne**, donc MAC/durées variables n'ont aucune incidence. Motif inconnu → `known: false`,
message "Erreur inattendue.", jamais un message inventé.

| Motif | Message (cause) |
|---|---|
| `le-connection-abort-by-local` | La connexion Bluetooth avec l'appareil a été coupée en cours de route (souvent un signal faible ou des interférences). |
| `TIMEOUT: connect`, `operation timed out`, `br-connection-canceled` | L'appareil n'a pas répondu à la demande de connexion (trop loin, piles faibles ou en veille). |
| `TIMEOUT: gatt` | L'appareil s'est connecté mais n'a pas transmis la liste de ses capteurs à temps. |
| `Operation already in progress` | Une connexion précédente à cet appareil était encore en cours. |
| `Malformed .* buffer`, `outside buffer bounds` | Un capteur a renvoyé une réponse incomplète. |
| `ATT error` | L'appareil a refusé la lecture d'un capteur. |
| `TIMEOUT: notification` | Le capteur n'a pas envoyé sa mesure à temps. |
| `D-Bus is shutting down` | Le service Bluetooth du serveur était en train de redémarrer. |
| `<!doctype` | Le message proxy existant de `format-error.ts`, repris tel quel. |

**Conseil (`hint`) selon le contexte** — une synchro ratée est retentée automatiquement, un
arrosage raté non :

- `sync` : "Nouvelle tentative automatique au prochain cycle." — et, pour les deux motifs de
  connexion les plus fréquents (`le-connection-abort-by-local` et la ligne `TIMEOUT: connect`/
  `operation timed out`/`br-connection-canceled`), en plus : "Si ça dure sur tous les appareils, le
  Bluetooth du serveur est probablement en cause." (exactement l'incident BlueZ du 2026-09-28).
- `watering` : "L'arrosage n'a pas eu lieu — tu peux réessayer."
- `action` : "Réessaie dans un instant."
- Motif proxy `<!doctype` : pas de `hint` séparé (son message contient déjà le conseil).
- Motif inconnu : pas de `hint` (on ne sait pas quoi conseiller).

### 2. `frontend/src/components/error-detail.tsx` (nouveau)

`<ErrorDetail raw={string} context={ErrorContext} />` — message + conseil, puis un petit bouton
"Détails techniques" (état local `useState`, fermé par défaut) qui déplie `raw` en police mono.
Remplace les 2 affichages bruts d'`errorDetail` :

- `history.tsx` — contexte `sync` pour une ligne `SyncEvent`, `watering` pour une ligne
  `WateringEvent`.
- `devices.$deviceId.tsx`, bloc "Derniers arrosages" — contexte `watering`.

### 3. `getErrorMessage()` (toasts, `format-error.ts`)

Passe par `describeError(raw, 'action')`, avec une distinction volontaire :

- **motif reconnu** → le toast affiche `message` + `hint` ; le brut part dans `console.error`
  (un toast ne se prête pas à un repliable) ;
- **motif inconnu** → le message est gardé **tel quel** : dans un toast, un message non reconnu
  est presque toujours un de nos propres messages backend, déjà lisible (ex. "Un appareil avec
  cette adresse existe déjà") — le remplacer par "Erreur inattendue" serait une régression.

Le cas `<!DOCTYPE` actuel devient une simple ligne de la table ; `PROXY_TIMEOUT_MESSAGE` reste la
seule source de ce texte.

### 4. Dernier affichage brut

`plants.tsx` : `filterGroupsError.message` → `getErrorMessage(filterGroupsError)`.

### 5. Messages backend traduits à la source

Nos propres `TRPCError` en anglais passent en français directement dans le code (ce sont nos
textes, pas besoin de la table) :

- `Device not found` → "Appareil introuvable" (toutes les occurrences, ~15) ;
- `Plant Dr is Parrot Pot only` / `Watering config is Parrot Pot only` → "Fonction réservée au
  Parrot Pot" ;
- `A calibration is already running for this device` → "Une calibration est déjà en cours pour
  cet appareil" ;
- `A config push is already running for this device` → "Un envoi de configuration est déjà en
  cours pour cet appareil" ;
- `Assign a species with a known soil moisture minimum before calibrating` → "Assigne d'abord une
  espèce dont l'humidité minimale est connue" ;
- `Plant profile not found` → "Espèce introuvable".

Hors périmètre : `Unknown MCP session user` (jamais vu dans l'UI) et les `throw new Error` internes
des providers (ils finissent dans `errorDetail` et passent donc par la table ; un motif rare non
listé retombe proprement sur "Erreur inattendue" + brut).

### Inchangé

Base de données, providers BLE, MQTT, MCP, et les titres existants ("Échec de la
synchronisation", etc.) — seule leur description devient lisible.

## Tests et vérification

- **`describeError` testé automatiquement** — premier test du frontend (aucun lanceur de tests
  aujourd'hui) : script `test` ajouté au `frontend/package.json` sur le modèle du backend
  (`tsx --test`, `node:test`), `tsx` en devDependency du frontend. Couvre chacune des 11 formes
  réelles ci-dessus (avec MAC/durées variables), le repli inconnu, et le conseil selon le contexte.
  `getErrorMessage` : un test vérifie qu'un message backend non reconnu passe tel quel.
- **Backend** : aucun test n'attend les messages anglais traduits (vérifié) ; `tsc --noEmit` +
  `pnpm test` relancés quand même.
- **Visuel** : page Historique avec une erreur injectée par forme + une inconnue, dépliage
  "Détails techniques", un toast d'erreur — dans un vrai navigateur contre le provider mock, base
  de dev restaurée ensuite.
- **Doc** : entrée CLAUDE.md, sous-projet 5 coché dans la roadmap, et la mention du fournisseur du
  proxy de production dans la roadmap remplacée par un terme générique.
