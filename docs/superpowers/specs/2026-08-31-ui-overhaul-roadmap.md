# Roadmap — refonte UI/UX + base de plantes + mode live par défaut

> **Nature de ce document** : ce n'est PAS une spec architecturale au sens habituel (une seule
> décision validée, prête pour un plan d'implémentation). C'est un document de suivi de la
> décomposition d'une demande trop large pour une seule spec (voir `superpowers:brainstorming`,
> section "aider à décomposer"). Chaque sous-projet listé ci-dessous aura sa **propre** spec
> (`docs/superpowers/specs/YYYY-MM-DD-<sous-projet>-design.md`) et son propre plan d'implémentation,
> écrits et validés séparément, un par un. Ce document sert à ne pas perdre le fil de la demande
> initiale de DestCom (2026-08-31) au fur et à mesure que le contexte de chaque conversation grandit.

**Demande initiale (résumé)** : le site actuel a une UI/UX jugée incompréhensible et pas alignée
avec l'usage réel. DestCom veut, dans cet ordre convenu (2026-08-31) :

1. Base de plantes (nouvelle page)
2. Page detail du pot — mode live par défaut, avec repli propre si la connexion échoue
3. Onglet "Plante" sur la page detail (espèce assignée + conseils "à la official app")
4. Image perso ou récupérée sur internet pour illustrer plante/pot
5. Refonte UI/UX transverse, appliquée au fil des 4 chantiers ci-dessus plutôt qu'à part

Un plan déjà écrit et non lié à cette demande, `2026-08-31-parrot-live-sensor-view.md`
(réservoir en litres dans la vue live existante), est indépendant et peut être exécuté à tout
moment sans bloquer ni être bloqué par ce qui suit.

---

## Sous-projet 1 — Base de plantes (nouvelle page)

**Statut : à brainstormer en premier (ordre validé par DestCom).**

**Demande de DestCom** : une page listant/cherchant dans la base de plantes complète, avec les
mêmes infos et les mêmes filtres que les captures `docs/flowerpower_screenshot/20260831_ForBetterUI/
PlantDB_parrot_plantdetails_{1..4}.png` (écrans "Description" et "Entretien" de l'app officielle),
plus un lien dans la navbar.

**Ce qui existe déjà côté données** (import Parrot du 2026-08-29, voir `CLAUDE.md`) — donc ce
sous-projet est presque entièrement frontend + requêtes de lecture, pas une nouvelle extraction de
données :
- `PlantProfile` (8070 espèces avec `parrotSpeciesId`) : taxonomie, tailles, zones de rusticité,
  `tags`, données de calibration Parrot.
- `PlantProfileTranslation` (locale `fr` disponible) : `description`, `planting`, `growth`,
  `pruning`, `harvesting`, `interesting`, `soilIrr`, `pests`, `blooming`, `fertilizerText`,
  `detailCare` — correspond directement aux sections "Description générale", "Faits intéressants",
  "Plantation", "Croissance", "Récolte", "Sol et Irrigation", "Fertilisation", "Elagage" des
  captures.
- `PlantProfileAttribute` : codes de filtre bruts (type de plante, couleur des feuilles, forme,
  particularités type "Attire les oiseaux") — **pas encore de résolution code → libellé humain**,
  à faire dans ce sous-projet si les filtres doivent afficher du texte lisible.
- `PlantProfileSearchName` : noms de recherche multi-locale (utile pour une vraie recherche FR,
  contrairement à la recherche actuelle).

**Spike mapping code→libellé (fait le 2026-08-31, sur l'app iOS "Flower Power" installée sur le
Mac de DestCom, `FilterValues.plist` + `PlantDetailsInfo.plist` + `Localizable.strings`)** :
- Chaîne de résolution confirmée bout en bout (ex: `PT/IP` → "Plante d'intérieur").
- **Identique dans toutes les langues** (comparé FR/EN clé par clé, même ensemble exact de 41
  clés `filter_filterCriteria_*`) — pas un trou de traduction française.
- Couverture réelle par catégorie (codes vus dans les 77 889 lignes déjà importées vs. codes avec
  libellé trouvé) : `FO` couleur feuillage 12/12 (complet), `BL` couleur floraison 9/13, `PT`
  type+cycle 9/15, `SH` forme 5/16, `SF` particularités 3/14, `SN` saison de floraison 0/12 (codes
  totalement différents du schéma du plist). Confirmé — pas une extraction ratée : les 41 clés du
  plist sont l'intégralité de ce que l'app définit, dans les ~1500 clés du fichier de traductions
  entier, toutes langues confondues. Probablement une classification "encyclopédie" plus riche que
  ce que l'app mobile n'a jamais exposé comme filtre utilisateur — exclure les codes non mappés des
  filtres proposés est donc fidèle au comportement réel de l'app, pas une régression.
- **Bonus trouvé au passage, mapping complet** : `fertilizer_type_1..22` résout entièrement
  `PlantProfileFertilizerType.code` (déjà importé, 9308 lignes) ; `tags_categoryName_*` (8-9
  clés) résout le bitmask `PlantProfile.tags` (indoor/outdoor/cactus_and_succulent/
  orchid_and_original/etc., confirme et complète le bit 256 = orchidée déjà connu).
- **Décision validée avec DestCom (2026-08-31)** : avancer avec cette couverture — libellés là où
  le mapping existe, codes non mappés simplement exclus des filtres proposés à l'utilisateur (pas
  affichés en brut).

