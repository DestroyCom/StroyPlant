# Parrot Pot — protocole BLE : état des lieux et plan de travail

Passation pour Claude Code. Contexte : rétro-ingénierie légitime du protocole BLE GATT
d'un Parrot Pot (produit discontinué, matériel possédé physiquement), pour intégration
dans le projet personnel StroyPlant. Objectif final : piloter l'arrosage et la config
depuis Node.js/TypeScript sans l'appli officielle.

Tout ce qui suit vient de l'analyse de 8 captures Apple PacketLogger d'échanges réels
entre l'appli officielle « Flower Power » (iOS, tournant sur macOS 26.6.2, Mac15,13) et
le pot. Chaque affirmation est marquée **CONFIRMÉ** (observé dans les traces),
**PROBABLE** (une seule observation ou déduction forte) ou **HYPOTHÈSE** (à tester).

---

## 1. Identité du matériel — CONFIRMÉ

Lu sur les caractéristiques Device Information (service 0x180A) :

| Champ                      | Handle | Valeur                                       |
| -------------------------- | ------ | -------------------------------------------- |
| Serial number (0x2A25)     | 0x0016 | `PI040367AB6I007904`                         |
| Firmware revision (0x2A26) | 0x0018 | `2016-07-08_hawaii2-0.29.1_kauai-protoB`     |
| Hardware revision (0x2A27) | 0x001A | `2014-12-09_dev-kauai-protoA_kauai-protoA`   |
| Device name                | —      | `Parrot pot a3d3` (4 derniers hex de la MAC) |

