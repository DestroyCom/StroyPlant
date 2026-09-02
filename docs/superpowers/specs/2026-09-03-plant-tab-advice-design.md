# Onglet "Plante" + conseils — design

**Sous-projet 3** de `docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md`. Brainstorming fait
le 2026-09-03, après un spike (lecture seule, pas de code) sur la décompilation Android de l'app
officielle Flower Power (`/Users/destcom/Documents/PERSO/parrot-pot-debug/analyse/decoded_jadx/`).

## Contexte

Demande de DestCom : un nouvel onglet sur la page détail d'un pot (`/devices/$deviceId`) montrant
les détails de l'espèce assignée (sous-projet 1, "Base de plantes", déjà livré) **et** les
"conseils" que l'app officielle affichait — captures
`docs/flowerpower_screenshot/20260830/image-1787968{205560,217772,223780,226943}.webp` : 4 icônes
(goutte=humidité du sol, bidon=engrais, thermomètre=température, soleil=lumière), chacune avec un
texte d'explication et parfois une valeur live ("2.1L sur 2.2L", "61%").

Ces "conseils" ne sont **pas** le même contenu que `PlantProfileTranslation.detailCare`/etc. du
sous-projet 1 (texte horticole générique par espèce) — ce sont des textes d'interface qui
expliquent un **état du système** (seuil de déclenchement, période de calibration, statut
too_low/ok/too_high).

## Ce que le spike a trouvé

Dans `resources/res/values-fr/strings.xml` de l'APK décompilée :

- **4 catégories, un jeu de clés cohérent chacune** : `water_*` (too_low/too_high/good — pas de
  variante par saison ni par environnement, toujours `_all_seasons_all_environments`, sauf
  `too_much_water` qui a une variante `_potted` vs `_soil`), `temperature_*` et `light_*`
  (too_low/good/too_high avec des variantes indoor/outdoor/saison de croissance, plus un état
  d'attente `*_soon_available`), `fertilizer_*` (too_low/good/too_high, plus deux cas spéciaux :
  `not_measurable` pour les épiphytes/orchidées où l'humidité ne peut pas être mesurée fiablement,
  et `not_available` en attente d'une analyse plus longue — **sans** variante d'attente chronométrée).
- **États "en attente"** : `*_soon_available` (température, lumière) ont une variante chronométrée
  (`*_soon_available_timed`, "Conseil disponible dans {time}") — l'engrais n'en a pas, uniquement le
  texte générique `fertilizer_not_available_status`.
- **États "pas de plante"** : `*_no_plant_title`/`_text` existent pour température/lumière/engrais
  **uniquement** — l'humidité du sol n'en a pas (seuil fixe, pas de comparaison par espèce).
- Le mapping code→texte vit dans `com/parrot/flowerpower/android/Utilities/Utility.java`
  (`analyzeWater` et les blocs équivalents température/lumière/engrais), sous forme d'un switch sur
  deux enums (`com/parrot/flowerpower/android/entities/`) : `StatusKey` (status_ok/status_critical/
  status_warning/waiting_data/action_done/predicted_action) × `InstructionKey`
  (soil_moisture_too_low/good/too_high, air_temperature_too_low/good/too_high/soon_available/
  no_plant, light_*, fertilizer_too_low/good/too_high/unavailable/not_measurable/no_plant).
- **Point crucial** : `LocationState.setStatusKey(String)`/`setInstructionKey(String)` parsent une
  chaîne reçue du réseau (`StatusKey.valueOf(value)`) — ces états sont **calculés côté cloud
  Parrot**, probablement hors service aujourd'hui, **pas** par une logique locale dans l'app
  décompilée. Il n'y a donc aucun seuil/durée d'algorithme officiel à extraire au-delà de ce catalogue
  de textes et de ce vocabulaire d'états. Ce sous-projet consiste à **mapper nos propres statuts déjà
  calculés** (Health Engine : `ok`/`too_low`/`too_high`/`warming_up`/`calibrating`/`no_profile`, voir
  `CLAUDE.md` et `docs/HEALTH_ENGINE.md`) sur ce vocabulaire d'états et ces textes FR déjà écrits par
  Parrot — pas de reproduire l'algorithme officiel.

## Décision explicite : réutilisation verbatim du texte Parrot

