# CLAUDE.md — StroyPlant

Instructions et contexte spécifiques à ce projet. Le fichier `~/.claude/CLAUDE.md` (global)
s'applique aussi (pas de Co-Authored-By, toujours demander en cas de doute, agir en mentor, aller
au point rapidement).

## Quoi, pour qui

Service self-hosted (remplaçant WatchFlower) qui tourne en continu sur un serveur Linux (the production server,
Debian) : scan BLE de capteurs de plantes, historique, scoring de santé par profil d'espèce,
arrosage automatique (Parrot Pot), intégration Home Assistant (MQTT), serveur MCP pour agents IA.
Usage perso, un seul utilisateur admin. Antoine (freelance fullstack, ~3.5 ans d'XP, pas expert
BLE/hardware — expliquer les choix non triviaux).

**Toujours lire `docs/STROYPLANT_SPEC.md` avant toute décision d'architecture** — c'est la source de
vérité complète (stack imposée, roadmap par lots, contraintes Docker/Bluetooth, règles de
collaboration section 10). Pour le protocole BLE du Parrot Pot spécifiquement,
`docs/PARROT_BLE_REVERSE_ENGINEERING.md` et `docs/PARROT_BLE_DEEP_DIVE.md` (décompilation de l'APK
officiel Parrot) priment sur toute déduction depuis des sources tierces (WatchFlower, etc.).

## Règles non négociables

- `pnpm` exclusivement (jamais `npm`/`yarn`), y compris dans les Dockerfile.
- TypeScript/JavaScript partout, pas de Python.
- Ne jamais tester la vraie couche BLE dans le container Docker sur Mac (impossible de toute façon,
  Docker Desktop macOS n'a pas de passthrough Bluetooth) — utiliser `mock` ou `noble-bridge` en dev,
  `node-ble` seulement sur l'the production server (spec section 6).
- Ne jamais avaler une erreur BLE silencieusement (bug WatchFlower identifié et documenté, spec
  section 7.1) — toute opération d'écriture (surtout `trigger_watering`) doit se voir confirmer ou
  échouer explicitement, jamais fire-and-forget.
- En cas de doute technique ou de divergence entre la spec et ce qu'on observe en réel : poser la
  question à Antoine plutôt que de deviner. Précédents concrets où deviner aurait été faux :
  - Le Xiaomi LYWSD03MMC était supposé pvvx (annonce passive en clair) — en réalité firmware stock,
    annonce chiffrée en MiBeacon. Résolu par capture BLE réelle (`btmon`) sur l'the production server, pas supposition.
  - WatchFlower (et donc nous) lit le LYWSD03MMC en connexion GATT, pas en passif comme la spec le
    supposait initialement — trouvé en lisant le vrai code source de WatchFlower, pas deviné.
- Toujours valider empiriquement sur le vrai matériel quand c'est possible plutôt que de supposer un
  format/comportement — l'accès SSH à l'the production server (`ssh the production server`) + Docker permet de scanner/connecter les
  vrais devices sans risque (containers jetables).

## Matériel réel disponible (pour tests empiriques)

Sur l'the production server, adaptateur Bluetooth intégré fonctionnel (Intel Wireless-AC 3168, BT 4.2,
`10:F0:05:0F:40:4B`) — dongle TP-Link UB500 Plus recommandé par la spec pas encore reçu, à
revalider à son arrivée (chipset Realtek différent). Devices détectés à portée de l'the production server :

- 2× Parrot Pot : `A0:14:3D:CD:A3:D3` et `A0:14:3D:CD:A0:73`
- Xiaomi LYWSD03MMC : `A4:C1:38:51:3B:54` (+ au moins 2 autres à proximité, probablement des
  voisins : `A4:C1:38:E1:D1:49`, `A4:C1:38:AA:29:49`)

## État du projet (par lot)

