# Base de plantes — nouvelle page de recherche/consultation

**Sous-projet 1** de `docs/superpowers/specs/2026-08-31-ui-overhaul-roadmap.md` — voir ce document
pour le contexte de la décomposition et les 4 autres sous-projets. Validé avec DestCom le
2026-08-31 après brainstorming (questions posées une à une, spike de mapping filtres inclus
ci-dessous).

## Objectif

Une page de recherche/consultation dans les 9120 `PlantProfile` déjà importées (batch du
2026-08-29, voir `docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md`),
reproduisant le contenu et les filtres des écrans de l'app officielle
(`docs/flowerpower_screenshot/20260831_ForBetterUI/PlantDB_parrot_plantdetails_{1..4}.png`), avec
un lien dans la navbar. Périmètre de consultation uniquement — pas d'assignation d'espèce à un pot
depuis cette page (l'assignation reste sur la page du pot, sous-projets ultérieurs).

## Décisions validées

- **Toutes les 9120 espèces incluses**, avec une fiche dégradée pour les ~1050 sans
  `parrotSpeciesId` (WatchFlower-only : pas de traduction FR, pas d'attributs, pas de jauges de
  besoins — seulement les plages numériques déjà connues).
- **Pas d'image** — icône générique à la place du carrousel photo de l'app officielle (les visuels
  sont individuellement protégés par droit d'auteur, décision déjà prise et documentée lors de
  l'import du 2026-08-29 ; le sous-projet 4, image perso, ne concerne que les pots/plantes de
  l'utilisateur, pas le catalogue d'espèces).
- **Consultation séparée** de l'assignation à un pot (pas de bouton "Assigner" sur cette page).
- **Jauges de besoins (Arrosage/Ensoleillement/Engrais) : les deux formats** — la plage réelle
  (cohérente avec le reste de StroyPlant) ET une jauge à points, mais voir "Jauges de besoins"
  ci-dessous : ce ne sont **pas** des scores inventés, Parrot fournit déjà ces catégories.

## Spike : mapping code→libellé (fait le 2026-08-31)

Voir le détail complet dans la roadmap. Résumé : chaîne de résolution confirmée bout en bout via
`FilterValues.plist`/`PlantDetailsInfo.plist`/`Localizable.strings` de l'app iOS "Flower Power"
installée sur le Mac de DestCom, **identique dans toutes les langues** (pas un trou de traduction
FR). Couverture réelle par catégorie `PlantProfileAttribute` :

| Catégorie brute | Dimension(s) réelle(s) | Codes en base | Codes résolus |
|---|---|---|---|
| `FO` | Couleur des feuilles | 12 | **12/12** |
| `PT` (lifetime) | Cycle (annuel/vivace/bi-annuel) | 3 | **3/3** |
| `PT` (type) | Type de plante | 6 | 6/9 (AQ, BU, FE, GC, SU, TL non résolus) |
| `BL` | Couleur de floraison | 13 | 9/13 |
| `SH` | Forme de la plante | 16 | 5/16 |
| `SF` | Particularités | 14 | 3/14 |
| `SN` | Saison de floraison | 12 | 0/12 (schéma de codes différent) |

**Important** : `PlantProfileAttribute.category = "PT"` mélange deux dimensions distinctes (type de
plante ET cycle de vie) sous le même code brut — distinguables sans ambiguïté par la valeur
(`AN`/`PE`/`BA` = cycle ; `SH`/`VI`/`TR`/`IP`/`ED`/`GR` = type ; les deux ensembles de valeurs ne se
recoupent jamais). Le module de résolution doit traiter ça comme deux groupes logiques distincts,
pas un seul.

**Bonus, mapping complet et indépendant** : `fertilizer_type_1..22` résout `PlantProfileFertilizerType.code` ;
`tags_categoryName_*` (9 clés) résout le bitmask `PlantProfile.tags`.

**Règle d'affichage** : un code sans libellé résolu n'est **jamais** montré à l'utilisateur (ni en
brut, ni comme filtre proposé) — silencieusement omis de la fiche/des filtres. Fidèle au
comportement réel de l'app officielle (ces codes n'y sont jamais exposés non plus, dans aucune
langue).

## Jauges de besoins : pas d'invention, données Parrot déjà réelles