Les textes du catalogue ci-dessus sont le contenu éditorial propriétaire de Parrot (copyright),
extrait de leur APK décompilée. StroyPlant est un dépôt public sous GPLv3 (copyleft sur le code,
pas d'exemption pour du contenu tiers intégré). **Risque signalé explicitement à DestCom** : les
reprendre mot pour mot expose le dépôt à une demande de retrait si Parrot (ou son ayant droit) le
remarque. **DestCom a confirmé vouloir le verbatim malgré ce risque** (2026-09-03, après ce
rappel). Ce choix est documenté ici pour qu'il reste traçable — pas une décision prise à la légère
ni sans alternative proposée (l'alternative "réécrire nos propres textes" avait été présentée en
option recommandée).

## Décisions de design

### 1. Structure de page

La page détail passe de "un seul scroll" à **2 onglets au niveau page** (composant `Tabs` de
shadcn, déjà utilisé pour le sélecteur 24h/7j/30j du graphique) :
- **"Vue d'ensemble"** — contenu actuel inchangé : bannière de statut, gauges "Détails techniques",
  historique, "Derniers arrosages", "Arrosage automatique", lien calibration Plant Dr.
- **"Plante"** (nouveau) — fiche espèce embarquée + cartes de conseils.

### 2. Cartes filtrées par capteur disponible

Le Xiaomi LYWSD03MMC ne remonte que température + humidité **ambiante** (pas de sol, pas de
lumière, pas de fertilité) — les 4 cartes ne s'appliquent presque pas à lui. **Décision** : on
n'affiche que les cartes dont le capteur existe sur ce device. Parrot Pot → 4 cartes. Xiaomi → 1
carte ("Température"). Jamais de carte vide/n·a.

### 3. Fiche espèce embarquée

Le contenu de `/plants/$id` (description, entretien, gauges Arrosage/Ensoleillement/Engrais) est
**repris intégralement** dans l'onglet, pas un simple lien. Pour éviter de dupliquer la logique
d'affichage : extraction d'un composant partagé `PlantProfileDetail` (prend un `plantProfile` en
prop) depuis `/plants/$id`, réutilisé tel quel par `/plants/$id` (aucun changement de données) et
par le nouvel onglet Plante — même pattern que l'extraction déjà faite de `SpeciesSearch` depuis
`SpeciesPickerDialog` (voir `CLAUDE.md`, "Onboarding stepper").

### 4. Simplification "saison de croissance" — ignorée, notée pour plus tard

Les textes Parrot branchent aussi sur "saison de croissance active vs. dormance"
(`temperature_too_cold_growing_season_indoor_all` vs. `temperature_too_cold_not_growing_season_
indoor_all`, etc.). On n'a **aucune donnée** de ce type en base (`PlantProfile` n'a pas de mois de
croissance). **Décision** : on utilise **toujours** la variante "saison de croissance active" (la
plus actionnable), jamais la variante dormance. Pas d'heuristique par mois (risque de se tromper
pour des espèces à cycle inversé/tropical). **Noté explicitement comme piste à revisiter plus
tard** si une vraie source de données de saisonnalité par espèce devient disponible (le catalogue
Parrot importé — `PlantProfile`/`PlantProfileAttribute` — n'en contient pas aujourd'hui).

### 5. Indoor/outdoor

