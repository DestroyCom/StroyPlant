# StroyPlant — Spécification projet complète

> Nom du projet : **StroyPlant** (décidé, définitif).
> Ce document est la source de vérité du projet. Il consolide toutes les décisions d'architecture prises en amont. Toute ambiguïté non couverte ici doit être posée en question à l'utilisateur (DestCom), jamais devinée.

---

## 1. Contexte & objectif

Remplacer WatchFlower (app desktop/mobile Qt, non adaptée à un usage serveur 24/7) par un service **self-hosted** tournant en continu sur un serveur the production server (Debian), capable de :

- Scanner en continu des capteurs de plantes en BLE
- Sauvegarder l'historique des lectures
- Évaluer la santé des plantes selon des profils par espèce
- Déclencher l'arrosage automatiquement selon des règles (Parrot Pot)
- S'intégrer à Home Assistant
- Exposer un accès pour agents IA (serveur MCP)

## 2. Périmètre

**Inclus (v1)** :

- Devices P0/P1 listés en section 3
- Dashboard web de suivi
- Arrosage automatique programmable (Parrot Pot uniquement, seul device avec actionneur)
- Auth basique mono-utilisateur
- Intégration Home Assistant (MQTT)
- Serveur MCP pour agents IA

**Explicitement hors scope (v1)** :

- Multi-utilisateur / gestion de rôles complexe (usage perso, un seul compte admin)
- App mobile native (le dashboard web responsive suffit)
- Support Docker Desktop macOS/Windows en production (voir section 5 — limitation confirmée, pas un oubli)
- Système générique "plug n'importe quel capteur BLE" — chaque nouveau type de device nécessite un driver dédié écrit à la main

## 3. Devices supportés (par priorité)

| Priorité | Device                            | Mode BLE                                | Capacités                                       |
| -------- | --------------------------------- | --------------------------------------- | ----------------------------------------------- |
| **P0**   | Parrot Pot                        | Connexion GATT                          | Lecture capteurs + arrosage manuel/auto         |
| **P0**   | Xiaomi LYWSD03MMC (firmware pvvx) | Advertisement passif (pas de connexion) | Température / humidité                          |
| P1       | Flower Power                      | Connexion GATT                          | Lecture capteurs seule                          |
| P1       | Flower Care / Flower Care Max     | Connexion GATT                          | Lecture capteurs + historique interne au device |
| P2       | RoPot, autres                     | —                                       | Reportés après validation du socle              |

Point d'architecture important : les deux P0 fonctionnent en modes BLE fondamentalement différents. Le scan passif Xiaomi peut tourner en fond en permanence sans jamais monopoliser le dongle, pendant que la queue de connexion GATT (Parrot Pot) fait ses cycles ponctuels et séquentiels (BLE ne supporte pas bien plusieurs connexions GATT simultanées sur un dongle USB classique).

## 4. Architecture système (cible production)

```
the production server (Debian 12, dongle BLE USB — TP-Link UB500 Plus, Bluetooth 5.3, chipset Realtek)
 └── Docker (Docker Engine natif Linux)
      ├── backend (Node.js/TypeScript)
      │    - BLE layer (node-ble via BlueZ/D-Bus en prod)
      │    - Auth (BetterAuth)
      │    - Health Engine (profils plantes + scoring)
      │    - Scheduler (cron auto-watering)
      │    - SQLite (via Prisma)
      │    - API REST + WebSocket natif
      │    - Client MQTT (Home Assistant auto-discovery)
      │    - Serveur MCP (tools pour agents IA)
      └── (le frontend est buildé en statique et servi par le backend — pas de container séparé)
```

## 5. Contraintes Docker & Bluetooth — à respecter strictement

- Le container backend a besoin d'accès matériel réel non virtualisable proprement : soit `--privileged`, soit capabilities `NET_ADMIN` + `NET_RAW` + `network_mode: host` + montage de `/var/run/dbus/system_bus_socket`.
- **Fonctionne uniquement sur Docker Engine natif Linux** (the production server, autre Debian/Ubuntu, Raspberry Pi sous Linux). Le dongle recommandé (TP-Link UB500 Plus, chipset Realtek RTL8761B) devrait fonctionner avec n'importe quel dongle reconnu par le kernel Linux — BlueZ absorbe les différences de chipset.
- **Ne fonctionne PAS sur Docker Desktop macOS/Windows.** Confirmé et non négociable : Docker Desktop tourne dans une VM Linux cachée sans passthrough Bluetooth natif fiable. Le seul contournement (USB/IP) est lent, lourd, et non adapté à un usage réel — ne pas essayer de le mettre en place, ce n'est pas l'approche retenue (voir section 6 pour la stratégie de dev sur Mac).
- Sur Coolify (déjà utilisé par ailleurs par DestCom), ces réglages (`privileged`, `network_mode: host`, montages) demanderont une édition manuelle du docker-compose généré, pas un déploiement "standard" via l'UI.