**Ce qui n'existe pas encore et devra être conçu dans la spec** :
- Le tRPC `health.plantProfiles` actuel (`backend/src/api/trpc/routers/health.ts:26`) ne cherche
  que sur `PlantProfile.name` (nom latin), pas sur les traductions/noms de recherche, pas de
  filtres, capé à 20 résultats — insuffisant pour une vraie page de recherche. Nouvelle procédure
  (ou routeur dédié) à concevoir : recherche par nom FR (`PlantProfileSearchName`), filtres par
  attributs (`PlantProfileAttribute`), pagination.
  - Les fiches "Nutriments et besoins" (5 gouttes/soleils/thermomètres/engrais dans les captures)
    utilisent une échelle 0-5 dans l'app officielle — à vérifier si un champ numérique équivalent
    existe déjà (`soilMoistureMinPercent`/etc. sont des plages, pas des scores 0-5) ou s'il faut
    une conversion à définir dans la spec.
  - Résolution des codes `PlantProfileAttribute`/`fertilizerType` en libellés FR lisibles — la
    donnée brute existe, le mapping code→libellé (`FilterValues.plist`/`Localizable.strings` côté
    app officielle) n'a jamais été extrait pour ce projet.
- Nouvelle route frontend + lien navbar (`frontend/src/components/app-shell.tsx`, nav actuelle :
  `/`, `/history`, `/devices/add`, `/settings`).

---

## Sous-projet 2 — Page detail du pot : mode live par défaut

**Statut : après le sous-projet 1.**

**Demande de DestCom** : à l'ouverture de `/devices/$deviceId`, tenter une connexion live
immédiate (comme l'app officielle) pour débloquer humidité du sol / luminosité / température en
direct et un arrosage quasi instantané. Si la connexion échoue, replier proprement sur le graphique
historique + les infos connues du pot (plante, nom, conseils). Le toggle manuel "Démarrer/Arrêter
le mode live" disparaît puisque c'est désormais le comportement par défaut.

**Infrastructure déjà existante à réutiliser** (`liveSession/manager.ts`, `LiveModeSection`,
`liveSession` tRPC router `status`/`start`/`stop`/`onSample`) : session unique globale, cutoff
auto à 5 min, contrainte de connexion GATT partagée avec le scanner/scheduler/watering. Points à
trancher dans la spec de ce sous-projet :
- Auto-start à l'ouverture de la page vs. bouton explicite conservé pour l'action "arroser
  maintenant" seule (le déclenchement d'arrosage ne nécessite pas forcément une session live selon
  le protocole BLE actuel — à vérifier avant de coupler les deux).
- Que devient le cutoff de 5 minutes si le mode live est désormais la vue par défaut d'une page
  qu'on peut laisser ouverte plus longtemps (reconnexion auto silencieuse ? notice visible ?).
- Le repli "échec de connexion" doit rester cohérent avec la contrainte "une seule connexion GATT à
  la fois" (un autre appareil en cours de poll ne doit pas être interprété comme un échec
  définitif — actuellement `CONFLICT` immédiat sur une 2e session, à re-vérifier pour ce nouveau
  flux).

