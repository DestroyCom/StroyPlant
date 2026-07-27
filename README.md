# StroyPlant

Service self-hosted de suivi et d'arrosage automatique de plantes (Parrot Pot, capteurs Xiaomi),
pensé pour tourner en continu sur un serveur Linux (the production server).

**Documentation complète : voir [`docs/STROYPLANT_SPEC.md`](docs/STROYPLANT_SPEC.md)** — c'est la
source de vérité du projet (architecture, stack, roadmap par lots, règles de collaboration).

## Limites à ne jamais présenter comme résolues

- Fonctionne uniquement sur **Docker Engine natif Linux** (the production server, Debian/Ubuntu, Raspberry Pi) — **pas
  sur Docker Desktop macOS/Windows** (pas d'accès Bluetooth réel dans la VM cachée).
- Ne supporte que les types de devices pour lesquels un driver a été écrit — pas un système
  générique "n'importe quel capteur BLE".

## Structure du repo

```text
backend/         API + logique métier (Fastify, Prisma/SQLite, auth, BLE) — tourne en Docker en prod
noble-bridge/    Process natif macOS (hors Docker) qui expose le Bluetooth du Mac en HTTP/WS,
                 utilisé par le provider `noble-bridge` du backend pour développer sans dongle Linux
infra/           Scripts/checklists d'infrastructure (setup Docker+Bluetooth sur l'the production server, etc.)
docs/            Spec complète + docs de rétro-ingénierie BLE Parrot Pot
```

## Développement

Le backend supporte 3 providers BLE interchangeables via `BLE_PROVIDER` (voir spec section 6) :

| Provider       | Où | Usage |
| -------------- | -- | ----- |
| `mock`         | Dans le container, dev Mac | Logique métier pure, aucun matériel requis |
| `noble-bridge` | Backend dockerisé + process `noble-bridge/` natif macOS | Vrai protocole BLE via le Bluetooth du Mac |
| `node-ble`     | Directement dans le container, the production server uniquement | Vrai stack de prod (BlueZ/D-Bus) |

```bash
pnpm install

# Backend (mode mock par défaut)
cd backend
cp .env.example .env
pnpm prisma:migrate
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme pnpm seed:admin
pnpm dev

# noble-bridge (uniquement si BLE_PROVIDER=noble-bridge côté backend)
cd noble-bridge
pnpm dev
```

Lint/format : `pnpm lint` (Biome) depuis la racine.
