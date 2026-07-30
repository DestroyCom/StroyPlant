# StroyPlant

Self-hosted plant monitoring and automatic watering service (Parrot Pot, Xiaomi sensors), designed
to run continuously on a Linux server.

**Full documentation: see [`docs/STROYPLANT_SPEC.md`](docs/STROYPLANT_SPEC.md)** — this is the
project's source of truth (architecture, stack, batch roadmap, collaboration rules).

## Limitations that must never be presented as resolved

- Only works on **native Linux Docker Engine** (Debian/Ubuntu, Raspberry Pi) — **not on Docker
  Desktop macOS/Windows** (no real Bluetooth access inside the hidden VM).
- Only supports device types for which a driver has been written — not a generic "any BLE sensor"
  system.

## Repo structure

```text
backend/         API + business logic (Fastify, Prisma/SQLite, auth, BLE) — runs in Docker in prod
frontend/        Vite + React SPA, TanStack Router/Query, Tailwind v4 + shadcn/ui
noble-bridge/    Native macOS process (outside Docker) exposing the Mac's Bluetooth over HTTP/WS,
                 used by the backend's `noble-bridge` provider to develop without a Linux dongle
infra/           Infrastructure scripts/checklists (Docker+Bluetooth setup on the production server, etc.)
docs/            Full spec + Parrot Pot BLE reverse-engineering docs
```

## Development

The backend supports 3 interchangeable BLE providers via `BLE_PROVIDER` (see spec section 6):

| Provider       | Where | Use |
| -------------- | -- | ----- |
| `mock`         | In-container, Mac dev | Pure business logic, no hardware required |
| `noble-bridge` | Dockerized backend + native macOS `noble-bridge/` process | Real BLE protocol via the Mac's Bluetooth |
| `node-ble`     | Directly in-container, production server only | Real prod stack (BlueZ/D-Bus) |

```bash
pnpm install

# Backend (mock mode by default)
cd backend
cp .env.example .env
pnpm prisma:migrate
ADMIN_EMAIL=admin@example.com ADMIN_PASSWORD=changeme pnpm seed:admin
pnpm dev

# noble-bridge (only if BLE_PROVIDER=noble-bridge on the backend side)
cd noble-bridge
pnpm dev

# Frontend (Vite proxy to the backend on port 3000, see frontend/vite.config.ts)
cd frontend
pnpm dev
```

Lint/format: `pnpm lint` (Biome) from the root.

## Credits

This project builds on prior open-source BLE reverse-engineering work and a number of
open-source libraries — see [`CREDITS.md`](CREDITS.md).

## License

[GNU General Public License v3.0](LICENSE) (or, at your option, any later version) — free to
use, study, modify, and share, including commercially, as long as derivative works stay under
the same license and their source stays available.
