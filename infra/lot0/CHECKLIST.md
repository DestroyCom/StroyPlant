# Lot 0 — Checklist de validation Docker + Bluetooth sur l'the production server

> Contexte initial : le dongle TP-Link UB500 Plus n'était pas encore arrivé. En vérifiant
> l'the production server, on a découvert un adaptateur Bluetooth **intégré** déjà fonctionnel (Intel
> Wireless-AC 3168, Bluetooth 4.2, USB interne) — décision prise avec DestCom (2026-07-27)
> de valider le Lot 0 avec cet adaptateur dès maintenant, le TP-Link viendra en
> remplacement/complément à son arrivée (revalidation nécessaire, chipset différent —
> Realtek RTL8761B vs Intel, voir note en fin de fichier).

## Statut : Lot 0 validé (2026-07-27)

Exécuté via SSH direct (`ssh the production server`) sur l'the production server réel, résultats complets ci-dessous.

### Étape A — hôte

- Docker Engine natif confirmé : version 29.6.1, Debian 12 (bookworm), cgroup driver `cgroupfs`
- **BlueZ n'était pas installé par défaut** (the production server = distro orientée NAS, pas de paquets
  desktop/Bluetooth de base) → installé manuellement par DestCom (`apt-get install -y bluez`
  + `systemctl enable --now bluetooth`)
- Une fois installé : `bluetooth.service` actif, `bluetoothctl: 5.66`
- Socket D-Bus système présent à l'emplacement attendu
- Adaptateur détecté sur l'hôte : `hci0`, Intel Corp. Wireless-AC 3168, `UP RUNNING`,
  BD Address `10:F0:05:0F:40:4B`, HCI Version 4.2

### Étape B — accès Bluetooth depuis un container Docker

Testé avec la config **capabilities fines** (pas `privileged: true`) :
`cap_add: NET_ADMIN, NET_RAW` + `network_mode: host` + montage
`/var/run/dbus/system_bus_socket`.

- `dbus-send --system --dest=org.bluez / ... Introspect` → **répond correctement** (pas de
  timeout, pas de "Failed to connect to bus")
- `bluetoothctl list` depuis le container → voit le même contrôleur que l'hôte
- **Conclusion : la config capabilities fines suffit, pas besoin de `privileged: true`.**

### Étape C — scan BLE réel depuis le container (bonus, validation complète)

`bluetoothctl scan on` pendant 10s depuis le container a détecté, parmi d'autres devices
BLE alentour, les **devices P0 de la spec** :

- `A0:14:3D:CD:A3:D3` — "Parrot pot a3d3"
- `A0:14:3D:CD:A0:73` — "Parrot pot a073" (deux Parrot Pot détectés, pas un seul)
- `A4:C1:38:51:3B:54` — "LYWSD03MMC" (Xiaomi, firmware pvvx confirmé par le nom d'annonce)

Le pipeline complet (container Docker → capabilities → D-Bus → BlueZ hôte → adaptateur →
scan BLE → détection des vrais devices cibles) est validé de bout en bout.

## Reste à faire à l'arrivée du dongle TP-Link

Le chipset Realtek RTL8761B (TP-Link) est différent de l'Intel Wireless-AC 3168 déjà validé
— BlueZ absorbe en théorie ces différences, mais à revérifier concrètement :

- `dmesg | grep -i -E "usb|blue"` juste après branchement — confirmer que le kernel
  reconnaît le chipset sans erreur de firmware manquant
- `hciconfig -a` — le nouvel adaptateur doit apparaître `UP RUNNING`
- Si les deux adaptateurs (Intel intégré + TP-Link) sont présents en même temps, décider
  lequel utiliser par défaut pour le Lot 1 (probablement le TP-Link, recommandé dans la
  spec pour sa fiabilité/portée — mais l'intégré reste un bon fallback)
- Refaire le test de scan de l'étape C avec le TP-Link pour confirmer une portée/fiabilité
  au moins équivalente

---

## Contenu original de ce dossier (pour référence / re-run futur)

## 1. Préparation

Copier ce dossier `infra/lot0/` sur l'the production server (scp, rsync, ou clone du repo une fois qu'il existera).

## 2. Étape A — vérifs sur l'hôte (hors Docker)

```bash
chmod +x check-host.sh
./check-host.sh
```

Ce script vérifie :
- que Docker Engine est natif Linux (pas de sens de le vérifier sur macOS/Windows, mais on
  confirme la version et le cgroup driver)
- que `bluez` est installé sur l'hôte et que le service `bluetooth.service` tourne (il doit
  tourner même sans adaptateur branché, sauf s'il a été désactivé manuellement)
- que le socket D-Bus système existe à l'emplacement attendu (`/var/run/dbus/system_bus_socket`)
  — c'est ce socket qu'on montera dans le container plus tard
- liste des adaptateurs connus de BlueZ (vide, normal sans dongle)

**Me renvoyer la sortie complète.**

## 3. Étape B — accès Bluetooth depuis un container Docker

```bash
docker compose -f docker-compose.test.yml up --abort-on-container-exit
docker compose -f docker-compose.test.yml down
```

Ce test lance un container **jetable** (pas encore l'image de l'app, juste `debian:bookworm-slim`
+ `bluez` installé à la volée) avec la configuration Docker exigée par la spec (section 5) :
`cap_add: NET_ADMIN, NET_RAW` + `network_mode: host` + montage du socket D-Bus système.

Il essaie de :
1. Afficher la version de `bluetoothctl` installée dans le container
2. Faire un appel D-Bus direct vers `org.bluez` (`dbus-send`) — **c'est le test clé** : si ça
   répond (même une erreur "no such adapter"), le container parle bien à BlueZ via le bus système
   de l'hôte. Si ça timeout ou renvoie "Failed to connect to bus", la conf capabilities/mount ne
   suffit pas et il faudra basculer sur `privileged: true` (alternative commentée dans le fichier).
3. Lister les adaptateurs connus (vide, normal sans dongle)

**Me renvoyer la sortie complète, en particulier si l'étape `dbus-send` répond ou timeout.**

## 4. Ce qui reste bloqué sans le dongle (à refaire dès réception)

Une fois le dongle branché sur l'the production server, il faudra revalider (Lot 0 complet) :
- `dmesg | grep -i -E "usb|blue"` juste après branchement — confirmer que le kernel reconnaît
  le chipset Realtek RTL8761B sans erreur de firmware manquant
- `hciconfig -a` sur l'hôte — l'adaptateur doit apparaître avec un statut `UP RUNNING`
- Refaire le test de l'étape B avec le dongle branché — `bluetoothctl list` doit maintenant
  montrer l'adaptateur réel, et `bluetoothctl scan on` doit détecter des devices BLE alentour
  depuis l'intérieur du container
- Décider définitivement entre `privileged: true` et l'approche capabilities fines, selon ce
  qui a fonctionné à l'étape B

Ne pas considérer le Lot 0 comme "terminé" tant que cette section n'est pas validée avec le
dongle réel — ce qui précède n'est qu'une préparation partielle.