`hawaii2` = branche firmware 2.x (héritée du Flower Power, dont les firmwares
s'appellent `hawaii-x.y.z`). `kauai` = nom de code matériel du Pot. Les deux
cohabitent dans la même chaîne : ce ne sont pas deux appareils différents.

MTU négocié : requête 0x00b9 (185), réponse 0x0017 (**23 octets**). Le pot reste en
MTU minimal — tout ce qui dépasse 20 octets utiles passe par `READ_BLOB`.

---

## 2. Table handle → UUID complète — CONFIRMÉ

Reconstruite depuis la découverte GATT intégrale (`READ_BY_GRP_TYPE` + `READ_BY_TYPE`

- `FIND_INFORMATION`). **Ne jamais mapper par ordre de handle** : le service `fd8x`
  déclare ses UUID dans le désordre.

### Services

| Plage handles | UUID                                            |
| ------------- | ----------------------------------------------- |
| 0x0001–0x000b | 0x1800 Generic Access                           |
| 0x000c–0x000f | 0x1801 Generic Attribute                        |
| 0x0010–0x0022 | 0x180a Device Information                       |
| 0x0023–0x0048 | `39e1fa00` Live                                 |
| 0x0049–0x004c | 0x180f Battery                                  |
| 0x004d–0x005b | `39e1fc00` History                              |
| 0x005c–0x0066 | `39e1fb00` Upload                               |
| 0x0067–0x006b | `39e1fd00` Clock                                |
| 0x006c–0x0076 | `39e1fe00` Calibration                          |
| 0x0077–0x009d | `39e1f900` Watering                             |
| 0x009e–0x00b4 | `39e1fd80` (« Plant Dr »)                       |
| 0x00b5–0xffff | `f000ffc0-0451-4000-b000-000000000000` OAD (TI) |

Préfixe des UUID 128 bits : `39e1XXXX-84a8-11e2-afba-0002a5d5c51b`.

### Caractéristiques

Props : R=read, W=write, N=notify, I=indicate.

| Handle | UUID   | Props | Rôle                                           |
| ------ | ------ | ----- | ---------------------------------------------- |
| 0x0025 | `fa01` | R,N   | sunlight brut                                  |
| 0x0028 | `fa0f` | R,N   | **non documenté**                              |
| 0x002b | `fa10` | R,N   | **non documenté**                              |
| 0x002e | `fa11` | R,N   | **non documenté**                              |
| 0x0031 | `fa02` | R,N   | soil EC brut (uint16)                          |
| 0x0034 | `fa03` | R,N   | soil temp brut                                 |
| 0x0037 | `fa04` | R,N   | air temp brut                                  |
| 0x003a | `fa05` | R,N   | soil VWC brut                                  |
| 0x003d | `fa06` | R,W   | live measure period (écrire 1 pour activer)    |
| 0x003f | `fa07` | R,W   | **état LED** (pas l'humidité !)                |
| 0x0041 | `fa09` | R,N   | **VWC calibré, float32 LE**                    |
| 0x0044 | `fa0a` | R,N   | **température air calibrée, float32 LE**       |
| 0x0047 | `fa0b` | R,N   | **lumière calibrée, float32 LE**               |
| 0x004b | 0x2a19 | R,N   | niveau batterie (%)                            |
| 0x004f | `fc01` | R     | nb entrées historique                          |
| 0x0051 | `fc02` | R     | index dernière entrée                          |
| 0x0053 | `fc03` | R,W   | transfer start index                           |
| 0x0055 | `fc04` | R     | current session ID                             |
| 0x0057 | `fc05` | R     | current session start index                    |
| 0x0059 | `fc06` | R     | current session period                         |
| 0x005b | `fc07` | R     | **non documenté**                              |
| 0x005e | `fb01` | N     | Tx buffer (20 o)                               |
| 0x0061 | `fb02` | R,N   | Tx status                                      |
| 0x0064 | `fb03` | R,W   | Rx status                                      |
| 0x0066 | `fb04` | R,W   | **non documenté**                              |
| 0x0069 | `fd01` | R     | uptime en secondes (uint32 LE)                 |
| 0x006b | `fd02` | R,W   | **horloge murale UTC, epoch Unix uint32 LE**   |
| 0x0079 | `f901` | R,W   | **checksum XOR-16 de la config** (voir §3)     |
| 0x007b | `f902` | R,W   | uint16 — inconnu                               |
| 0x007d | `f903` | R,W   | seuil de déclenchement, VWC ×10                |
| 0x007f | `f904` | R,W   | cible d'arrosage, VWC ×10                      |
| 0x0081 | `f905` | R,W   | uint16 — non nul en mode custom uniquement     |
| 0x0083 | `f90a` | R,W   | uint16 — inconnu (toujours 0 observé)          |
| 0x0085 | `f90b` | R,W   | uint16 — inconnu (toujours 0 observé)          |
| 0x0087 | `f90c` | R,W   | uint16 — inconnu (toujours 0 observé)          |
| 0x0089 | `f906` | W     | **déclencheur arrosage manuel**                |
| 0x008b | `f907` | R,N   | niveau réservoir en % (uint8)                  |
| 0x008e | `f908` | R,W   | inconnu — jamais touché par l'appli            |
| 0x0090 | `f90d` | R,W   | **mode d'arrosage** (uint8)                    |
| 0x0092 | `f90e` | R,W   | uint16 — durée en minutes ?                    |
| 0x0094 | `f90f` | R,W   | uint16 — durée en minutes ?                    |
| 0x0096 | `f910` | R,W   | uint32 — inconnu (toujours 0 observé)          |
| 0x0098 | `f911` | R,W   | uint32 — inconnu (toujours 0 observé)          |
| 0x009a | `f912` | R,W   | **statut algorithme d'arrosage** (uint8)       |
| 0x009c | `f913` | R,N   | inconnu — jamais lu ni notifié dans les traces |
| 0x00a0 | `fd81` | R,W   | uint16                                         |
| 0x00a2 | `fd85` | R,W   | uint16                                         |
| 0x00a4 | `fd84` | R,W   | uint16                                         |
| 0x00a6 | `fd83` | R,W   | uint16                                         |
| 0x00a8 | `fd82` | R,W   | uint16                                         |
| 0x00aa | `fd86` | R,N   | uint8 — flag d'événement                       |
| 0x00ad | `fd87` | R,N   | uint32                                         |
| 0x00b0 | `fd88` | R,N   | uint32                                         |
| 0x00b3 | `fd89` | R,N   | uint32                                         |

CCCD (0x2902) associés : 0x0042 (fa09), 0x0045 (fa0a), 0x0048 (fa0b), 0x004c (batt),
0x005f (fb01), 0x0062 (fb02), 0x008c (f907), 0x00ab (fd86), 0x00ae (fd87),
0x00b1 (fd88), 0x00b4 → en fait 0x00b1 pour fd88, et le CCCD de fd89 n'a pas été
observé (l'appli écrit `0100` sur 0x00b1 puis lit 0x00b3 directement).

---

## 3. LA découverte principale : `f901` est un checksum XOR-16 — CONFIRMÉ

C'est la clé du bug de persistance qui bloquait le projet.

L'appli officielle écrit **toujours** la config comme un batch de 13 écritures dans
cet ordre exact, avec `f901` **en dernier** :

```
f902, f903, f904, f905, f90a, f90b, f90c, f90e, f90f, f910, f911, f90d, → f901
```

`f901` n'est pas un champ de configuration. C'est le **XOR sur mots de 16 bits
little-endian de tous les autres champs du batch**.

Vérifié sur 6 captures indépendantes, 6/6 exact :

| Capture      | f902   | f903   | f904   | f905   | f90f   | f90d | f901 écrit | XOR calculé |
| ------------ | ------ | ------ | ------ | ------ | ------ | ---- | ---------- | ----------- |
| perfect_drop | 0x024b | 0x0140 | 0x017c | 0x0000 | 0x05a0 | 0x01 | `0x07d6`   | `0x07d6` ✓  |
| plant_sitter | 0x024b | 0x0104 | 0x0140 | 0x0000 | 0x05a0 | 0x01 | `0x07ae`   | `0x07ae` ✓  |
| manuel       | 0x024b | 0x0104 | 0x0140 | 0x0000 | 0x05a0 | 0x00 | `0x07af`   | `0x07af` ✓  |
| custom       | 0x024b | 0x012c | 0x0190 | 0x0030 | 0x05a0 | 0x01 | `0x0766`   | `0x0766` ✓  |
| live         | 0x024b | 0x0140 | 0x017c | 0x0000 | 0x05a0 | 0x01 | `0x07d6`   | `0x07d6` ✓  |
| workout      | 0x0000 | 0x0140 | 0x017c | 0x0000 | 0x05a0 | 0x01 | `0x059d`   | `0x059d` ✓  |

(`f90a`, `f90b`, `f90c`, `f910`, `f911` valaient 0 partout, d'où leur absence du tableau.)

Implémentation de référence :

```ts
const CFG_ORDER = [
  "f902",
  "f903",
  "f904",
  "f905",
  "f90a",
  "f90b",
  "f90c",
  "f90e",
  "f90f",
  "f910",
  "f911",
  "f90d",
] as const;

/** XOR-16 LE sur la concaténation des champs, dans l'ordre CFG_ORDER. */
export function computeF901(fields: Record<string, Buffer>): number {
  let x = 0;
  for (const key of CFG_ORDER) {
    let b = fields[key];
    if (b.length % 2 !== 0) b = Buffer.concat([b, Buffer.from([0x00])]);
    for (let i = 0; i < b.length; i += 2) x ^= b.readUInt16LE(i);
  }
  return x & 0xffff;
}
```

**Explication du bug de persistance** — HYPOTHÈSE forte, à falsifier :
une écriture isolée sur `f903` (ou tout autre champ) reçoit un ATT Write Response
propre parce que la valeur atterrit en RAM. Mais le firmware valide le checksum
au moment du commit en flash NV (ou au reboot) ; `f901` étant devenu incohérent,
le bloc entier est rejeté et l'ancienne config est restaurée. Le batch de 13 champs
persistait parce qu'il reproduisait la séquence de l'appli, `f901` correct inclus.
Ni le timing de déconnexion ni la compaction SNV du stack TI n'y sont pour quelque chose.

**Détail non prouvé** : `f910` et `f911` font 4 octets et valaient 0 dans toutes les
traces. Le repliement en deux mots de 16 bits est déduit de la structure, pas observé.
De même `f90d` fait 1 octet et son zéro-padding en 16 bits est déduit (mais fortement
supporté : `manuel` vs `plant_sitter` ne diffèrent que par `f90d` 0x01→0x00 et
`f901` change de `0x07ae`→`0x07af`, soit exactement 1 bit).

---

## 4. Sémantique des champs

### `f903` / `f904` — CONFIRMÉ

Seuil de déclenchement et cible, en **dixièmes de pourcent de VWC** (pas en pourcent).

| Mode appli   | f903 | f904 | Interprétation                      |
| ------------ | ---- | ---- | ----------------------------------- |
| Perfect Drop | 320  | 380  | déclenche à 32,0 %, vise 38,0 %     |
| Plant Sitter | 260  | 320  | déclenche à 26,0 %, vise 32,0 %     |
| Manuel       | 260  | 320  | idem (mode off, valeurs conservées) |
| Custom       | 300  | 400  | déclenche à 30,0 %, vise 40,0 %     |

### `f90d` — mode d'arrosage — CONFIRMÉ partiellement

`0x00` en mode Manuel, `0x01` en Perfect Drop / Plant Sitter / Custom. La valeur `0x02`
(« Vacation » selon homebridge-parrot-flower) n'apparaît dans aucune capture.

Attention : les modes de l'appli (Perfect Drop / Plant Sitter / Custom) ne sont **pas**
encodés dans `f90d` — ils partagent tous `f90d=1` et ne se distinguent que par les
seuils. `f90d` n'est donc qu'un booléen auto/manuel, plus éventuellement le mode vacances.

### `f905` — PROBABLE

Vaut 0 sauf en mode Custom où il vaut `0x0030` = 48. Si l'unité est le quart d'heure,
48 × 15 min = 12 h, ce qui correspond à un réglage de fréquence. Un seul point de mesure,
donc non tranché.

### `f90e` / `f90f` — PROBABLE

Sur ce pot : `f90e`=0, `f90f`=0x05a0 (1440). Sur un **second pot** apparaissant dans
`13_full_flowerpower_app_workout.pklg` : `f90e`=0x04b0 (1200), `f90f`=0x0168 (360).
1440 min = 24 h, 360 min = 6 h, 1200 min = 20 h. Des durées en minutes, très
probablement une fenêtre horaire ou un intervalle minimal entre arrosages.
**Correction d'une croyance antérieure** : la « constante 1440 » était attribuée à
`f90e`, c'est `f90f`, et ce n'est pas une constante.

### `f906` — déclencheur d'arrosage manuel — CONFIRMÉ

L'appli écrit **uint16 LE `0x000A`** (octets `0a 00`), observé 3 fois (1 fois dans
`01_watering_trigger`, 2 fois dans le workout). WatchFlower et homebridge-parrot-flower
écrivent tous les deux `0x0008`.

Effet mesuré dans `01_watering_trigger` : écriture à t=4,53 s, ACK à 4,59 s. Puis
`f907` (réservoir) passe de 0x64 (100 %) à 0x5e (94 %) vers t=15 s, et `fa09` (VWC
calibré) monte nettement à partir de t≈12 s.

**HYPOTHÈSE** : `f906` est un volume ou une durée, pas un magic number — d'où le fait
que 8 et 10 fonctionnent tous les deux. À vérifier en écrivant 1, 5, 20, 50 et en
mesurant la chute de `f907`.

### `f912` — statut algorithme — PARTIELLEMENT INFIRMÉ

homebridge-parrot-flower documente une énumération 0–6
(`Initializing / Ready / Watering / Error: No water / Error: In Air / Error: VWC Still /
Error: Internal`). Les traces montrent `0x01`, `0x02`, `0x04` et **`0x09`** selon les pots.
La valeur 0x09 sort de l'énumération : elle est incomplète ou fausse. Peut-être un champ
de bits plutôt qu'un enum.

### Service `fd80` — HYPOTHÈSE

Valeurs lues sur ce pot : `fd81`=756, `fd85`=660, `fd84`=288, `fd83`=320, `fd82`=0,
`fd86`=0, `fd87`/`fd88`/`fd89`=0.

`fd83` = 320 est **exactement** égal à `f903`. Hypothèse : `fd8x` contient les bornes
issues de la fiche botanique de l'espèce sélectionnée, et `f90x` la config effective
dérivée. Sur le second pot du workout : `fd81`=78, `fd85`=225, `fd84`=0, `fd83`=175,
`fd86`=9 — et ce pot a `f903`=175. **La corrélation `fd83 == f903` tient sur les deux
pots**, ce qui renforce nettement l'hypothèse.

`fd86` a émis une **notification `0x01` à t=70,4 s** dans le workout, juste après un
déclenchement d'arrosage : c'est un flag d'événement, pas une donnée statique.

### Advertisement — CONFIRMÉ par recoupement (pas présent dans ces traces)

Le manufacturer-data fait **5 octets**, pas 3. Si ton stack BLE strippe les 2 octets de
company ID (0x0043 Parrot), il te reste :

```
[0] data version
[1] type (nibble bas) | couleur (nibble haut)
[2] flags de statut  ← bitmask, PAS un compteur qui décroît
```

Flags : `0x01` unread entries · `0x02` moved · `0x04` started · `0x08` low water tank ·
`0x10` low battery · `0x20` watering needed. Les flags sont effacés par les lectures
correspondantes (last-move-date, sync historique), d'où l'illusion d'une décroissance
temporelle. Source : `src/parrot/Pot.js` de `antoineraulin/homebridge-parrot-flower`.

---

## 5. Séquence de connexion de l'appli officielle — CONFIRMÉ

Utile comme modèle de référence. Depuis `00_baseline_connect.pklg` :

1. `MTU_REQ` 185 → réponse 23
2. Découverte GATT complète (services puis caractéristiques puis descripteurs)
3. Écriture CCCD 0x000f = `0200` (indications Service Changed)
4. Lecture des 13 champs de config `f9xx`
5. CCCD `f907` (0x008c) = `0100`
6. Lecture du bloc `fd8x` + CCCD sur `fd86`, `fd87`, `fd88`
7. CCCD sur `fa09`, `fa0a`, `fa0b` (0x0042, 0x0045, 0x0048) = `0100`
8. **`fa06` (0x003d) = `01`** → active les mesures live à 1 Hz
9. CCCD batterie (0x004c) = `0100`, lecture batterie
10. Lecture `fd01` (uptime) et `fd02` (epoch UTC)
11. Device Info (serial via `READ_BLOB`, firmware, hardware)
12. Historique : lecture `fc01`/`fc02`/`fc04`/`fc05`/`fc06`, CCCD sur `fb01`/`fb02`,
    écriture `fc03` = index de départ, puis `fb03`=`01` (receiving) →
    notifications sur `fb01` → `fb02` passe 01→02 → `fb03`=`02` (ack) → `fb02`=00

Après une modification de config, l'appli **relit systématiquement les 13 champs** pour
valider. Elle ne se déconnecte jamais immédiatement : les notifications live continuent.

---

## 6. Ce qu'il faut faire — par ordre de priorité

### T1 — Falsifier l'hypothèse du checksum (bloquant, 30 min)

C'est l'expérience décisive. Sans elle, tout le reste repose sur une corrélation.

Trois cycles, chacun suivi d'une déconnexion franche, d'une attente de 30 s et d'une
reconnexion avec relecture des 13 champs :

- **A** — écrire `f903` seul, ne pas toucher `f901`. Attendu : revert.
- **B** — écrire `f903` seul puis `f901` = XOR recalculé. Attendu : persiste.
- **C** — écrire les 13 champs dans l'ordre avec un `f901` volontairement faux
  (XOR correct XOR 0x0001). Attendu : revert.

Si A revert et B persiste, l'hypothèse est validée et on peut écrire la config
proprement. Si C persiste aussi, alors ce n'est pas le checksum qui décide mais
la présence du write sur `f901` (sentinelle de commit) — ce qui change l'implémentation.

Logguer chaque cycle avec `btmon -w` pour avoir la trace en cas de surprise.

### T2 — Déterminer le repliement de `f910`/`f911` dans le checksum (15 min)

Écrire `f910` = `0x01020304` avec le reste inchangé, calculer `f901` selon les deux
hypothèses (deux mots de 16 bits LE vs autre repliement), tester laquelle persiste.
Idem pour `f90d` avec une valeur > 0xFF impossible — donc juste confirmer le padding
en écrivant `f90d`=0x02 et en vérifiant que `f901` doit changer de 0x0002.

### T3 — Sémantique de `f906` (20 min)

Écrire successivement 1, 5, 10, 20, 50 en laissant le réservoir se stabiliser entre
chaque, et relever le delta de `f907` et la durée pendant laquelle `f912` vaut 0x02
(Watering). Si le delta est proportionnel, `f906` est un volume ou une durée — établir
l'unité. Ne pas descendre le réservoir sous 20 % pendant les tests.

### T4 — Cartographier `f912` (30 min)

Provoquer chaque condition et relever la valeur : réservoir vide (retirer l'eau),
pot hors sol (« in air »), arrosage en cours, état nominal. Vérifier si `0x09` est
`0x08 | 0x01` — c'est-à-dire si c'est un champ de bits et non un enum.

### T5 — Confirmer l'hypothèse `fd8x` = fiche botanique (nécessite l'appli officielle)

Une capture PacketLogger pendant un **changement d'espèce de plante** dans l'appli
(pas un changement de mode). Vérifier si `fd81`–`fd85` bougent, et si `f903` suit `fd83`.
C'est le dernier gros bloc non élucidé et il ne se résout pas sans l'appli.

### T6 — Livrable : client TypeScript

Une fois T1 tranché, produire dans le projet StroyPlant :

- une table `characteristics.ts` reprenant §2 (UUID, pas handles — les handles sont
  stables sur ce firmware mais rien ne le garantit entre révisions)
- `computeF901()` avec tests unitaires sur les 6 vecteurs du tableau §3
- `writeConfig(fields)` qui applique l'ordre CFG_ORDER, calcule `f901`, l'écrit en
  dernier, puis relit les 13 champs et lève si un seul diffère
- `waterNow(amount)` sur `f906`
- décodage `fa09`/`fa0a`/`fa0b` en float32 LE, `f907` en uint8 %, `fd02` en epoch

---

## 7. Questions ouvertes

1. `f902` vaut 0x024b (587) sur ce pot et 0x0000 sur un autre. Quel réglage de l'appli
   le fait bouger ? Il n'a changé dans aucune de mes captures.
2. `f90a`, `f90b`, `f90c`, `f910`, `f911` sont écrits à zéro dans toutes les captures.
   Existe-t-il un réglage qui les rend non nuls, ou sont-ils réservés/morts ?
3. `f908` n'est jamais touché par l'appli officielle. Une écriture 1 octet dessus avait
   précédemment renvoyé une erreur ATT `0x04 Invalid PDU` (et non `0x0D Invalid Attribute
Value Length`). Tester des longueurs de 2 et 4 octets.
4. `f913` (R,N) n'est ni lu ni notifié dans aucune capture. Le lire directement.
5. `fa0f`, `fa10`, `fa11`, `fb04`, `fc07` sont présents mais jamais utilisés par l'appli.
   Les lire et voir si les valeurs ressemblent à des float32 ou des compteurs.
6. `fd02` est en écriture. Le pot accepte-t-il un resynchronisation d'horloge ? Utile
   pour aligner l'historique sans passer par le cloud mort.
7. Le mode « Vacation » (`f90d`=0x02) existe-t-il vraiment sur ce firmware ?

---

## 8. Outillage : parser PacketLogger

Le format des `.pklg` fournis est : `uint32 LE longueur` (du reste de l'enregistrement),
`uint32 LE secondes epoch`, `uint32 LE microsecondes`, `uint8 type`, puis payload.
Types observés : 0x00 commande HCI, 0x01 événement HCI, 0x02 ACL envoyé,
0x03 ACL reçu, 0xfc et 0xfd notes système.

Attention : un même fichier peut contenir **plusieurs connexions simultanées**
(le workout mélange trois pots). Toujours désentrelacer par handle de connexion ACL
(12 bits de poids faible du premier uint16 du paquet ACL) avant d'interpréter quoi que ce soit.

```python
import struct

def records(path):
    d = open(path, 'rb').read(); i = 0
    while i + 4 <= len(d):
        (ln,) = struct.unpack_from('<I', d, i)
        if ln < 9 or i + 4 + ln > len(d): break
        sec, usec = struct.unpack_from('<II', d, i + 4)
        yield sec + usec / 1e6, d[i + 12], d[i + 13:i + 4 + ln]
        i += 4 + ln

def att_pdus(path):
    """Rend (ts, conn_handle, 'TX'|'RX', pdu_att). Réassemble les fragments L2CAP."""
    frag = {}
    for ts, typ, p in records(path):
        if typ not in (2, 3) or len(p) < 4: continue
        h, tl = struct.unpack_from('<HH', p, 0)
        conn = h & 0x0fff; pb = (h >> 12) & 3
        data = p[4:4 + tl]; key = (conn, typ)
        buf = (frag.get(key, b'') + data) if pb == 1 else data
        frag[key] = buf
        if len(buf) < 4: continue
        l2len, cid = struct.unpack_from('<HH', buf, 0)
        if cid != 4 or len(buf) - 4 < l2len: continue
        frag.pop(key, None)
        yield ts, conn, ('TX' if typ == 2 else 'RX'), buf[4:4 + l2len]
```

Opcodes ATT utiles : 0x0a READ_REQ, 0x0b READ_RSP, 0x0c/0x0d READ_BLOB,
0x12 WRITE_REQ, 0x13 WRITE_RSP, 0x1b NOTIFY, 0x08/0x09 READ_BY_TYPE,
0x10/0x11 READ_BY_GROUP_TYPE, 0x04/0x05 FIND_INFORMATION, 0x01 ERROR_RSP.

---

## 9. Sources externes utiles

- Spec BLE officielle Flower Power (le **capteur**, pas le pot, mais le service `fa00`
  et le protocole d'upload sont communs) :
  `https://developer.parrot.com/docs/FlowerPower/FlowerPower-BLE.pdf`
- `github.com/emericg/WatchFlower` → `docs/parrotpot-ble-api.md` et
  `src/devices/device_parrotpot.cpp` (déclenche l'arrosage avec `0800`)
- `github.com/antoineraulin/homebridge-parrot-flower` → `src/parrot/Pot.js`
  (décodage advertisement), `src/parrot/RetrieveWateringStatusTask.js`
  (énumérations mode et statut), `src/parrot/WaterPlantTask.js`
- `github.com/Parrot-Developers/node-flower-bridge` → `lib/TaskFP.js`, noms des champs
  officiels côté cloud (`watering_mode`, `watering_algorithm_status`,
  `next_watering_date`, `next_empty_tank_date`, `full_tank_autonomy`)

Aucune de ces sources ne documente `f901` comme checksum. Aucune ne mentionne le bug
de persistance. C'est une découverte originale de ce projet — si elle se confirme en T1,
elle mérite une issue sur WatchFlower.

---

## 10. Contraintes

- Ne jamais laisser le réservoir descendre sous ~20 % pendant les campagnes de test.
- Le pot se déconnecte tout seul après environ 1 s sans requête BLE entrante. Prévoir
  un keep-alive (une lecture périodique) si une séquence doit rester ouverte.
- Le MTU est de 23 octets : tout ce qui dépasse 20 octets utiles passe par READ_BLOB.
- Ne pas toucher au service OAD (`f000ffc0`). Une écriture malencontreuse sur les
  caractéristiques d'image firmware peut briquer le pot, et il n'y a plus de serveur
  Parrot pour récupérer un firmware.