- **Lot 0** ✅ — Docker + Bluetooth validés sur l'the production server réel. Config qui marche : `cap_add: NET_ADMIN,
  NET_RAW` + `network_mode: host` + montage `/var/run/dbus/system_bus_socket` (pas besoin de
  `privileged: true`). BlueZ a dû être installé manuellement (`apt install bluez`, absent par défaut
  sur the production server). Détail complet dans `infra/lot0/CHECKLIST.md`.
- **Lot 1** ✅ — Backend Fastify + Prisma/SQLite, 3 providers BLE interchangeables, scanner +
  connectionQueue séquentielle, API REST + WebSocket. Voir détail stack ci-dessous.
- **Lot 2** ✅ — Auth BetterAuth (credentials, mono-admin, `disableSignUp: true`), toutes les routes
  `/api/*` et le WS protégées par session.
- **Prochain lot** : Lot 3 (frontend Vite + React + TanStack Query/Router + Tailwind + shadcn/ui).
  Un import de design existe déjà : **voir `docs/webdesign_claudecode.md`** — projet claude.ai/design
  avec un design system StroyPlant (tokens couleurs/fonts/spacing) à utiliser comme base, via
  `claude_design` MCP. Utiliser lucide + simple-icons pour les icônes. Le nom correct du projet est
  **StroyPlant** (pas "StoryPlant", erreur présente dans les mockups à corriger).
- **Non fait / reporté** : validation de `node-ble` en conditions réelles sur l'the production server (build Docker +
  déploiement complet) et de `noble-bridge` avec un vrai device à portée du Mac — repoussé
  volontairement à plus tard par Antoine.

## Structure du repo

```text
backend/         API + logique métier (Fastify, Prisma/SQLite, auth, BLE) — tourne en Docker en prod
  src/api/         routes REST + WebSocket
  src/auth/        BetterAuth (instance, session/middleware, seed admin)
  src/ble/         scanner, connectionQueue, logique protocole Parrot (ble/parrot/) et Xiaomi (ble/xiaomi/)
  src/providers/   implémentations DeviceProvider (mock, noble-bridge, node-ble) + factory
  src/db/          client Prisma
  prisma/          schema.prisma + migrations
noble-bridge/    Process natif macOS (hors Docker), expose le Bluetooth du Mac en HTTP/WS —
                 utilisé par le provider `noble-bridge` du backend pour dev sans dongle Linux
infra/lot0/      Scripts/checklist setup Docker+Bluetooth sur l'the production server
docs/            Spec complète, docs rétro-ingénierie BLE Parrot Pot, import design frontend
```

## Backend — détail technique

- **Fastify** (choisi plutôt qu'Express — meilleur support TS natif, plugin WS officiel).
- **Prisma + SQLite**. `DATABASE_URL="file:./dev.db"` dans `.env` — **résolu relatif au dossier de
  `schema.prisma`, pas au cwd** (piège déjà rencontré : `file:./prisma/dev.db` créerait
  `prisma/prisma/dev.db`).
- Modèles métier : `Device` (id = MAC uppercase colon-separated, kind, name, lastSeenAt), `Reading`
  (tous les champs capteurs des deux types de device en optionnel sur une seule table), `WateringEvent`
  (deviceId, triggerSource MANUAL/CRON, success, errorDetail). `plant_profiles`/`schedules` pas encore
  créés (Lot 4/5).
- **`DeviceProvider`** (`src/providers/types.ts`) : interface commune `scan()` / `readSensors(id,
  kind)` / `triggerAction(id, action)`. `kind` est passé par l'appelant car un provider ne peut pas
  toujours déduire le type de device depuis son id seul.
  - `mock` : 2 Parrot Pot simulés (`MOCK-POT-NORMAL` sain, `MOCK-POT-DECLINE` humidité qui baisse +
    réservoir vide dès le départ pour tester l'échec d'arrosage) + 1 Xiaomi (`MOCK-XIAOMI-01`).
  - `noble-bridge` : client HTTP/WS vers le process `noble-bridge/` (natif macOS, `@abandonware/noble`,
    dérivé du PoC `parrot-pot-debug`). **N'expose jamais la vraie MAC** (CoreBluetooth la masque) —
    ids logiques `PARROT-XXXX` (suffixe du nom annoncé) / `XIAOMI-<uuid noble>`. Ne correspondent
    PAS aux ids MAC de `node-ble` — attendu, ce provider valide le protocole, pas la continuité des
    données entre environnements.
  - `node-ble` : BlueZ/D-Bus réel (paquet `node-ble` v1.13+, API vérifiée sur le vrai package, pas
    devinée — `writeValueWithResponse`/`writeValueWithoutResponse`, pas d'`enable()`/`disable()`
    natif sur l'Adapter donc `restartAdapter()` shell-out vers `bluetoothctl power off/on`).
- **Pattern de retry GATT** (`src/ble/parrot/retry.ts`) : 3 tentatives, timeout 18s, backoff 500ms sur
  GATT_ERROR≈133, redémarrage adaptateur à la 2e occurrence consécutive. Détection du "133" par
  heuristique sur les messages d'erreur — **best-effort, BlueZ n'a pas d'équivalent 1:1 du code
  Android/Bluedroid**, à affiner empiriquement sur l'the production server. Sur `noble-bridge`/macOS, CoreBluetooth
  avale le vrai code : tout échec de connexion est traité comme un 133 (pas de redémarrage auto du
  Bluetooth du Mac, ça couperait tout le système — juste un log recommandant une action manuelle).
- **`connectionQueue`** : une seule connexion GATT à la fois, partagée entre Parrot Pot ET Xiaomi
  (les deux nécessitent une connexion — correction de l'hypothèse initiale de la spec qui pensait le
  Xiaomi purement passif).
- **Parrot Pot** : activation obligatoire (write `1` sur `39e1fa06`) avant de lire
  `39e1fa09/0a/0b` (float32 LE, VWC/temp/luminosité déjà calibrés), sinon lectures figées
  silencieusement. Write `0` en fin de session. Trigger arrosage : write `[0x08,0x00]` sur `39e1f906`,
  write-with-response.
- **Xiaomi LYWSD03MMC** : GATT, service `ebe0ccb0-...`, notify sur `ebe0ccc1-...`, payload 5 octets
  `[int16 LE temp/100][uint8 humidity][int16 LE tension mV/1000]`, batterie% = `(tension-2.1)*100`
  clampé 0-100. Formule confirmée par WatchFlower ET revalidée empiriquement sur device réel.
- **API** : `GET /api/devices`, `GET /api/devices/:id/history?hours=N`, `POST
  /api/devices/:id/water` (échec = 502 + détail, jamais silencieux). WebSocket `/ws` pousse chaque
  nouvelle lecture (`{type:'reading', deviceId, kind, reading}`).
- **Auth (BetterAuth)** : `src/auth/auth.ts`. `emailAndPassword` activé mais `disableSignUp: true` —
  pas d'auto-inscription. Plugin `admin` utilisé uniquement pour `auth.api.createUser()` (seul moyen
  documenté de créer un compte sans passer par l'endpoint public de sign-up qui respecte
  `disableSignUp`) — pas de gestion de rôles multi-utilisateurs réelle. `pnpm seed:admin`
  (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) crée l'unique compte. Toutes les routes `/api/devices/*` et `/ws`
  passent par `requireAuth` (401 sans session). Prêt pour l'ajout futur du plugin OIDC (Authentik)
  sans réécriture — pas ajouté maintenant.
- Logging structuré maison (`src/logger.ts`) : timestamp, direction (SCAN/CONNECT/READ/WRITE/...),
  uuid, payload hex, résultat — jamais de log muet sur une opération BLE.

## Outillage

- **Biome** pour lint/format (`pnpm lint` / `pnpm lint:fix` depuis la racine) — 2 espaces, quotes
  simples, pas de tabs (config custom dans `biome.json`, différente du défaut Biome).
- **Git** initialisé à la racine, commits sans Co-Authored-By (règle globale).
- Workspace `pnpm` (`pnpm-workspace.yaml`) : `backend`, `noble-bridge` (frontend à ajouter au Lot 3).

## Gotchas déjà rencontrés (pour ne pas les re-découvrir)

- `DATABASE_URL` Prisma relatif à `prisma/schema.prisma`, pas au cwd (voir plus haut).
- Xiaomi LYWSD03MMC : GATT obligatoire, pas de lecture passive possible sur firmware stock (voir plus
  haut).
- `noble-bridge` (macOS) n'expose jamais la vraie MAC (voir plus haut).
- Heuristique GATT_ERROR=133 sur `node-ble`/BlueZ est du best-effort, à affiner sur l'the production server.
- `BETTER_AUTH_SECRET` tourne sur un fallback dev non sécurisé si absent de `.env` (juste un warning
  au démarrage) — générer une vraie valeur (`openssl rand -base64 32`) avant tout déploiement réel.

## Accès infra

- the production server accessible via `ssh the production server` (clé déjà configurée, user `[user]`). `sudo` y demande un mot de passe
  interactif (pas de NOPASSWD) — pour toute commande nécessitant root sur l'the production server, la demander à
  Antoine plutôt que d'essayer de contourner.
- Docker sur l'the production server ne nécessite pas `sudo` pour l'utilisateur `[user]` — `docker run`/`docker compose`
  fonctionnent directement en SSH pour des tests empiriques (containers jetables recommandés).