Contrairement à l'hypothèse initiale (convertir nos plages min/max en score 0-5 par une formule à
inventer), `PlantProfile` a déjà 3 colonnes catégorielles fournies telles quelles par Parrot :
`sunCategory` (1-4, réel : 827/675/3516/3052 espèces), `waterCategory` (1-4, réel :
117/7877/57/19), `fertilizerCategory` (1-3, réel : 5241/1858/971) — ce sont les scores mêmes que
l'app officielle affiche en jauge à points, aucune formule à inventer. Affichage validé : **jauge à
points (sur une échelle fixe de 5, comme l'app officielle — le fait qu'aucune espèce n'atteigne 5
sur `fertilizerCategory` est une réalité des données, pas un bug) + la plage réelle correspondante
juste à côté** :

| Ligne | Jauge (donnée Parrot réelle) | Plage réelle affichée |
|---|---|---|
| Arrosage | `waterCategory` | `soilMoistureMinPercent`–`soilMoistureMaxPercent` (%) |
| Ensoleillement | `sunCategory` | `lightMinMmol`–`lightMaxMmol` (mol/m²/j DLI, même unité que le reste de StroyPlant) |
| Engrais | `fertilizerCategory` | `soilConductivityMinUsCm`–`soilConductivityMaxUsCm` (µS/cm) |

**Température** : contrairement aux 3 lignes ci-dessus, l'app officielle l'affiche comme deux
valeurs min/max brutes (pas de jauge à points, capture `PlantDB_parrot_plantdetails_3.png`,
"🌡️15°C 🌡️30°C") — on reproduit ça à l'identique avec `temperatureMinC`/`temperatureMaxC`, pas de
jauge à inventer non plus.

Une espèce sans `waterCategory`/`sunCategory`/`fertilizerCategory` (n'importe laquelle des ~1050
WatchFlower-only, ou un des 8070 profils Parrot où le champ serait `null`) omet la jauge
correspondante — jamais un score à 0 point inventé.

## Architecture

**Backend** — nouveau routeur tRPC `plants` (`backend/src/api/trpc/routers/plants.ts`, ajouté à
`router.ts`) :

- `plants.search(input: { search?: string; tags?: number[]; attributeFilters?: {category: string; value: string}[]; page: number; pageSize: number })`
  → `{ items: PlantSummary[], total: number }`.
  - Recherche : `PlantProfile.name` (latin, `contains`) OR `PlantProfileSearchName.name` où
    `locale = 'FR'` (`contains`) OR `PlantProfile.commonName` (`contains`, colonne WatchFlower déjà
    existante — seul champ de recherche disponible pour les profils WatchFlower-only).
    **Attention** : les locales sont stockées en majuscules (`'FR'`, `'EN'`, …) dans
    `PlantProfileSearchName`/`PlantProfileTranslation` — vérifié sur les données réelles pendant ce
    brainstorming (`SELECT DISTINCT locale` → `DE/EN/ES/FR/IT/JA/ZH`), à ne pas confondre avec la
    casse minuscule utilisée ailleurs dans ce document par simple confort de lecture.
  - Filtres tags : bitwise (`tags & tagBit != 0`), OR entre tags sélectionnés (une espèce avec
    n'importe lequel des tags cochés matche — cohérent avec la nature bitmask, un profil peut
    cumuler plusieurs tags).
  - Filtres attributs : jointure sur `PlantProfileAttribute`, OR entre valeurs d'une même
    catégorie, AND entre catégories différentes (reprend le texte de l'app elle-même,
    `filter_infoLabel_selectFilterCriteria` = "Select one or more filters").
  - `PlantSummary` : id, name, commonName (résolu : `PlantProfileTranslation.commonName` locale
    `FR` si présent, sinon `PlantProfile.commonName` WatchFlower), hasParrotData (bool, =
    `parrotSpeciesId != null`), tags résolus (labels, pour affichage en badges sur la carte
    résultat).
  - Pagination offset (`skip`/`take`), pas de curseur — volume total (9120) largement dans les
    capacités de SQLite pour un `COUNT` + page simple, cohérent avec le principe YAGNI déjà
    appliqué ailleurs dans ce projet (ex. `health.plantProfiles` existant fait déjà un `findMany`
    simple).
  - Recommandation d'approche validée dans le brainstorming : requêtes Prisma classiques,
    ni FTS5 ni table dénormalisée précalculée (prématuré à ce volume, à ne réévaluer que si une
    vraie mesure de perf le justifie).
