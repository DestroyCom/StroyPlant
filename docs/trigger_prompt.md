Lis intégralement le fichier STROYPLANT_SPEC.md à la racine du projet avant de commencer
quoi que ce soit — c'est la spec complète et la source de vérité pour toutes les décisions
d'architecture, de stack, et de séquencement.

Pour tout ce qui touche au protocole BLE du Parrot Pot, consulte en priorité
PARROT_BLE_REVERSE_ENGINEERING.md et PARROT_BLE_DEEP_DIVE.md (également à la racine) — ce
sont des décompilations directes du code officiel Parrot, plus fiables que toute
supposition. Consulte aussi les repos tiers listés en section 9 de la spec pour tout le
reste (autres devices, patterns d'implémentation).

Respecte strictement la règle de collaboration de la section 10 : en cas de doute ou
d'ambiguïté technique, pose-moi la question directement plutôt que de choisir à ma place
et de continuer.

Commence par le Lot 0. Avant d'écrire la moindre ligne de code pour ce lot, pose-moi la
question indiquée en section 6 : est-ce que je veux que tu travailles en connexion SSH
directe sur mon serveur the production server pour ce lot, ou en local sur mon Mac avec des allers-retours
manuels de test.

Ne passe pas au lot suivant sans validation explicite de ma part que le lot en cours
fonctionne comme attendu.