## 6. Stratégie de développement — 3 providers BLE interchangeables

DestCom développe sur un **MacBook Air M3 (macOS)**, mais la cible de production est **Linux (the production server)**. Docker ne permettant pas de BLE réel sur macOS (section 5), il ne faut **jamais développer/tester la vraie couche BLE directement dans le container en local sur Mac**. Utiliser une interface abstraite `DeviceProvider`, avec trois implémentations interchangeables via une variable d'environnement `BLE_PROVIDER` :

| Provider       | Où il tourne                                                                                                      | Lib utilisée                         | Ce qu'il valide                                                           |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `mock`         | Dans le container, dev Mac                                                                                        | Aucune (données simulées)            | Logique métier pure : Health Engine, cron, API, frontend, auth            |
| `noble-bridge` | Un petit process Node **natif macOS** (hors Docker) exposant une API HTTP locale, appelé par le backend dockerisé | `@abandonware/noble` (CoreBluetooth) | Vrai protocole BLE contre le vrai hardware — mais pas le vrai stack Linux |
| `node-ble`     | Directement dans le container, sur l'the production server uniquement                                                               | `node-ble` (BlueZ/D-Bus)             | Le vrai stack de production — validation finale incompressible            |

Notes :

- Le `mock` doit permettre de simuler des scénarios utiles (ex : humidité qui descend progressivement pour tester qu'une alerte se déclenche, un trigger d'arrosage qui échoue pour tester la gestion d'erreur), pas juste des valeurs aléatoires plates.
- Le `noble-bridge` peut réutiliser telle quelle la logique du PoC CLI `parrotpot-poc/` déjà développé (voir section 9) — mêmes UUIDs, mêmes commandes de lecture/écriture, juste exposées via une petite API HTTP au lieu d'un CLI.
- Le passage du `mock`/`noble-bridge` au vrai `node-ble` ne doit **jamais** être considéré comme acquis simplement parce que les deux autres passent — ce sont des libs différentes (noble vs node-ble), donc le comportement (timing, gestion d'erreurs GATT, format des events) doit être revalidé sur l'the production server avec la checklist de la section 9.
- **Avant de commencer le Lot 0 (voir section 11)**, demander à DestCom s'il souhaite que ce lot (et la validation finale du provider `node-ble`) soit fait en travaillant en direct sur l'the production server via connexion SSH (accès bash réel à la machine cible, itération autonome possible), plutôt qu'en local sur son Mac avec des allers-retours manuels de test. Ne pas supposer la réponse.

## 7. Modules fonctionnels détaillés

### 7.1 BLE Layer

- Scanner continu (discovery), avec throttling pour ne pas saturer le dongle
- Queue de connexion séquentielle pour le Parrot Pot (une seule connexion GATT à la fois)
- Un driver par device, derrière l'interface `DeviceProvider` commune : `scan()`, `readSensors()`, `triggerAction()`
- Logging exhaustif de toute opération BLE (timestamp, direction, UUID, payload hex, résultat détaillé) — **ne jamais avaler une erreur silencieusement**, contrairement à WatchFlower qui a un write d'arrosage "fire-and-forget" sans vérification (bug identifié et documenté lors du debug initial du Parrot Pot)
- Pour le mapping des codes d'erreur GATT en messages lisibles dans les logs, voir le tableau de référence dans `PARROT_BLE_DEEP_DIVE.md` section 5 (ce sont des codes standards Bluetooth/Bluedroid, pas spécifiques au Parrot Pot — noble/node-ble les exposent nativement, pas besoin de les redéfinir)
- **Pattern de résilience confirmé par l'app officielle (à répliquer dans le Lot 1)**, issu de l'investigation PoC sur le code décompilé :
  - Retry de connexion GATT : jusqu'à 3 tentatives, timeout 15-20s par tentative
  - Sur erreur `GATT_ERROR` (code 133, très fréquente) : backoff fixe de 500ms avant retry ; si l'erreur survient une 2e fois consécutive, redémarrer l'adaptateur Bluetooth lui-même (`disable()` puis `enable()`, avec attente jusqu'à 60s) plutôt que de continuer à réessayer sur un adaptateur probablement dans un mauvais état
  - Scan en cycle continu (pas une seule tentative) : ~10s de scan puis pause (1 min en usage normal, 10s en mode "agressif"), filtré par UUID de service annoncé + RSSI minimum (`-90`) ; un device "vu" reste considéré valide pendant 3 cycles avant d'être déclaré perdu
  - Pas de reconnexion silencieuse en cours de tâche : une déconnexion pendant une opération remonte directement en erreur (cohérent avec notre principe de ne jamais avaler une erreur silencieusement)

**Nuance importante entre PoC (macOS/noble) et production (Linux/node-ble)** : le PoC a rencontré une limite spécifique à `@abandonware/noble` sur macOS — le binding natif CoreBluetooth n'expose pas le code d'erreur réel (`NSError` avalé), rendant impossible de distinguer un GATT 133 d'un autre échec, et un redémarrage propre de l'adaptateur Bluetooth macOS n'est pas simple (impacterait tout le Bluetooth du Mac, pas juste le device ciblé) — d'où un compromis pragmatique dans le PoC (tout échec traité comme équivalent, log recommandant une action manuelle plutôt qu'un restart automatisé). **Cette limite est propre à noble/macOS, pas à node-ble/BlueZ** : sur l'the production server en production, `node-ble` parle à BlueZ via D-Bus, qui expose les vrais codes de statut GATT — le pattern complet de l'app officielle (détection précise du 133, backoff 500ms, restart adapter automatique au 2e échec) doit être implémenté intégralement pour le Lot 1, ne pas reprendre la limitation du PoC comme une contrainte de production.

### 7.2 Persistence (SQLite + Prisma)

Tables a minima :

- `devices` (id, mac/identifiant, type, nom, dernière connexion)
- `readings` (device_id, timestamp, soil_moisture, conductivity, temp, luminosity, water_level, ...)
- `watering_events` (device_id, timestamp, trigger_source: manual|cron, success bool, détail erreur si échec)
- `schedules` (device_id, seuils, horaires_autorisés, actif bool)
- `plant_profiles` (importés du CSV — voir 7.3)

### 7.3 Health Engine

- **Import du fichier `assets/plants/watchflower_plantdb.csv`** du repo `emericg/WatchFlower` (3404 profils de plantes). Colonnes utiles : Soil moisture MIN/MAX (%), Soil conductivity MIN/MAX, Soil PH MIN/MAX, Temperature MIN/MAX (°C), Humidity MIN/MAX (%RH), Light MIN/MAX (lux et mmol).
- Attention : certaines valeurs sont à `0;0` — traiter comme "non applicable", pas comme un vrai zéro littéral. Vérifier au cas par cas pendant le parsing.
- Scoring de santé par comparaison des lectures (idéalement moyenne glissante, pas l'instantané seul) aux plages du profil — statut par paramètre (`ok` / `trop bas` / `trop haut`) + statut global
- Détection de tendance (dégradation sur plusieurs jours), pas seulement l'état instantané
- Exclure des calculs de baseline/scoring toute lecture où `STATUS_FLAGS.isInAir = 1` (section 7.11 / 8) — une sonde hors sol ne représente pas un état de plante, ne pas la laisser polluer les moyennes
- Ce module alimente : le dashboard, le scheduler (7.4), et le serveur MCP (7.8)

**Baseline glissante par device — mécanisme principal, pas un bonus (contrainte de contexte importante)** :

Au lancement en prod, les pots seront déjà en terre avec des plantes existantes — **pas de fenêtre de calibration contrôlée disponible pour la quasi-totalité des devices** (impossible de tester "sonde à l'air" / "terreau sec" / "terreau saturé" sans déranger une plante déjà installée). Le système doit donc être capable de démarrer à l'aveugle et construire sa propre référence personnalisée progressivement, plutôt que de dépendre d'une calibration initiale :

- Calculer des statistiques glissantes (min/max/moyenne/écart-type) par device et par métrique (VWC, température, conductivité, luminosité) sur une fenêtre configurable (ex. 7/14/30 jours)
- **Période de "rodage" (warm-up)** : pour un device nouvellement vu, réduire la confiance des alertes de santé (ou les suspendre complètement) tant qu'une baseline personnelle suffisante n'a pas été accumulée (ex. quelques jours minimum de données) — évite les faux positifs dès le jour 1 basés uniquement sur une plage générique d'espèce qui peut ne pas correspondre exactement à ce capteur/pot réel
- **Combinaison des deux sources** : les plages par espèce (CSV, absolues, génériques) servent de garde-fou grossier (détecter une valeur totalement aberrante) ; la baseline glissante par device (relative, personnalisée) affine le scoring réel au fil du temps, une fois suffisamment de données accumulées
- Une dérive de la baseline glissante elle-même (ex. la moyenne se déplace progressivement sans événement d'arrosage ou saisonnier qui l'explique) est un signal à part entière — peut indiquer un problème de capteur (encrassement, calcification) plutôt qu'un problème de plante, à distinguer dans le dashboard

**Calibration 3 points (service Plant Dr, `DRY_N`/`DRY_VWC`/`WET_N`/`WET_VWC`) — option secondaire, pas un prérequis d'onboarding** :

Reste disponible et utile pour les **nouveaux devices ajoutés après le lancement** (pot pas encore planté, donc calibration réaliste), ou si DestCom choisit volontairement de recalibrer un pot existant en le vidant temporairement. Ne pas la bloquer/exiger à l'ajout d'un device — proposer comme action optionnelle dans le dashboard, la baseline glissante prenant le relais par défaut pour tous les devices qui ne passeront jamais par cette étape.

### 7.4 Scheduler / auto-watering

- Cron interne (ex. toutes les X minutes), lit les devices avec `schedules.actif = true`
- Logique : si le Health Engine indique un manque d'eau ET dans une plage horaire autorisée ET pas déjà arrosé dans les dernières N heures (anti-spam pompe) → déclenche l'arrosage
- Log systématique de chaque tentative, succès ou échec explicite

### 7.5 API Backend

- `GET /devices` — liste + dernier état
- `GET /devices/:id/history` — séries temporelles pour graphs
- `POST /devices/:id/water` — trigger manuel
- `PUT /devices/:id/schedule` — configurer seuils/horaires
- WebSocket natif (lib `ws`, pas socket.io) pour push temps réel des nouvelles lectures

### 7.6 Auth

- **BetterAuth** (déjà utilisé par DestCom sur d'autres projets, ne pas réinventer une auth custom)
- Démarrer en credentials (email/password), un seul compte admin
- Concevoir dès maintenant pour un ajout futur du plugin OIDC natif de BetterAuth, sans réécriture — la cible future est un IdP self-hosted type **Authentik** (LDAP outpost + OIDC provider en un seul endroit), pas Keycloak (trop lourd pour cet usage)
- Le serveur MCP (7.8) doit être protégé par cette même couche d'auth, ou au minimum restreint au réseau local — jamais exposé sans protection puisqu'il expose une action réelle (`trigger_watering`)

### 7.7 Intégration Home Assistant

- **MQTT + auto-discovery** (pas de custom component HACS en Python — cohérent avec le refus de mélanger Python dans une stack 100% TS)
- Le backend publie les capteurs sur un topic MQTT au format de discovery HA ; Home Assistant les détecte automatiquement sans code custom côté HA

### 7.8 Serveur MCP

- Tools à exposer : `list_devices()`, `get_plant_status(device_id)`, `get_plant_history(device_id, range)`, `trigger_watering(device_id)`
- Réutilise directement le Health Engine (l'agent IA consomme le score déjà calculé, ne réinvente pas la logique de seuils)
- Protégé par la couche Auth (7.6)

### 7.9 Frontend

- **Vite + React + TypeScript**, PAS Next.js (aucun besoin de SSR/SEO pour un dashboard interne, éviter la lourdeur d'un framework fullstack alors que le backend existe déjà séparément — voir raisonnement détaillé section 12)
- **TanStack Query** pour le data fetching/cache (intégration avec le WebSocket temps réel via `queryClient.setQueryData`)
- **TanStack Router** (pas React Router) — cohérence d'écosystème avec Query, loaders qui préchargent dans le cache Query, typage complet des routes/params. Important : TanStack Router seul n'implique PAS TanStack Start (le framework fullstack) — on reste sur un simple SPA statique, aucun serveur SSR.
- Tailwind CSS + shadcn/ui
- WebSocket natif côté client (pas de lib socket.io)
- Le build (`dist/`) est servi statiquement directement par le backend Node — pas de container nginx/Caddy séparé, un process de moins à faire tourner sur l'the production server
- Dockerfile multi-stage : étape Node qui build le Vite, copiée dans l'image finale du backend

### 7.10 Historique Parrot Pot — décision finale : fallback sur polling live uniquement

**Décision définitive, plus une question ouverte.** Le service History/Upload (`39e1FC00`/`39e1FB00`) **n'est pas utilisé**. Justification :

- Le format binaire des échantillons n'est jamais désérialisé côté app officielle (relayé brut en base64 au cloud Parrot pour décodage serveur) — non déductible par rétro-ingénierie statique.
- Une hypothèse plausible (header 16 octets + 274 entrées de 22 octets `[uint16][float32×5]`, cohérente avec les 5 characteristics brutes `39e1fa01-05`) a été testée empiriquement sur device réel et **invalidée** : les floats décodés sont des dénormales/exposants sans aucun sens physique.
- Conformément au principe de time-boxing, une seule vérification a été tentée, pas de nouvelle hypothèse à explorer.

**Conséquence pour l'architecture** : les séries temporelles du Parrot Pot sont reconstituées uniquement via le polling live (`39e1fa09/0a/0b`, déjà couvert par le Lot 1) et stockées au fil de l'eau dans `readings`. Pas de colonne `source` nécessaire (plus de distinction `live`/`history_import` puisqu'il n'y a qu'une seule source). Pas de synchronisation Clock nécessaire pour ce besoin (son statut global est déprioritisé, voir section 8). **Ce lot est retiré de la roadmap (voir section 11) — son besoin est déjà couvert par le Lot 1, aucun travail dédié supplémentaire.**

### 7.11 Intégration Plant Dr (calibration device-side)

Le service **Plant Dr** (`39e1FD80`) permet de configurer un algorithme de calibration "sec"/"humide" **directement sur le device**. Une fois son `ALGORITHM_STATUS` activé, le Parrot Pot peut décider et agir de façon autonome — y compris si notre backend est hors ligne ou hors de portée BLE.

**Décision confirmée (les deux coexistent, ce n'est plus une question ouverte)** :

- **Scheduler backend (Lot 5)** : le Health Engine (profils d'espèces du CSV, scoring, tendances) reste la décision **principale**, déclenche l'arrosage à distance à chaque cycle cron.
- **Plant Dr (device-side)** : configuré en **filet de sécurité complémentaire**, actif en parallèle — le pot continue à s'auto-arroser a minima selon sa propre calibration si le backend tombe ou perd la connectivité BLE. Ne remplace pas le Scheduler, s'ajoute à lui.

**Détails d'implémentation critiques (issus de `PARROT_BLE_DEEP_DIVE.md`, à respecter strictement — une erreur ici fait rejeter la config silencieusement par le firmware)** :

- **Écrire la config watering n'est PAS un simple write-only** : c'est un pattern **read-modify-write**. Lire d'abord l'état actuel de toutes les characteristics du service Watering, ne modifier que les champs concernés, puis réécrire dans cet ordre exact : `PLANT_ID` (39e1F902) → `VWC_IRR` (39e1F903) → `VWC_CMD` (39e1F904) → `N_IRR` (39e1F905) → `VWC_IRR_ECO` (39e1F90A) → `VWC_CMD_ECO` (39e1F90B) → `N_IRR_ECO` (39e1F90C) → `TIME_SLOT_START` (39e1F90E) → `TIME_SLOT_DURATION` (39e1F90F) → `VACATION_START` (39e1F910) → `VACATION_END` (39e1F911) → `MODE` (39e1F90D) → **`CONFIG_ID` (39e1F901) en dernier**.
- **`CONFIG_ID` est un checksum XOR de validation**, pas un simple identifiant : XOR de tous les champs de la config (chacun tronqué en int16, les deux timestamps 32 bits découpés en moitié basse/haute). Le firmware compare probablement cette valeur pour valider/committer la config — l'écrire faux ou l'omettre risque de faire rejeter silencieusement toute la config. Formule exacte dans `PARROT_BLE_DEEP_DIVE.md` section 2.
- Même logique pour **Plant Dr** : `DRY_N` (39e1FD82) → `DRY_VWC` (39e1FD83) → `WET_N` (39e1FD84) → `WET_VWC` (39e1FD85) → `CONFIG_ID` (39e1FD81, checksum XOR des 4 valeurs précédentes, en dernier).
- **`ALGORITHM_STATUS` (39e1F912) reste flou pour les valeurs autres que 0** : seule la valeur `0` (réinitialisation après maintenance) est confirmée dans le code observé. Les valeurs 1 à 6 sont acceptées par la validation côté app mais leur signification exacte (probablement un enable/disable ou un mode) n'est pas confirmée — **ne pas supposer qu'une valeur précise "active" l'algorithme sans validation empirique sur le vrai device avant d'implémenter ce comportement en prod.**

**Bonus exploitable directement — `STATUS_FLAGS` (`39e1FD86`) entièrement décodé** : un octet unique en notification, 4 bits significatifs :

| Bit | Masque | Signification                                   |
| --- | ------ | ----------------------------------------------- |
| 0   | `0x01` | Sol détecté sec                                 |
| 1   | `0x02` | Sol détecté humide/saturé                       |
| 2   | `0x04` | Réservoir d'eau vide ("réservoir bas")          |
| 3   | `0x08` | Capteur hors sol (sonde mal plantée ou retirée) |

Ces flags ne sont pas mutuellement exclusifs (sol ni sec ni humide = état normal). À faire remonter directement dans le dashboard et/ou le Health Engine comme complément au scoring par seuils — c'est une info déjà calculée par le firmware, pas la peine de la recalculer.

## 8. Référence BLE — Parrot Pot

**Source de vérité prioritaire : `PARROT_BLE_REVERSE_ENGINEERING.md`** (à la racine du projet), issu d'une
décompilation directe de l'APK officiel Parrot Flower Power v4.6.2 (code Java non obfusqué). Ce document
prime sur toute déduction faite depuis WatchFlower en cas de divergence — c'est la source la plus fiable
disponible, puisqu'elle vient du code source de l'éditeur original, pas d'une réimplémentation tierce.
**Le consulter systématiquement avant d'implémenter quoi que ce soit touchant au protocole BLE du Parrot
Pot.**

Base UUID custom Parrot : `39e1xxxx-84a8-11e2-afba-0002a5d5c51b`.

**Correction importante (issue de `PARROT_BLE_DEEP_DIVE.md`) — characteristics de capteurs à utiliser réellement** :
L'app officielle **n'utilise PAS** `39e1fa01` à `39e1fa05` en mode live (ce sont des characteristics vestigiales, jamais souscrites par l'app pour le Parrot Pot). Elle utilise à la place :

| UUID       | Rôle                     | Format                                                                     |
| ---------- | ------------------------ | -------------------------------------------------------------------------- |
| `39e1fa09` | VWC (humidité du sol, %) | **float32 little-endian**, déjà calibré par le firmware                    |
| `39e1fa0a` | Température (°C)         | float32 LE, déjà calibré                                                   |
| `39e1fa0b` | Luminosité               | float32 LE, déjà calibré (unité exacte non confirmée : lux ou mol/m²/jour) |

**Aucune formule de conversion n'est nécessaire** — lire directement un float32 LE sur ces trois characteristics donne la valeur physique finale. Ne pas utiliser les characteristics `39e1fa01-05` ni les formules approximatives de WatchFlower pour le Parrot Pot : cette voie est plus fiable, confirmée par le code source officiel.

**⚠️ Prérequis d'activation obligatoire, confirmé empiriquement sur device réel (sinon lectures figées silencieusement)** : avant de lire/souscrire à `39e1fa09/0a/0b`, **écrire `1` (uint8) sur `39e1fa06` (`UUID_LIVE_MEASURE_PERIOD`)** pour activer l'échantillonnage actif du firmware. Sans ce write, le firmware ne rafraîchit pas ses valeurs en continu — un `read()` renvoie la dernière valeur en mémoire, potentiellement figée depuis très longtemps (observé : 20+ minutes sans le moindre changement, sans aucune erreur associée — bug silencieux classique si ce détail est manqué). **Écrire `0` sur la même characteristic en fin de session/déconnexion** (stop live), probablement pour économiser la batterie quand aucun client n'écoute. Nuance : le firmware échantillonne à son propre rythme interne (de l'ordre de quelques secondes) — deux lectures rapprochées peuvent légitimement retomber sur le même échantillon brut, ce n'est pas un bug.

**Points confirmés avec un niveau de confiance élevé (lecture directe de code, pas de déduction)** :

| Point                         | Confirmation                                                                                                                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Trigger d'arrosage manuel     | Service `39e1F900`, characteristic `39e1F906` (`UUID_WATERING_CMD`), payload `[0x08, 0x00]` = uint16 little-endian valant `8`                                                                                                        |
| Type d'écriture               | `WRITE_TYPE_DEFAULT` — **write with response** (tranche l'ambiguïté précédente)                                                                                                                                                      |
| Watering mode (`39e1F90D`)    | Write uint8 — `0 = off`, `1 = auto`                                                                                                                                                                                                  |
| Algorithm status (`39e1F912`) | Write uint8 — active/désactive l'algorithme d'auto-irrigation (à ne pas confondre avec un simple "statut" — c'est un toggle de fonctionnement)                                                                                       |
| Identification du device      | Un Parrot Pot annonce le service `HAWAII_WATER_DEVICE` (`39e1F900`) en advertisement BLE ; un simple capteur Flower Power annonce `HAWAII_SENSOR` (`39e1FA00`) — utiliser ce filtre pour distinguer les deux types de device au scan |

**Services découverts, statut à jour** :

- **Service History (`39e1FC00`) + Upload (`39e1FB00`)** : **investigué et écarté définitivement** — voir section 7.10 pour la décision finale (fallback sur polling live). Ne pas ré-explorer cette piste.
- **Service Plant Dr (`39e1FD80`)** : algorithme de calibration avancé (points "sec"/"humide") pour l'auto-irrigation — **retenu**, en complément du Health Engine (voir section 7.11, Lot 6).
- **Service Clock (`39e1FD00`)** : synchronisation UTC — son seul usage identifié (cohérence des timestamps de l'historique interne) n'est plus pertinent puisque le service History est écarté. Pas de besoin confirmé ailleurs pour l'instant (Plant Dr n'en dépend pas d'après l'analyse actuelle) — **déprioritisé, à implémenter seulement si un besoin concret émerge en cours de route**, pas par anticipation.
- **Service Device Config (`39e1FE00`)** : renommage du device, capacité du réservoir configurable, flag "disponible" — utilitaire, pas rattaché à un lot précis, à considérer comme un bonus si le temps le permet.

**Mécanisme LED historique (fallback, non confirmé par la décompilation)** : handle brut `0xaa` — potentiellement obsolète ou propre à une version différente du firmware. Le rapport de décompilation mentionne `39e1fa07` (`UUID_LIVE_LED_STATE`) avec un niveau de confiance "probable" seulement — à tester en priorité sur celui-ci plutôt que sur le handle brut.

- Battery : `00002a19-0000-1000-8000-00805f9b34fb`
- Device name (service standard) : `00002a00-0000-1000-8000-00805f9b34fb`

**Contrainte de timing critique (documentée dans le protocole Parrot)** : le pot peut couper la connexion BLE après environ 1 seconde sans requête entrante. Toute opération d'écriture doit être mesurée en temps écoulé depuis la connexion, et idéalement effectuée le plus tôt possible après connexion.

**Limite à garder en tête** : cette analyse est **statique** (décompilation, pas de capture BLE réelle) — le niveau de confiance porte sur ce que fait l'app officielle, pas sur ce qu'accepte réellement le firmware pour des valeurs différentes de celles utilisées par l'app. Une validation empirique sur le vrai device (via le PoC `parrotpot-poc/`) reste nécessaire avant intégration en prod, en particulier pour toute valeur de payload différente de celle observée dans le code.

**Note mécanique (hors BLE, contexte utile)** : sur un Parrot Pot dont le circuit hydraulique est resté sec (neuf ou d'occasion), la pompe centrifuge ne peut pas s'auto-amorcer — il faut amorcer manuellement le tuyau (type siphon) une première fois. Ce n'est pas un bug logiciel ni un souci BLE, c'est un phénomène mécanique connu des pompes non auto-amorçantes. Ne pas re-déboguer cette piste si un utilisateur rapporte un arrosage qui ne fait rien après une longue période sans eau — rediriger vers la vérification de l'amorçage avant de creuser le protocole BLE.

## 9. Sources de référence — à consulter systématiquement

**Pour tout ce qui touche au protocole BLE du Parrot Pot spécifiquement, `PARROT_BLE_REVERSE_ENGINEERING.md` et `PARROT_BLE_DEEP_DIVE.md` (section 8) sont la source n°1** — décompilation directe du code officiel Parrot, plus fiable que les repos tiers ci-dessous en cas de divergence. Le second fichier corrige/affine plusieurs points du premier (voir section 8) : ne pas se fier uniquement au premier document si le second le contredit.

**Ces trois repos restent la source de vérité secondaire du projet (utiles pour tout le reste : autres devices, structure d'implémentation, patterns de code). Toujours les consulter (les cloner localement si besoin) avant de deviner un comportement, un format de payload, ou un UUID manquant :**

- `https://github.com/emericg/WatchFlower` — implémentation C++/Qt la plus complète ; driver Parrot Pot dans `src/devices/device_parrotpot.cpp`, doc BLE dans `docs/parrotpot-ble-api.md`, base de données de plantes dans `assets/plants/watchflower_plantdb.csv`. **Licence GPLv3** : usage privé self-hosted sans souci, mais attribution nécessaire si le projet est un jour rendu public.
- `https://github.com/mbrentini/homeassistant_parrotflowerpower` — implémentation Python (lecture de capteurs Flower Power via handles ATT bruts, pas de watering)
- `https://github.com/MarkoMarjamaa/homeassistant-flowerpower` — implémentation Python via `bluepy` (lecture de capteurs Flower Power via UUID, pas de watering)

**PoC déjà réalisé, réutilisable comme base** : un CLI Node.js/TypeScript (`parrotpot-poc/`) utilisant `@abandonware/noble` a déjà été spécifié/développé pour tester unitairement le Parrot Pot depuis macOS (scan, lecture capteurs, LED, trigger d'arrosage avec logging exhaustif). Son code est la base naturelle du provider `noble-bridge` (section 6).

## 10. Règles de collaboration

- **En cas de doute technique ou de choix d'implémentation ambigu, poser la question à DestCom directement plutôt que de choisir arbitrairement et continuer.** Il préfère être interrompu pour clarifier que découvrir plus tard une hypothèse fausse silencieusement intégrée au code.
- Avant le Lot 0, demander explicitement s'il veut travailler en SSH direct sur l'the production server pour ce lot (voir section 6, dernier point) — ne pas supposer.
- Stack imposée : TypeScript/JavaScript partout, pas de Python, cohérence avec l'écosystème existant de DestCom (Next.js habituel pour d'autres projets, Prisma, shadcn/ui, BetterAuth, Docker/Coolify/Hetzner/Cloudflare).
- **Gestionnaire de paquets : `pnpm` exclusivement, jamais `npm` ni `yarn`** — que ce soit pour le backend, le frontend, ou tout script/outil annexe du projet (y compris les Dockerfile : utiliser `pnpm install`, pas `npm install`).
- DestCom est freelance fullstack, ~3.5 ans d'expérience, à l'aise techniquement mais pas expert BLE/hardware bas niveau — expliquer les choix non triviaux plutôt que les appliquer sans contexte.

## 11. Découpage en lots (roadmap)

| Lot       | Contenu                                                                                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lot 0** | Setup Docker + Bluetooth fonctionnel sur the production server (dongle TP-Link UB500 Plus). **Demander d'abord si travail en SSH direct souhaité (section 6).**                                                                                                                                |
| **Lot 1** | Scanner Xiaomi (passif) + Driver Parrot Pot (GATT), avec les 3 providers BLE interchangeables (`mock`, `noble-bridge`, `node-ble`) + SQLite/Prisma + API minimale — inclut le prérequis d'activation `39e1fa06` (section 8) et le pattern de retry/reconnexion (section 7.1) |
| **Lot 2** | Auth (BetterAuth, credentials only, hooks OIDC prêts)                                                                                                                                                                                                                        |
| **Lot 3** | Frontend Vite + React + TanStack Query/Router + Tailwind + shadcn/ui (protégé par l'auth du Lot 2)                                                                                                                                                                           |
| **Lot 4** | Import CSV plant DB + Health Engine (scoring, profils, tendances)                                                                                                                                                                                                            |
| **Lot 5** | Scheduler auto-watering (branché sur le Health Engine)                                                                                                                                                                                                                       |
| **Lot 6** | Intégration Plant Dr (calibration device-side sec/humide), en complément du Health Engine — les deux coexistent, voir section 7.11                                                                                                                                           |
| **Lot 7** | Client MQTT + auto-discovery Home Assistant                                                                                                                                                                                                                                  |
| **Lot 8** | Serveur MCP (tools listés en 7.8), protégé par l'auth                                                                                                                                                                                                                        |
| **Lot 9** | Extension aux autres devices (Flower Power, Flower Care)                                                                                                                                                                                                                     |

_(Ancien "Lot 2" historique retiré : décision finale en section 7.10 — fallback sur polling live uniquement, déjà couvert par le Lot 1, aucun développement dédié nécessaire.)_

Chaque lot doit être validé avant de passer au suivant. Ne pas enchaîner plusieurs lots sans confirmation explicite de DestCom que le précédent fonctionne comme attendu.

## 12. Pourquoi pas Next.js / pas TanStack Start (contexte des décisions, pour éviter de revenir dessus)

- **Next.js écarté** : aucun besoin de SSR/SEO (dashboard interne, pas de visiteurs anonymes), le backend existe déjà séparément donc les API routes de Next seraient redondantes, et un process SSR persistant est une charge inutile face à un simple build statique Vite.
- **TanStack Start (le framework fullstack) écarté pour la même raison que Next** — malgré l'usage de TanStack Query et TanStack Router, qui sont des libs indépendantes de Start et n'impliquent aucune obligation d'y passer. Start est actuellement en Release Candidate (pas encore 1.0 stable au moment de la rédaction), ajoutant un risque de maturité non nécessaire pour un outil homelab qui doit rester stable et low-maintenance.
- **React Router écarté au profit de TanStack Router** : cohérence d'écosystème avec Query, loaders intégrés, typage complet des routes — sans que cela implique Start (voir ci-dessus).

## 13. Limites de portabilité à ne jamais présenter comme résolues

- Le projet fonctionnera sur **n'importe quel hôte Linux avec Docker Engine natif** et, très probablement, **n'importe quel dongle Bluetooth reconnu par le kernel Linux** (pas seulement le TP-Link UB500 Plus recommandé) — BlueZ absorbe les différences de chipset.
- Le projet **ne fonctionnera pas** sur Docker Desktop macOS/Windows (limitation confirmée et durable, pas un détail à corriger).
- Le projet ne supporte **que les types de devices pour lesquels un driver a été écrit** — ce n'est pas un système générique "n'importe quel capteur BLE".
- Ne jamais présenter le projet comme "universel" ou "prêt à l'emploi sur n'importe quel appareil" dans la documentation utilisateur — être explicite sur ces limites dans le README.

## 14. Hébergement & reverse proxy (the reverse proxy)

DestCom utilise déjà **the reverse proxy** (reverse proxy nginx) sur son the production server pour d'autres services. Objectif : **un seul container, un seul nom de domaine, un seul deploy** — pas deux containers front/back séparés, pas deux sous-domaines.

- Le backend Node (Express/Fastify) sert **tout** depuis un seul process/port :
  - `/api/*` → routes API REST
  - le chemin WebSocket (ex. `/ws`) → upgrade temps réel
  - tout le reste → fichiers statiques du build Vite (`dist/`), avec un **fallback SPA obligatoire** : toute route qui n'est ni `/api/*` ni un asset statique existant doit renvoyer `index.html`, pour que TanStack Router gère le routing côté client sans 404 au refresh sur une route type `/devices/123`.
- Côté the reverse proxy : un seul sous-domaine, un seul `proxy_pass` vers `container:port` — aucune règle de routing `/api` à gérer au niveau nginx, toute la logique de dispatch reste dans le code Node.
- **Point de vigilance** : vérifier explicitement que la conf the reverse proxy générée pour ce site transmet bien les headers d'upgrade WebSocket (`Connection: upgrade`, `Upgrade: websocket`) — sans ça le WS semble se connecter puis tombe silencieusement. Ne pas supposer que c'est le cas par défaut, vérifier le fichier de conf réellement utilisé.
- Un seul `docker-compose` service pour toute l'appli (le Dockerfile multi-stage de la section 7.9 produit une image unique front+back).