- `plants.getById(input: { id: number })` → fiche complète :
  - Champs `PlantProfile` bruts (tailles, zones de rusticité, etc.).
  - `PlantProfileTranslation` locale `FR` (peut être entièrement absente pour un profil
    WatchFlower-only — dans ce cas la fiche est automatiquement "dégradée" côté frontend, voir
    plus bas).
  - `PlantProfileSearchName` locale `FR`, type `0` (noms communs, potentiellement plusieurs — ex.
    "Figuier Pleureur" ET "Ficus Benjamina" pour la même espèce, confirmé sur les données réelles)
    — distinct de `PlantProfileTranslation.commonName` (une seule valeur, utilisée comme titre de
    la fiche) qui n'en est qu'une des deux dans cet exemple.
  - `PlantProfile.synonyms` (colonne texte directe, déjà résolue — ex. "Ficus nitida" pour Ficus
    benjamina, confirmé sur les données réelles) pour la ligne "Synonymes", pas besoin de passer
    par `PlantProfileSearchName type=3`.
  - Attributs résolus (labels FR uniquement pour les codes couverts, groupés en 7 dimensions
    logiques : type, cycle, couleur de floraison, couleur des feuilles, forme, particularités,
    saison de floraison — cette dernière restera toujours vide vu la couverture 0/12).
  - Fertilizer types résolus (`fertilizer_type_1..22`).
  - Tags résolus (`tags_categoryName_*`).
  - Throw `NOT_FOUND` si l'id n'existe pas (`protectedProcedure`, même convention que le reste du
    routeur `devices`).

**Module de résolution de labels** — `backend/src/health/parrotFilterLabels.ts` : constantes
TypeScript committées (pas de nouvelle table Prisma pour 41+22+9 entrées fixes et stables) :
- `resolveAttributeLabel(category: string, value: string): { group: string; groupLabel: string; valueLabel: string } | null` —
  gère la désambiguïsation `PT` type-vs-cycle décrite plus haut ; retourne `null` pour un code non
  couvert (jamais un libellé inventé ou le code brut).
- `resolveFertilizerTypeLabel(code: number): string | null`.
- `resolveTagLabel(bit: number): string | null` (décode chaque bit individuellement du bitmask
  `PlantProfile.tags`).
- `listKnownAttributeFilters(): { group: string; groupLabel: string; options: {value: string; label: string}[] }[]` —
  source unique de vérité pour les filtres proposés au frontend (évite qu'un filtre affiché ne
  corresponde à aucun résultat possible en base).

Extraction faite manuellement pendant le brainstorming (spike ci-dessus) — pas de script
d'extraction séparé nécessaire vu le faible volume (~70 entrées au total), à la différence de
`extractParrotPlantData.ts` qui gère des centaines de milliers de lignes. Les valeurs vont
directement dans le fichier TypeScript committé.

**Frontend** :

- `frontend/src/routes/_authenticated/plants.tsx` — page liste :
  - Barre de recherche (`Input`, debounce 300ms, même pattern que `SpeciesSearch`).
  - Ligne de filtres rapides par tag (`tags_categoryName_*`, boutons/badges togglables,
    multi-sélection).
  - Panneau de filtres avancés (attributs résolus, groupés par dimension logique, cases à
    cocher) — nécessite d'ajouter les composants shadcn `checkbox` et `popover` (ou `sheet` pour
    mobile) via la CLI, absents du set actuel (`badge`/`button`/`card`/`chart`/`dialog`/`input`/
    `label`/`separator`/`skeleton`/`sonner`/`switch`/`tabs`) — détail d'implémentation pour le
    plan, pas une décision d'architecture.
  - Grille de cartes résultat (nom latin en italique, nom commun, badges de tags), pagination
    simple (précédent/suivant + compteur total).
  - Lien ajouté dans `app-shell.tsx` (sidebar desktop + nav mobile), entre "Tableau de bord" et
    "Historique" — icône `Sprout` ou `Leaf` (`lucide-react`, déjà une dépendance).