`Device.environment` (déjà en base, storage-only jusqu'ici — voir `CLAUDE.md`, entrée "Device
location + indoor/outdoor") pilote la sélection indoor/outdoor des textes température/lumière. Un
device sans `environment` renseigné (`null`) retombe sur la variante indoor (la plus fréquente pour
ce projet — usage domestique).

Les pots Parrot sont **toujours en pot** dans ce projet (jamais "en pleine terre" — pas de Flower
Power planté au sol) : la carte Humidité utilise donc toujours la variante `_potted` du texte
"trop d'eau" (`water_too_much_water_all_seasons_potted`), jamais `_soil`.

### 6. Table de correspondance statut → texte

| Carte | Notre statut (`ParameterStatus`/`DeviceHealthStatus`) | Texte Parrot (clé `strings.xml`) |
|---|---|---|
| **Humidité (goutte)** | `too_low` | `water_not_enough_water_all_seasons_all_environments` |
| | `too_high` | `water_too_much_water_all_seasons_potted` |
| | `ok` | `water_ok_all_seasons_all_environments` + prédiction (voir §7) |
| | pas d'espèce assignée | Valeur brute affichée sans statut ni comparaison (voir §8) |
| **Température** | `too_low` | `temperature_too_cold_growing_season_indoor_all` (ou `_outdoor_potted` si `environment=OUTDOOR`) |
| | `too_high` | `temperature_too_hot_all_season_indoor_all_outdoor_potted` (ou `_outdoor_soil` — n'arrive jamais ici, toujours potted, donc toujours la variante indoor/outdoor_potted) |
| | `ok` | `temperature_ok_all_season_all_environments` |
| | `calibrating`/`warming_up` | `temperature_soon_available_timed` ({time} = décompte réel, §7) |
| | pas d'espèce assignée | `temperature_no_plant_title`/`_text` |
| **Lumière** | idem structure température | `light_too_low`/`good`/`too_high` équivalents, `light_soon_available_title_timed`, `light_no_plant_*` |
| **Fertilité (bidon)** | `too_low` | `fertilizer_not_enough_fertilizer_growing_season_all_environments_exactly_{one,two,three}_fertilizer_type(s)` selon le nombre de `PlantProfileFertilizerType` de l'espèce (0 type → fallback `fertilizer_ok_or_not_enough_not_growing_season_all_environments`, générique) |
| | `too_high` | `fertilizer_too_much_fertilizer_all_seasons_potted` |
| | `ok` | `fertilizer_ok_all_seasons_all_environments` |
| | `calibrating` | `fertilizer_not_available_status` — **jamais** de variante chronométrée (Parrot n'en a pas pour l'engrais), même si on peut calculer un reste de jours |
| | pas d'espèce assignée | `fertilizer_no_plant_title`/`_text` |

`fertilizer_not_measurable_status`/`_infobox` (cas épiphyte/orchidée) : réservé pour une espèce
taguée orchidée (`PlantProfile.tags` bit 256, déjà résolu — voir `CLAUDE.md`, "Base de plantes").

### 7. Prédictions à calculer (nouveau code, pas de donnée Parrot manquante à deviner)

Nouveau module `backend/src/health/plantAdvice.ts` (fonctions pures, tests `node:test`, même
convention que `dailyLightIntegral.ts`/`soilConductivityCalibration.ts`) :

- **Décompte warmup global** (température/lumière quand `warming_up`) : `warmupMinDays -
  daysCovered` (les deux valeurs sont déjà calculées dans `computeDeviceHealth` — pas de nouvelle
  donnée à collecter, juste à exposer).
- **Décompte lumière spécifique** (quand `calibrating` au sens Part H — zéro jour complet) : heures
  restantes avant la fin du jour calendaire courant, dans `HealthSettings.timezone` — même technique
  que `dailyLightIntegral.ts`'s `dayKey`.
- **Prédiction d'arrosage** (carte Humidité, statut `ok`) : régression simple (taux de variation
  moyen) sur les lectures `POLL` d'humidité du sol des N derniers jours (fenêtre à définir dans le
  plan — proposition : 5 jours, cohérent avec `MAX_STALE_FALLBACK_AGE_MS`-style constantes déjà
  utilisées ailleurs) → nombre de jours estimé avant de repasser sous `soilMoistureMinPercent` de
  l'espèce (le `{min}` du texte). Si le taux de variation est nul ou positif (l'humidité ne baisse
  pas), pas de prédiction — retombe sur `water_ok_all_seasons_all_environments` sans la phrase de
  prédiction.
- **Sélection du nombre de types d'engrais** : compte simple des `PlantProfileFertilizerType` liés
  à l'espèce assignée (donnée déjà importée, sous-projet "Parrot plant database import").

### 8. Carte Humidité sans espèce assignée

