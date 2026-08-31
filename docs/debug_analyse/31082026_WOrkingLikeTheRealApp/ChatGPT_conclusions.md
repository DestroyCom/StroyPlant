# Reverse engineering du protocole BLE du Parrot Pot — analyse approfondie des traces officielles

## Contexte

Je travaille sur un projet open-source personnel permettant d'interagir localement avec un **Parrot Pot / Flower Power** que je possède physiquement.

Le protocole BLE GATT du Parrot Pot est propriétaire et très peu documenté. J'ai capturé avec PacketLogger plusieurs sessions BLE réalisées avec **l'application officielle Parrot Flower Power**, notamment des configurations d'arrosage.

Les fichiers de traces sont disponibles ici :

```text
/mnt/data/13_full_flowerpower_app_workout.pklg
/mnt/data/00_baseline_connect.pklg
/mnt/data/01_watering_trigger.pklg
/mnt/data/03_mode_plant_sitter.pklg
/mnt/data/04_mode_manuel.pklg
```

### Objectif

Je veux comprendre précisément :

1. comment l'application officielle configure le watering ;
2. quelles caractéristiques `F9xx` sont réellement utilisées et dans quel ordre ;
3. si `F901` joue un rôle de validation/commit/version ;
4. ce qui permet à une configuration d'être réellement persistée en mémoire non volatile ;
5. pourquoi certaines de mes écritures indépendantes semblent parfois fonctionner en RAM mais ne pas survivre à une reconnexion ;
6. pourquoi certaines écritures, notamment `F908`, peuvent provoquer `ATT Error 0x04 Invalid PDU` ;
7. quelles parties du comportement peuvent être reproduites fidèlement dans mon propre client BLE.

---

# 1. Ce qui est déjà établi

## Services principaux

Préfixe UUID :

```text
39e1XXXX-84a8-11e2-afba-0002a5d5c51b
```

### Live service

```text
39e1FA00-84a8-11e2-afba-0002a5d5c51b
```

Les sources publiques et le code communautaire indiquent notamment :

```text
FA01 = luminosité
FA02 = soil EC
FA03 = soil temperature
FA04 = air temperature
FA05 = soil moisture
FA06 = live measurement period
FA07 = LED
FA08 = last movement
FA09 = calibrated soil VWC
FA0A = calibrated air temperature
FA0B = calibrated DLI / sunlight
FA0C = calibrated Ea
FA0D = calibrated Ecb
FA0E = calibrated EC porous
```

IMPORTANT :
Mon mapping initial était partiellement faux. Ne pas repartir du principe que `FA07/FA09/FA0A` sont respectivement humidité/température/lumière.

Sources :

- documentation BLE officielle Parrot Flower Power
- WatchFlower
- node-flower-power
- dump communautaire FHEM du Parrot Pot

---

# 2. Mapping actuel du watering service

Service :

```text
39e1F900-84a8-11e2-afba-0002a5d5c51b
```

Un dump communautaire de 2017 et mes captures officielles convergent vers :

```text
F901 = watering config ID
F902 = watering plant ID
F903 = watering VWC irrigation threshold
F904 = watering VWC command/target
F905 = watering N irrigation
F906 = watering command
F907 = watering tank level
F908 = watering pump duty cycle
F909 = inconnu
F90A = watering VWC irrigation ECO
F90B = watering VWC command ECO
F90C = watering N irrigation ECO
F90D = watering mode
F90E = watering time slot start
F90F = watering time slot duration
F910 = watering vacation start
F911 = watering vacation end
F912 = watering algorithm status
F913 = inconnu
```

La source communautaire qui documente ces noms :

https://forum.fhem.de/index.php?topic=68568.15

Ne transforme pas les champs encore incertains en certitudes.

---

# 3. Découverte très importante dans les PacketLogger officiels

Dans les captures officielles de configuration, l'application écrit pratiquement toujours les champs dans cet ordre :

```text
F902
F903
F904
F905
F90A
F90B
F90C
F90E
F90F
F910
F911
F90D
F901
```

Donc :

```text
F901 = DERNIER WRITE
```

