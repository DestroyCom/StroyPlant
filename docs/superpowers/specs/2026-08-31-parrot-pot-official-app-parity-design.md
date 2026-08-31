# Parrot Pot — parité avec l'appli officielle (2026-08-31)

Design approuvé par DestCom (brainstorming en session), à passer à `writing-plans` ensuite. Objectif :
faire fonctionner StroyPlant, côté Parrot Pot, comme l'appli officielle Flower Power, maintenant que
la base de plantes Parrot (8000+ espèces) est importée : bascule entre les 4 modes d'arrosage réels
de l'appli, capteurs en direct affichés dans les bonnes unités, tout en gardant le sondage régulier
existant (graphiques qualité + filet de sécurité serveur déjà en place).

Ground truth : 15 captures d'écran de l'appli officielle réelle dans
`docs/flowerpower_screenshot/` (textes/UX repris directement de là où c'est pertinent).

## Périmètre — ce qui NE change PAS

- Le filet de sécurité serveur (`health/scheduler.ts`'s degraded safety-net path, déclenchement si la
  lecture est ~20 points sous la cible et que l'arrosage autonome côté pot est actif) reste identique
  — confirmé correspondre à l'attente, pas de modification.
- Le sondage régulier (`namedDevicePoller.ts`, intervalle défini dans Settings) reste identique — sert
  toujours aux graphiques historiques et au filet de sécurité ci-dessus.
- Le mécanisme de push checksum-safe (`wateringConfigPush.ts`, corrigé le même jour, voir
  `[[project_autonomous_watering_f903_f904_revert]]`) reste le mécanisme d'écriture — seule la
  **source des valeurs poussées** change (section 2).
- `AutoWateringSection` (toggle serveur `Schedule.active` + fenêtre horaire + cooldown, Batch 5)
  reste un mécanisme séparé et orthogonal au nouveau sélecteur de mode — l'un contrôle si le serveur
  intervient en secours, l'autre ce que le pot fait de lui-même.

## 1. Modèle de données

Sur le modèle `Schedule` existant (un enregistrement optionnel par appareil, déjà porteur de la
config d'arrosage) :

```prisma
enum WateringMode {
  PERFECT_DROP
  PLANT_SITTER
  MANUAL
  CUSTOM
}

model Schedule {
  // ... champs existants inchangés ...
  wateringMode         WateringMode @default(PERFECT_DROP)
  customVwcIrrPercent  Float?       // uniquement significatif si wateringMode = CUSTOM
  customVwcCmdPercent  Float?
  customNIrrDays       Int?
}
```

`@default(PERFECT_DROP)` sur les enregistrements existants correspond exactement au comportement
actuel (seuils classiques de l'espèce, mode toujours "auto") — migration non-destructive, aucun
appareil déjà configuré ne change de comportement au déploiement.

## 2. Résolution des seuils par mode

Nouvelle fonction dans `backend/src/ble/parrot/wateringConfig.ts` (remplace l'usage direct de
`plantProfile.soilMoistureIrrigatePercent`/`soilMoistureCommandPercent` dans
`resolveWateringConfigEligibility`) :

```ts
export type WateringModeResolution =
  | { eligible: false }
  | { eligible: true; vwcIrrPercent: number; vwcCmdPercent: number; nIrr: number; mode: 0 | 1 };

export function resolveWateringModeThresholds(
  wateringMode: WateringMode,
  plantProfile: PlantProfileThresholdFields | null,
  custom: { vwcIrrPercent: number | null; vwcCmdPercent: number | null; nIrrDays: number | null },
): WateringModeResolution;
```

Logique par mode :

- **`PERFECT_DROP`** — `plantProfile.soilMoistureIrrigatePercent`/`soilMoistureCommandPercent`/
  `irrigateCalibrationSampleCount` (comportement actuel, inchangé). Nécessite une espèce Parrot
  assignée (`eligible: false` sinon) — texte UI repris de la capture : *"Système d'arrosage
  automatique pour une croissance optimale de votre plante au quotidien."*
- **`PLANT_SITTER`** — priorité à `plantProfile.soilMoistureIrrigateEcoPercent`/
  `soilMoistureCommandEcoPercent`/`irrigateEcoCalibrationSampleCount` (100% des 8070 espèces Parrot
  en ont aujourd'hui, vérifié empiriquement). **Fallback** (chemin mort aujourd'hui, gardé pour
  robustesse future) si `soilMoistureIrrigateEcoPercent` est `null` mais que les seuils classiques
  existent : `vwcIrrPercent = soilMoistureIrrigatePercent - 6`, `vwcCmdPercent =
  soilMoistureCommandPercent` inchangé, `nIrr = irrigateCalibrationSampleCount` inchangé. Nécessite
  une espèce Parrot assignée (mêmes conditions que Perfect Drop). Texte UI : *"Système d'arrosage
  automatique optimisant la consommation d'eau pour assurer jusqu'à un mois d'autonomie."*
- **`MANUAL`** — pas de dépendance à l'espèce, `eligible: true` toujours (tout Parrot Pot). Seuils :
  ceux déjà sur l'appareil, préservés tels quels par le read-modify-write existant (aucune valeur
  `vwcIrr`/`vwcCmd`/`nIrr` à fournir en override). `mode: 0`. Texte UI : *"Arrosage manuel de votre
  plante. L'arrosage automatique de votre plante sera alors désactivé."*
- **`CUSTOM`** — pas de dépendance à l'espèce, `eligible: true` toujours. Utilise
  `custom.vwcIrrPercent`/`custom.vwcCmdPercent`/`custom.nIrrDays` (convertis en unités 15 minutes
  côté device : `nIrr = nIrrDays * 96`). `mode: 1`. Texte UI : *"Configuration des paramètres
  d'arrosage automatique de votre plante."*

`wateringConfigPush.ts` appelle cette fonction à la place de la construction actuelle des overrides,
le reste de son flux (read-modify-write + checksum + vérification par relecture) est inchangé.

## 3. Frontend — sélecteur de mode

`AutonomousWateringSection` remplace son contenu actuel (seuil/cible en lecture seule + bouton
"repousser") par :

1. Un sélecteur à 4 options (boutons/radio), textes repris de la capture `Mode d'arrosage` de
   l'appli officielle (section 2 ci-dessus).
2. Pour `CUSTOM` uniquement : 3 champs de saisie (seuil %, cible %, délai en jours).
3. En dessous, les valeurs **effectivement actives** (calculées par `resolveWateringModeThresholds`,
   affichées en lecture seule pour tous les modes y compris Custom) — garde le format actuel
   (`vwcIrrRaw/10`%, etc.), lu depuis `wateringConfig.getConfig`.

`schedule.upsert` (tRPC, déjà l'un des 3 déclencheurs de `kickOffWateringConfigPush`) accepte les 4
nouveaux champs (`wateringMode` + les 3 `custom*`) — changer de mode déclenche automatiquement un
push, comme un changement d'horaire le fait déjà aujourd'hui pour le filet de sécurité serveur.

## 4. Comportements spéciaux par tag d'espèce (orchidées, cactus)

Trouvé en lisant directement le code source décompilé de l'appli Android réelle
(`/Users/destcom/Documents/PERSO/parrot-pot-debug/analyse/decoded_jadx/`, `strings.xml` et
`DataManager.java`/`Utility.java`) — pas une supposition. `PlantProfile.tags` (déjà importé,
bitmask) porte 2 flags pertinents :

- **Bit 256 = orchidée** (33/8070 espèces, dont Phalaenopsis, déjà utilisée sur un vrai appareil de
  ce projet). **Mécanisme réel confirmé** (`DataManager.java:3033`,
  `createWateringConfigThread(plantId, isOrchid ? 0 : 1)`) : l'appli force `wateringMode = MANUAL`
  **automatiquement à l'assignation d'une espèce orchidée**, avec le message *"Attention, l'arrosage
  automatique n'est pas optimisé pour les orchidées : la soucoupe risque de déborder. Nous vous
  conseillons de rester en mode Manuel avec une orchidée."* (`watering_autoMode_orchidWarning`).
  **Reproduit à l'identique** : dans `health.assignPlantProfile` (l'un des call sites de
  `kickOffWateringConfigPush`), si la nouvelle espèce assignée a `tags & 256` et que le
  `wateringMode` courant n'est pas déjà `MANUAL`, forcer `Schedule.wateringMode = MANUAL` avant de
  déclencher le push — modifiable ensuite par l'utilisateur comme n'importe quel autre mode.
- **Bit 1 = cactus/succulente** (85/8070 espèces). **Pas de forçage automatique dans l'appli
  officielle** — vérifié dans le code, le flag ne change que le texte du message de statut
  ("après une période de sécheresse de {x}..." au lieu de "dans {x}..."), jamais le mode. Traité
  comme convenu précédemment : avertissement affiché dans le sélecteur de mode (section 3) si
  Perfect Drop ou Plant Sitter est sélectionné pour une espèce taguée cactus/succulente — texte à
  définir (ex. inspiré de l'esprit du message orchidée), sans forcer de changement.

## 5. Vue capteurs en direct

**Backend** — `subscribeLive()` (`node-ble/index.ts`) ouvre aujourd'hui uniquement le service `fa00`
(humidité/température/luminosité). Extension : ouvrir en plus le service `f900` (watering) dans la
même session live et s'abonner aux notifications de `f907` (niveau réservoir, déjà notify-capable
côté firmware, jamais utilisé en direct jusqu'ici). Même pattern que les 3 souscriptions existantes
(startNotifications + listener + flush debounce), un service GATT de plus ouvert par connexion, pas
de connexion supplémentaire.

**Frontend** — `LiveModeSection`'s `PARROT_METRICS` gagne le réservoir. Pas de fertilisant/conductivité
en direct — confirmé par la capture de l'appli officielle elle-même (*"non disponible en mode
live"*), le gauge conductivité existant dans les "Détails techniques" reste la seule vue pour cette
donnée, inchangé.

## 6. Unités d'affichage

- **Réservoir** : litres uniquement, partout (live, gauges "Détails techniques", pas de double
  affichage %) — `litres = percent / 100 * 2.2`. `format.ts`'s `isTankLow()` (actuellement `< 20`
  sur le %) devient `< 0.44` L (même seuil, juste reconverti) ou reste calculé sur le % en interne
  puis converti à l'affichage seulement — détail d'implémentation, pas un choix de design.
- **Humidité du sol** : %, inchangé.
- **Température** : °C, inchangé.
- **Lumière** : reste en DLI (mol/m²/jour) pour l'instant — **pas de conversion en lux/klux**. La
  caractéristique calibrée du pot ne renvoie pas de lux instantané (confirmé par une investigation
  déjà documentée dans ce projet) ; l'appli officielle affiche pourtant un gauge "live lux" distinct
  du DLI historique (capture `image-1787968228361.png`), ce qui suggère l'existence possible d'une
  autre caractéristique (candidate : `fa0a`, déjà notée ailleurs comme "light-reactive" et non
  utilisée sous son mapping actuel "température calibrée"). **Noté comme investigation séparée à
  mener plus tard, hors périmètre de cette feature** — voir la note de suivi ci-dessous.
- **Fertilisant/conductivité** : reste sur l'échelle actuelle dans les gauges "Détails techniques"
  (pas dans le live, section 5). Passer à une échelle 0.0–6.0 explicite n'est pas dans ce lot —
  pas demandé pour cette itération, à confirmer séparément si souhaité.

## Suivi hors périmètre

- **Investigation "live lux"** : déterminer si `fa0a` (actuellement mappé "température air
  calibrée") est en réalité un capteur de lumière réactif distinct de `fa0b` (DLI), en réexaminant
  les captures BLE existantes sous l'angle de la variation rapide en fonction de la lumière
  ambiante (par opposition à une valeur cumulative lente). Ne pas toucher au mapping actuel avant
  cette investigation.
- **Échelle fertilisant 0.0–6.0** : pas fait dans ce lot, à réévaluer séparément si DestCom le
  souhaite pour les gauges "Détails techniques" existants.

## Notes d'implémentation (pour le plan)

- Migration Prisma additive (nouvel enum + 4 colonnes nullables/défaut sur `Schedule`) —
  non-destructive, pas de backfill nécessaire.
- Tests unitaires pour `resolveWateringModeThresholds` (4 modes × cas limites : espèce sans eco,
  espèce sans aucune donnée Parrot, Custom sans espèce, Manuel sans espèce) — même rigueur que
  `wateringConfig.test.ts`'s vecteurs réels existants.
- Vérification mock provider (comme pour le fix checksum du même jour) avant tout test matériel réel
  — le pot 8733 reste le terrain de test dédié une fois la connexion stabilisée.
- Tests unitaires pour le forçage orchidée (section 4) : nouvelle espèce orchidée assignée sur un
  appareil en `PERFECT_DROP`/`PLANT_SITTER` → passe à `MANUAL` ; réassignation d'une espèce
  orchidée alors que `wateringMode` est déjà `MANUAL` → reste `MANUAL`, pas de re-déclenchement
  inutile ; espèce non-orchidée assignée → `wateringMode` inchangé, aucun forçage.