**Nouveau point ajouté par DestCom (2026-08-31)** — unité de luminosité en mode live incorrecte :
captures `docs/flowerpower_screenshot/20260831_ForBetterUI/parrotapp_lux_unit_example_{1,2}.png` —
l'app officielle affiche un **nombre entier en lux ou klux** ("8232 live lux" / "72 live klux") en
mode live, alors que notre `LiveModeSection` affiche la valeur calibrée `39e1fa0b` telle quelle,
étiquetée "Luminosité (DLI)" en mol/m²/j (une unité d'intégrale journalière appliquée à une lecture
instantanée — déjà incohérent en soi, voir `CLAUDE.md` Part H sur le vrai calcul de DLI journalier
utilisé ailleurs pour le Health Engine). Le raw ADC (`fa01`, `lightRaw`) est déjà lu et stocké dans
`RawSensorLog` mais jamais utilisé pour l'affichage. **Pas encore résolu** : la formule de
conversion raw→lux/klux que l'app officielle applique n'est pas connue de ce projet — à rechercher
(décompilation existante, ou nouvelle capture BLE) avant de finaliser la spec de ce sous-projet, ne
pas deviner une formule.

**Nouveau point ajouté par DestCom (2026-09-01)** — température live incohérente : le mode live
affiche des valeurs autour de 39°C alors que la température ambiante réelle chez DestCom est
d'environ 20°C. Pas encore diagnostiqué (capteur `39e1fa09`/`airTempRaw` mal décodé ? confusion
sonde sol/air, cf. l'historique `fixSoilMoistureTemperatureSwap.ts` du 2026-08-29 sur le swap
fa07/fa09 déjà rencontré une fois sur ce projet ? calibration réelle du device ?) — à investiguer
empiriquement (capture BLE réelle ou lecture directe sur un pot en conditions connues) avant de
conclure, ne pas deviner une correction. À traiter dans le même sous-projet que l'unité de
luminosité puisque les deux touchent le même `LiveModeSection`/mode live par défaut.

---

## Sous-projet 3 — Onglet "Plante" sur la page detail

**Statut : après le sous-projet 1 (dépendance directe sur ses données/composants).**

**Demande de DestCom** : un nouvel onglet sur la page detail d'un pot montrant les détails de
l'espèce assignée (réutilise le sous-projet 1) ET les "conseils" que l'app officielle affichait —
captures `docs/flowerpower_screenshot/20260830/image-1787968{205560,217772,223780,226943}.webp`
(4 onglets : goutte=humidité du sol avec seuil de déclenchement, bidon=engrais, thermomètre=
température, soleil=lumière ; chacun avec un texte d'explication, parfois une "période
d'initialisation en cours" générique, parfois une valeur live comme "2.1L sur 2.2L" ou "61%").

**Distinction importante, à clarifier dans la spec** : ces "conseils" ne sont **pas** le même
contenu que `PlantProfileTranslation.detailCare`/etc. du sous-projet 1 (qui est du texte
horticole générique par espèce). Ce sont des textes d'interface qui expliquent un état du système
(mode d'arrosage actif, seuils de déclenchement, période de calibration) — probablement stockés
comme chaînes localisées (`Localizable.strings`/ressources Android `strings.xml`) dans l'app
décompilée ou l'app iOS installée sur le Mac de DestCom, pas dans `scientific_data.json`/
l'encyclopédie déjà importée.

**Travail préalable nécessaire avant de brainstormer ce sous-projet** : une phase de recherche
(spike) pour localiser et extraire l'ensemble des textes de conseils et leurs conditions
d'affichage, dans `docs/PARROT_BLE_DEEP_DIVE.md`/la décompilation existante ou directement dans
l'app iOS installée — **pas encore fait**, à ne pas deviner.

---

## Sous-projet 4 — Image plante/pot (perso ou depuis internet)

**Statut : après les 3 précédents (indépendant, mais implique une décision d'infra pas encore
prise).**

**Demande de DestCom** : pouvoir associer une image personnelle (upload) ou récupérée sur internet
à un pot/une plante, pour illustration sur le dashboard/la page detail.

**Décisions à trancher dans la spec de ce sous-projet** (aucune n'est prise) :
- Stockage : disque local du conteneur Docker (volume à monter en plus de `dev.db`, question de
  backup/taille — le projet a déjà eu un incident de volume avec les ~204MB de `seed-data/`) vs.
  stocker en base (BLOB) vs. un service externe. Pas de connecteur Neon Object Storage/S3 déjà
  câblé dans ce projet à ce jour.
- Recherche d'image "depuis internet" : quelle source (recherche d'image générique, une API
  dédiée) — implique potentiellement une clé API/un coût, à valider avec DestCom avant de choisir.
- Sur quelle entité l'image vit : `Device` (le pot physique) et/ou `PlantProfile` (l'espèce,
  partagée par tous les pots de cette espèce) — les deux usages sont mentionnés par DestCom
  ("image perso de la plante ou du pot").

---

## Sous-projet 5 — Affichage d'erreurs lisible

**Statut : bounded, indépendant des 4 précédents — peut se faire à tout moment.**

**Demande de DestCom (2026-08-31)** : capture `docs/flowerpower_screenshot/20260831_ForBetterUI/
errors_displayed_in_App.png` — la page Historique (et probablement d'autres endroits affichant
`errorDetail`) montre des messages techniques bruts directement à l'utilisateur : "Unexpected
token '<', "<!DOCTYPE "... is not valid JSON" (l'erreur Cloudflare 502 déjà documentée dans
`CLAUDE.md`, gotcha "Cloudflare's origin timeout..."), "le-connection-abort-by-local", etc. — sous
des titres génériques ("Échec de la synchronisation"/"Échec de la configuration"). DestCom :
"à chaque fois qu'il doit afficher des erreurs il recrit de la merde".