Après chaque write, l'application reçoit un `Write Response`.

Les writes sont espacés d'environ ~60 ms dans certaines séquences.

Après `F901`, l'application effectue un **readback de la configuration**, notamment :

```text
READ F902
READ F903
READ F904
...
READ F90D
READ F901
```

Le readback confirme les valeurs attendues.

---

# 4. Observation importante sur F901

Dans les traces officielles, `F901` change entre des configurations très similaires.

Exemple observé :

```text
Plant Sitter:
F901 = AE07
```

puis :

```text
Mode manuel:
F901 = AF07
```

avec des paramètres de watering très proches.

Cela suggère potentiellement que `F901` n'est pas un simple paramètre utilisateur.

Hypothèses possibles :

```text
F901 = configuration ID
F901 = version de configuration
F901 = sequence number
F901 = identifiant permettant au firmware d'identifier une nouvelle configuration
F901 = champ déclenchant / finalisant la sauvegarde
```

IMPORTANT :
Ce sont des hypothèses.

Le dump FHEM le nomme officiellement `watering config id`, ce qui donne néanmoins beaucoup de poids à l'idée qu'il s'agit bien d'un identifiant/version de configuration.

---

# 5. Autre observation importante : F912

Le dump FHEM indique :

```text
F912 = watering algorithm status
```

alors que j'avais initialement supposé que `F90D` était à la fois le mode et l'état de l'algorithme.

Les traces montrent que `F90D` varie comme un mode utilisateur :

```text
F90D = 01
```

pour Plant Sitter

et :

```text
F90D = 00
```

pour Manuel.

Mais `F912` varie également selon l'état/configuration du dispositif.

Cela suggère probablement :

```text
F90D = mode utilisateur
F912 = état interne de l'algorithme / état de validation / statut
```

Il faut vérifier cette hypothèse dans les traces.

---

# 6. F906

Une découverte importante dans `01_watering_trigger.pklg` :

```text
WRITE F906 = 0A 00
```

avec un Write Response.

Donc `F906` n'est probablement pas simplement un booléen `01/00`.

La source communautaire l'appelle :

```text
watering cmd
```

Il faut déterminer :

- si `0A 00` correspond à une commande particulière ;
- si l'ordre des octets est little-endian ;
- si la valeur est un opcode, un délai, une quantité ou autre chose ;
- si la commande déclenche réellement la pompe ;
- ce qui se passe immédiatement avant/après ce write.

---

# 7. F908 et ATT error 0x04

Lors de mes essais indépendants, une écriture directe de :

```text
F908
```

m'a déjà donné une véritable erreur ATT :

```text
0x04 = Invalid PDU
```

Ce point doit être analysé séparément.

La source FHEM identifie :

```text
F908 = watering pump duty cycle
```

L'application officielle ne semble pas écrire normalement ce champ dans les séquences de configuration que j'ai capturées.

Questions :

- le firmware interdit-il volontairement certaines écritures directes ?
- la valeur envoyée avait-elle une mauvaise taille ?
- le problème vient-il du PDU GATT lui-même plutôt que de la valeur ?
- `F908` a-t-il des propriétés GATT différentes des autres champs ?
- le champ est-il destiné à une écriture interne ou à une séquence particulière ?

Ne suppose pas automatiquement que `0x04` signifie "mauvaise valeur".

---

# 8. Le problème principal de mon client indépendant

Lorsque j'écris certains paramètres `F9xx` depuis mon propre script BLE :

- l'ATT Write Response est parfois correct ;
- parfois la configuration semble correcte pendant la connexion ;
- mais après déconnexion/reconnexion, certains paramètres reviennent à leurs anciennes valeurs.

Cependant j'ai déjà observé au moins une séquence où le batch suivant a persisté correctement sur plusieurs cycles :

```text
F902
F903
F904
F905
F90A
F90B
F90C
F90E
F90F
F910
F911
F90D
F901
```

répété sur plusieurs reconnexions.

Cela suggère que le comportement n'est pas simplement :

```text
write => toujours persistant
```

ni :

```text
write => jamais persistant
```