`computeDeviceHealth` retourne `no_profile` et ne calcule **aucun** paramètre dès qu'aucune espèce
n'est assignée — mais Parrot afficherait quand même l'humidité en temps réel (elle n'a pas besoin
d'espèce). **Décision** : dans ce cas, la carte Humidité affiche le % d'humidité du sol et le
niveau de réservoir en direct (déjà disponibles hors Health Engine, via `Reading`), **sans**
statut ni texte de conseil coloré — un texte neutre invite à assigner une espèce pour un conseil
personnalisé. Aucun changement à `computeDeviceHealth`/`no_profile` (pas de risque de régression
sur le reste de l'app qui dépend de ce court-circuit).

### 9. Capacité du réservoir en litres (`39e1FE05`)

L'app officielle affiche "il reste 2.1L sur 2.2L", pas un pourcentage. On a déjà
`waterTankLevelPercent` mais jamais lu la capacité réelle — `39e1FE05` (`UUID_TANK_CAPACITY`,
"Certain" dans `docs/PARROT_BLE_REVERSE_ENGINEERING.md`) existe mais n'a jamais été lu par ce
projet, encodage non vérifié empiriquement.

**Décision** : ajouter cette lecture au périmètre. Script `hwtest` jetable (même convention que la
calibration Plant Dr/watering config, `backend/scripts/hwtest-*.ts`) sur le pot de test 8733
(`A0:14:3D:CD:87:33`, pas de plante) : lecture brute de `fe05` + confirmation empirique de
l'encodage en comparant à la capacité physique réelle du Parrot Pot (DestCom peut la vérifier
directement — la doc marketing Parrot annonce généralement 2.2L, à confirmer, pas à assumer). **Si
l'encodage ne peut pas être confirmé de façon fiable** (valeur ambiguë, device ne répond pas), la
carte retombe sur le pourcentage existant plutôt que d'inventer une conversion — pas de devinette,
conforme à la règle du projet (`CLAUDE.md`, "quand en doute technique, demander plutôt que deviner").

### 10. Architecture technique

- **Backend** : `backend/src/health/plantAdvice.ts` (fonctions pures ci-dessus) + nouvelle
  procédure tRPC `health.plantAdvice` (input `{deviceId}`, appelle `computeDeviceHealth()` une
  deuxième fois pour rester isolé — même choix que `inferenceShadow.ts`, pas de refactor du chemin
  `computeDeviceHealth` existant dont dépendent déjà dashboard/MQTT/scheduler) — retourne, par
  paramètre disponible sur le device : la clé d'état (`InstructionKey`-like), les placeholders
  numériques ({min}, {x}, {time}), jamais de texte français composé côté backend.
- **Frontend** : `frontend/src/lib/plantAdviceText.ts` (catalogue de textes verbatim + fonction
  d'interpolation des placeholders), composant `PlantAdviceTab` (nouvel onglet), composant partagé
  `PlantProfileDetail` (extrait de `/plants/$id`, voir §3). Le tRPC `plants.getById` existant est
  réutilisé pour la fiche espèce embarquée.
- `fe05` (capacité réservoir) : ajouté à `RawSensorLog` (Calibration service, déjà en partie lu —
  `fe01`/`fe04`) une fois l'encodage confirmé empiriquement, mêmes providers concernés (`mock`,
  `node-ble`) que le reste de la lecture Calibration.

## Vérification prévue

- Tests unitaires (`node:test`) pour toutes les fonctions de `plantAdvice.ts` — décomptes,
  prédiction d'arrosage (cas taux positif/nul/négatif), sélection du nombre de types d'engrais.
- Vérification manuelle contre le provider `mock` : les 4 cartes sur un Parrot Pot, la carte unique
  sur un Xiaomi, tous les statuts (ok/too_low/too_high/calibrating/warming_up/no_plant), les
  variantes indoor/outdoor, le cas "pas d'espèce assignée" (carte Humidité en valeur brute + les 3
  autres masquées/no_plant).
- `pnpm exec tsc --noEmit`/`pnpm test` (backend), `pnpm typecheck` (frontend — la vraie commande,
  pas le `tsc` racine muet, voir `CLAUDE.md` Gotchas).
- Session hardware réelle dédiée pour `fe05` (pot 8733) **avant** de considérer la carte réservoir
  en litres fiable — si non concluante, la carte reste en pourcentage jusqu'à une prochaine
  tentative, ce n'est pas un blocant pour le reste du sous-projet.

## Hors scope / follow-ups explicites

- Variantes "dormance" par saison de croissance — pas de donnée disponible aujourd'hui (§4), noté
  comme piste si une source de données de saisonnalité par espèce apparaît plus tard.
- `fertilizer_not_measurable_status` (cas épiphyte détaillé, texte `_infobox` complet) — mappé au
  tag orchidée existant, pas d'investigation plus poussée sur d'autres cas d'épiphytes non tagués.
- Aucun changement à `computeDeviceHealth`/Health Engine existant — ce sous-projet consomme les
  statuts déjà calculés, il n'en ajoute pas de nouveaux au moteur lui-même (les prédictions du §7
  vivent dans un module séparé, pas dans `health/scoring.ts`).
- Le risque de propriété intellectuelle du texte verbatim (voir section dédiée plus haut) reste
  assumé tel quel — pas de plan de mitigation supplémentaire (ex: réécriture différée) prévu par ce
  sous-projet.