**Périmètre à couvrir dans la spec de ce sous-projet** (inventaire à faire, pas encore fait) :
tout endroit qui affiche `SyncEvent.errorDetail`/`WateringEvent.errorDetail` brut ou un message
d'erreur tRPC brut — la page Historique en priorité (capture ci-dessus), mais probablement aussi
les toasts d'erreur (`toast.error(..., { description: error.message })`, plusieurs composants) et
la page de calibration Plant Dr. Approche à concevoir : une fonction de traduction
erreur-technique → message humain FR (mapping sur des motifs connus : timeout, erreur Cloudflare,
`le-connection-abort-by-local`, `GATT_ERROR`, etc.), avec un repli explicite et honnête (pas un
message inventé) pour un motif non reconnu — probablement le message technique conservé mais dans
un second niveau (accordéon "détails techniques"), jamais comme titre principal.

---

## Refonte UI/UX transverse

Pas un sous-projet séparé avec sa propre spec : à appliquer progressivement à chaque page touchée
par les sous-projets 1 à 4 (et aux pages existantes non listées ici, au fur et à mesure), plutôt
qu'un chantier "big bang" à part. Le skill `frontend-design` sera invoqué au moment de la
conception visuelle de chaque sous-projet plutôt qu'ici.

---

## Suivi

- [x] Sous-projet 1 — Base de plantes : spike mapping filtres fait (2026-08-31) → brainstorming →
  spec → plan → **implémenté** (2026-09-01, voir `CLAUDE.md` "Base de plantes", incl. les
  post-PR follow-ups du même jour)
- [ ] Sous-projet 2 — Mode live par défaut (+ unité luminosité live à corriger, + température live
  incohérente) : brainstorming fait (2026-09-02) → **spec écrite**
  (`2026-09-02-live-mode-default-design.md`, en relecture) → plan → implémentation. Le bug de
  température s'est avéré déjà corrigé sur `main` avant même ce brainstorming (voir la spec, section
  "Hors scope") — reste à déployer, pas à concevoir.
- [ ] Sous-projet 3 — Onglet "Plante" + conseils : spike (extraction des conseils) → brainstorming → spec → plan → implémentation
- [ ] Sous-projet 4 — Image plante/pot : brainstorming (avec décision d'infra) → spec → plan → implémentation
- [ ] Sous-projet 5 — Affichage d'erreurs lisible : brainstorming → spec → plan → implémentation (indépendant, peut être avancé n'importe quand)

D'autres idées pourront être ajoutées par DestCom au fil de l'eau — les intégrer ici comme nouvelle
section datée plutôt que de les perdre dans la conversation.