Il peut dépendre de :

- l'ordre ;
- le timing ;
- la complétude de la configuration ;
- F901 ;
- F912 ;
- d'une condition interne ;
- d'un mécanisme RAM → NV différé.

---

# 9. Hypothèse actuelle la plus intéressante

Je veux que tu considères sérieusement cette architecture potentielle :

```text
                  F902
                  F903
                  F904
                  F905
                  F90A
                  F90B
                  F90C
                  F90E
                  F90F
                  F910
                  F911
                  F90D
                    │
                    ▼
             configuration RAM
                    │
                    │
                  F901
                    │
                    ▼
          validation / publication
                    │
                    ▼
                 NV/Flash
```

Cette hypothèse est cohérente avec :

- le fait que `F901` soit le dernier write ;
- son nom `watering config id` ;
- le readback immédiatement après ;
- le stockage persistant disponible sur les SoC TI de cette famille ;
- le fait qu'un ACK GATT ne garantisse pas conceptuellement que l'état applicatif est écrit en flash.

Mais encore une fois :
**ne considère pas cela comme démontré.**

Je veux que tu cherches des éléments dans les traces qui permettraient de confirmer ou d'infirmer cette théorie.

---

# 10. Hypothèse concernant le timing

Dans les captures officielles, les writes sont espacés.

Environ :

```text
WRITE
↓
WRITE RESPONSE
↓
~60 ms
↓
WRITE suivant
```

Cela pourrait simplement être le rythme de l'application.

Mais il faut tester l'hypothèse que le firmware a besoin d'un délai entre les mises à jour :

```text
F902 → attendre
F903 → attendre
...
F901 → attendre
```

Je veux particulièrement savoir si mes captures montrent :

- un délai minimum ;
- un pattern fixe ;
- des writes séquentiels obligatoires ;
- une réponse avant write suivant ;
- des notifications/interactions intercalées.

---

# 11. Ce que je veux que tu fasses avec les fichiers PacketLogger

Ne te contente pas de résumer les captures.

Fais une véritable analyse de protocole.

Pour chaque fichier :

```text
00_baseline_connect.pklg
01_watering_trigger.pklg
03_mode_plant_sitter.pklg
04_mode_manuel.pklg
13_full_flowerpower_app_workout.pklg
```

reconstruis autant que possible :

### Connexion

- découverte GATT ;
- services ;
- caractéristiques ;
- handles ATT ;
- propriétés ;
- MTU ;
- éventuel échange MTU ;
- éventuels notifications activées.

### Configuration

Pour chaque write :

```text
timestamp
handle
UUID
opcode ATT
payload hex
taille
Write Response
délai depuis le write précédent
```

### Readback

Identifier précisément :

```text
READ F901
READ F902
...
```

et les valeurs retournées.

### Notifications

Chercher les notifications :

- avant les writes ;
- pendant les writes ;
- après les writes ;
- juste avant la déconnexion.

### Erreurs

Lister toutes les erreurs ATT.

---

# 12. Recherche spécifique à effectuer dans les traces

Je veux des réponses précises à ces questions :

### Question A

`F901` est-il TOUJOURS le dernier write lors d'une modification complète ?

### Question B

Lorsque `F901` change, `F912` change-t-il aussi ?

### Question C

Après `F901`, y a-t-il une notification ou un read particulier qui ressemble à une confirmation ?

### Question D

La valeur de `F901` :

```text
progresse-t-elle ?
```

par exemple :

```text
AE07
AF07
B007
...
```

ou semble-t-elle arbitraire ?

### Question E

`F901` ressemble-t-il réellement à un compteur/version, et dans quel byte ?

### Question F

Y a-t-il une relation entre :

```text
F901
F902
F912
```

?

### Question G

L'application écrit-elle toujours tous les champs, ou uniquement ceux modifiés ?

### Question H

L'application officielle écrit-elle certains champs plusieurs fois ?

### Question I

Y a-t-il un délai constant entre chaque write ?

### Question J

Y a-t-il un délai particulier entre :

```text
F90D
F901
```

?

### Question K

