# Prompt à copier-coller dans d'autres IA (ChatGPT, Gemini, Perplexity, etc.)

Je fais de la rétro-ingénierie légitime du protocole Bluetooth LE d'un capteur de plante
"Parrot Pot" / "Flower Power" (Parrot SA, société française, produit discontinué) que je
possède physiquement. C'est pour un projet domotique personnel, pas commercial, pas une
attaque — je cherche juste à documenter un protocole BLE propriétaire non documenté pour
interopérer avec mon propre matériel.

## Ce que je sais déjà (base de départ, ne pas re-chercher)

Le pot expose plusieurs services GATT custom en 128-bit, tous avec le même préfixe UUID
`39e1XXXX-84a8-11e2-afba-0002a5d5c51b` (seuls les 4 chiffres hex XXXX changent) :

- **`39e1FAxx`** — service "Live" : humidité du sol (`fa07`), température (`fa09`), une
  caractéristique qui réagit à la lumière mais dont le rôle exact n'est pas confirmé (`fa0a`),
  conductivité du sol brute (`fa02`), un flag d'activation (`fa06`).
- **`39e1F9xx`** — service "config arrosage" : `f901` à `f913` (13+ champs). Confirmés :
  seuil de déclenchement en % (`f903`), cible en % (`f904`), délai en unités de 15 min
  (`f905`), déclencheur d'arrosage manuel (`f906`), niveau du réservoir (`f907`), flag
  "mode/algo actif" (`f90d`). **Jamais élucidés** : `f901`, `f902`, `f90a`, `f90b`, `f90c`,
  `f90e` (constante ~1440 observée), `f90f`, `f910`, `f911`, et `f913` (jamais vu écrit ni
  lu par personne, même pas par l'appli officielle).
- **`39e1FD8x`** — service "Plant Dr" : points de calibration humidité sèche/humide, un
  champ de checksum XOR.
- **`f000ffc0-0451-4000-b000-000000000000`** — un service OAD (Over-the-Air Download,
  mise à jour firmware) de Texas Instruments, ce qui indique que la puce BLE de cet
  appareil est très probablement une **TI CC254x ou CC2640 (famille SimpleLink)**.
- Des chaînes de firmware internes lues sur le vrai matériel : numéro de série au format
  `PI04XXXXXXXXXXX`, et des noms de code internes **"hawaii2"** et **"kauai-protoA"**.
- Advertisement BLE : Company ID Bluetooth SIG `0x0043` (Parrot), payload manufacturer-data
  de 3 octets, format observé `01 23 XX` où XX varie dans le temps (valeurs vues : `0x00`,
  `0x01`, `0x20`, `0x21`, `0x23`) — semble décroître avec le temps depuis la dernière
  activité BLE (connexion/écriture), mais le lien avec un état "arrosage en cours" n'est
  pas confirmé (un appareil qui n'a jamais arrosé montre la même décroissance).

## Le mystère principal

Écrire plusieurs champs du service `39e1F9xx` (seuils d'arrosage dérivés de l'espèce de
plante) depuis un script indépendant (pas l'appli officielle) semble parfois ne pas
persister après une déconnexion/reconnexion BLE, même quand l'écriture reçoit un ATT Write
Response propre (pas d'erreur). L'appli officielle "Flower Power", elle, persiste toujours
ses écritures. Pas de pairing/bonding (Security Manager Protocol) impliqué — le firmware
accepte les écritures non authentifiées. On a des indices contradictoires : dans une
capture, un batch complet de 13 champs (dans l'ordre `f902,f903,f904,f905,f90a,f90b,f90c,
f90e,f90f,f910,f911,f90d,f901`) A PERSISTÉ correctement sur 4 cycles écriture/reconnexion
successifs. Dans une autre capture, une écriture d'un seul champ (`f908`, un octet) a reçu
une **vraie erreur ATT "Invalid PDU" (code 0x04)** — pas un revert silencieux comme on le
pensait initialement.

## Ce que je veux que tu cherches (cite tes sources, une URL par affirmation)

1. **Toute rétro-ingénierie existante du protocole BLE GATT du Parrot Pot / Flower Power**
   par des tiers — dépôts GitHub, gists, articles de blog, forums (communauté Home
   Assistant, XDA, Hackaday, reddit, forums français puisque Parrot est une entreprise
   française), papers académiques, ou analyses de décompilation de l'appli officielle
   Android/iOS "Flower Power" / "Parrot Flower Power". Cherche spécifiquement si quelqu'un
   a documenté le rôle de `f901`, `f902`, `f90a`, `f90b`, `f90c`, `f90e`, `f90f`, `f910`,
   `f911` ou `f913`, ou a rencontré le même problème de persistance d'écriture.
2. **L'organisation GitHub officielle Parrot-Developers** (github.com/Parrot-Developers) —
   liste tout dépôt lié à Flower Power, Parrot Pot, au SDK du capteur "H2"/Hydrogen, ou au
   firmware BLE. Note ce qui est publiquement disponible (code source, doc protocole,
   headers SDK avec les définitions de caractéristiques).
3. **Le protocole OAD (Over-the-Air Download) sur puces TI CC254x / CC2640** —
   documentation officielle TI sur la structure du service GATT OAD (caractéristiques
   identify/block d'image), pour voir si le firmware de cette famille de puce a un
   comportement de "staging"/commit transactionnel qui pourrait expliquer un mécanisme
   similaire pour les écritures de config (par ex. un "commit" déclenché par le dernier
   champ écrit d'une séquence).
4. **Bugs/particularités connus des piles BLE TI SimpleLink / CC254x** concernant
   l'écriture groupée en NV (flash non-volatile), la corruption de réponses ATT sous
   trafic GATT intense simultané à des notifications actives, ou des erratas matériel.
5. **WatchFlower** (projet open-source, cherche son dépôt GitHub) — le projet dont mon
   projet personnel s'inspire — vérifie ses issues/discussions GitHub et le code source
   pour tout ce qui concerne les caractéristiques de config d'arrosage du Parrot Pot ou
   des soucis de persistance similaires.
6. **Brevets Parrot** (Google Patents / WIPO / brevets.inpi.fr) sur l'algorithme
   d'arrosage du Flower Power / Parrot Pot ou le protocole de calibration BLE — les brevets
   décrivent parfois précisément les structures de données internes.
7. Toute référence aux noms de code firmware **"hawaii2"** ou **"kauai-protoA"** qui
   pourrait mener à plus de documentation sur cette famille de matériel/firmware.

## Format de réponse attendu

Pour chaque trouvaille utile : l'URL, une courte citation/extrait de l'affirmation
technique pertinente, et ton évaluation de la pertinence par rapport aux questions
ci-dessus. Si tu ne trouves rien pour un point après une vraie recherche, dis-le
explicitement plutôt que de remplir avec du vague. Ne fabrique aucun détail technique —
ne rapporte que ce que tu trouves réellement avec une source citable. Signale explicitement
tout ce qui contredirait ce que je crois savoir déjà (section "Ce que je sais déjà"
ci-dessus), c'est particulièrement précieux.