- `frontend/src/routes/_authenticated/plants.$id.tsx` — page détail :
  - En-tête : icône générique de plante (pas de photo), nom commun (titre), nom latin en italique
    en sous-titre — même registre visuel que les captures.
  - Si profil dégradé (pas de traduction) : une seule carte "Fiche limitée — données partielles"
    avec les plages numériques disponibles, pas d'onglets.
  - Sinon, `Tabs` (composant shadcn déjà présent) "Description"/"Entretien" :
    - **Description** : Nomenclature (nom scientifique, genre, espèce, noms communs, synonymes),
      Description générale (`description`), Faits intéressants (`interesting`), Caractéristiques
      (type/cycle/couleur des feuilles/forme résolus, taille, expansion — chaque ligne omise si
      la donnée sous-jacente est `null` ou non résolue), Particularités (badges, `SF` résolus
      uniquement).
    - **Entretien** : Nutriments et besoins (les 3 lignes jauge+plage, tableau ci-dessus, plus
      Température en min/max brut), puis les sections texte présentes, dans cet ordre (calé sur
      les intitulés `plantDetails_groupHeader_*` de l'app officielle, ordre exact d'affichage non
      vérifié — détail mineur pour le plan) : Plantation (`planting`), Croissance (`growth`),
      Floraison (`blooming`), Récolte (`harvesting`), Sol et Irrigation (`soilIrr`), Fertilisation
      (`fertilizerText`), Elagage (`pruning`), Éléments nuisibles (`pests`), et — si présent
      seulement, champ beaucoup plus rare que les autres (376/8070 espèces FR, vérifié sur les
      données réelles) — une section "Conseils complémentaires" (`detailCare`), Zone de pousse de
      la plante (zones de rusticité/chaleur en texte). Chaque section omise si son champ est
      `null`, jamais un texte de remplissage inventé (cohérent avec le principe déjà établi
      ailleurs dans ce projet de ne jamais fabriquer de donnée manquante). **Correction faite
      pendant la relecture (2026-08-31)** : la première version de cette spec omettait Floraison
      et Éléments nuisibles alors que ce sont des champs réels et peuplés à ~90% (7160 et 7377
      espèces FR sur 8070) — repérée par DestCom en comparant avec les captures d'écran.
  - Nouveau composant présentationnel léger pour la jauge à points (5 points, N remplis) — pas une
    réutilisation de `SensorGauge` (langage visuel circulaire différent, pas adapté à un score
    catégoriel 1-4/1-3).

## Erreurs

- `plants.getById` sur un id inexistant : `TRPCError({code: 'NOT_FOUND'})`, la page détail affiche
  un état d'erreur clair ("Cette espèce n'existe pas ou plus") plutôt qu'un écran vide — **note
  liée au sous-projet 5** (affichage d'erreurs lisible) : cette page doit être écrite dès le départ
  sans reproduire le problème identifié (pas de message technique brut affiché à l'utilisateur).
- `plants.search` : aucune erreur métier attendue (une recherche/filtre sans résultat retourne
  simplement `{ items: [], total: 0 }`, affiché comme "Aucune espèce trouvée" — même formulation
  que `SpeciesSearch` existant).

## Non-objectifs (hors périmètre de ce sous-projet)

- Assignation d'espèce à un pot depuis cette page (décision validée : consultation séparée).
- Résolution des codes non couverts par le mapping actuel (`SN` entièrement, et le reste de
  `SH`/`SF`/`BL`/`PT`-type) — pas de nouvelle recherche de source de données dans ce sous-projet
  (décision validée : avancer avec la couverture actuelle).
- Correction de l'unité de luminosité en mode live (sujet séparé, sous-projet 2).
- Traduction multi-langue de l'interface (le site reste en français ; les traductions `de`/`en`/
  `es`/`it`/`ja`/`zh` déjà en base pour d'autres locales ne sont pas exploitées ici).

## Tests

Pas de test automatisé dédié pour l'orchestration Prisma (cohérent avec la convention déjà établie
pour ce type de code dans ce projet — `importSpeciesProfiles.ts` n'en a pas non plus, vérifié
manuellement). En revanche, `parrotFilterLabels.ts` (logique pure de résolution, désambiguïsation
`PT` incluse) doit avoir des tests dédiés (`node:test`, même pattern que
`parrotPlantData.test.ts`) — c'est exactement le genre de logique pure que ce projet teste déjà
systématiquement. Vérification manuelle contre le provider mock + les données réelles déjà
importées dans `dev.db` pour le reste (recherche, filtres, pagination, fiche complète vs.
dégradée).