Le readback commence-t-il systématiquement immédiatement après `F901` ?

### Question L

Y a-t-il une différence de séquence entre :

```text
Plant Sitter
Manuel
Watering trigger
```

?

---

# 13. Comparaison avec le stockage NV TI

Je veux que tu vérifies les hypothèses contre la documentation TI correspondant aux familles potentiellement utilisées par le Pot.

Nous avons trouvé des références au mécanisme SNV/NV des SoC TI permettant de stocker des paramètres persistants.

La question n'est PAS :

> "Est-ce que l'OAD est transactionnel ?"

La bonne question est :

> "Une application TI typique pourrait-elle garder une configuration GATT en RAM puis la synchroniser en NV uniquement lorsque certaines conditions sont remplies ?"

Et surtout :

> "Existe-t-il dans la documentation TI des contraintes concernant les écritures NV répétées, la compaction ou les moments où une écriture peut être refusée/différée ?"

Ne mélange pas le protocole OAD et le stockage applicatif SNV.

---

# 14. Comparaison avec les projets open source

Consulte également :

### WatchFlower

https://github.com/emericg/WatchFlower

Particulièrement :

```text
devices/device_parrotpot.cpp
devices/device_parrotpot.h
```

Cherche tout ce qui concerne :

- watering ;
- F9xx ;
- F901 ;
- F902 ;
- F912 ;
- F908 ;
- pump ;
- configuration.

WatchFlower documente aujourd'hui le Parrot Pot mais indique que l'arrosage automatique n'est pas vraiment supporté.

### node-flower-power

https://github.com/sandeepmistry/node-flower-power

Utile surtout pour comparer le protocole Flower Power classique / Live.

### Parrot-Developers

https://github.com/Parrot-Developers

Cherche les dépôts liés à :

- Flower Power ;
- Pot ;
- H2 / Hydrogen ;
- BLE ;
- firmware ;
- SDK.

---

# 15. Ce que je ne veux PAS

Ne fais pas :

```text
"F901 doit être un commit"
```

sans preuve.

Ne fais pas :

```text
"TI SNV est transactionnel donc Parrot fait pareil"
```

sans preuve.

Ne transforme pas les noms issus d'un dump communautaire en vérité absolue.

Sépare toujours :

```text
FACT
```

de :

```text
HYPOTHESIS
```

et :

```text
OPEN QUESTION
```

---

# 16. Résultat attendu

Je veux produire une compréhension suffisamment solide pour implémenter ensuite un client BLE fiable.

Le résultat idéal serait un modèle du genre :

```text
CONNECT
   ↓
DISCOVER
   ↓
READ CURRENT CONFIG
   ↓
WRITE F902
   ↓
WAIT RESPONSE
   ↓
WRITE F903
   ↓
...
   ↓
WRITE F90D
   ↓
WRITE F901
   ↓
WAIT
   ↓
READBACK
   ↓
VERIFY
   ↓
DISCONNECT
```

ou découvrir que ce modèle est faux.

Je veux particulièrement savoir si le protocole comporte une notion implicite de :

```text
transaction
commit
version
config ID
state machine
```

---

# 17. Dernier point : analyse les différences entre client officiel et client indépendant

À terme je veux une réponse à :

> "Qu'est-ce que l'application officielle fait que mon script ne fait probablement pas ?"

Compare notamment :

```text
ordre
timing
reads
writes
notifications
F901
F912
déconnexion
```

et tout autre échange supplémentaire.

Le but n'est pas uniquement de reproduire les valeurs :
le but est de reproduire **la séquence protocolaire correcte**.

---

## Priorité absolue

Commence par analyser les PacketLogger.

Ne code rien pour l'instant.

Commence par produire :

1. une timeline précise de chaque session ;
2. un tableau des writes/reads F9xx ;
3. les différences entre Plant Sitter / Manuel / watering trigger ;
4. les valeurs de F901/F912 ;
5. les timings ;
6. les hypothèses sur le mécanisme de persistance ;
7. les expériences minimales à réaliser pour confirmer ou réfuter ces hypothèses.

Ensuite seulement, proposer une implémentation.
