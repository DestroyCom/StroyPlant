# Credits

StroyPlant wouldn't exist in its current form without the open-source projects below —
either as direct research sources for the (undocumented, proprietary) Parrot Pot BLE
protocol, or as the tools this project is built on.

## BLE protocol research

- **[emericg/WatchFlower](https://github.com/emericg/WatchFlower)** (GPLv3) — the project
  StroyPlant replaces. Its Parrot Pot driver (`src/devices/device_parrotpot.cpp`), BLE
  documentation (`docs/parrotpot-ble-api.md`), and plant database
  (`assets/plants/watchflower_plantdb.csv`, used as the source for StroyPlant's own species
  import) were read directly as a starting point for this project's own Parrot Pot and
  Xiaomi LYWSD03MMC implementations. Per the GPLv3 license, this is the required attribution
  now that this repository is public.
- **[mbrentini/homeassistant_parrotflowerpower](https://github.com/mbrentini/homeassistant_parrotflowerpower)**
  and **[MarkoMarjamaa/homeassistant-flowerpower](https://github.com/MarkoMarjamaa/homeassistant-flowerpower)**
  — two independent Python implementations of the Flower Power/Parrot Pot BLE protocol,
  consulted as secondary references alongside WatchFlower.
- **[apktool](https://github.com/iBotPeaches/Apktool)** and **[jadx](https://github.com/skylot/jadx)**
  — used to decompile the official Parrot Flower Power Android app for the static BLE
  protocol analysis in `docs/PARROT_BLE_REVERSE_ENGINEERING.md` and
  `docs/PARROT_BLE_DEEP_DIVE.md`.

## Built with

**Backend:** [Fastify](https://fastify.dev/), [Prisma](https://www.prisma.io/),
[tRPC](https://trpc.io/), [BetterAuth](https://www.better-auth.com/),
[node-ble](https://github.com/chrvadala/node-ble), [@abandonware/noble](https://github.com/abandonware/noble),
[MQTT.js](https://github.com/mqttjs/MQTT.js), [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk).

**Frontend:** [React](https://react.dev/), [TanStack Router](https://tanstack.com/router) &
[Query](https://tanstack.com/query), [Tailwind CSS](https://tailwindcss.com/),
[shadcn/ui](https://ui.shadcn.com/) & [Radix UI](https://www.radix-ui.com/),
[lucide](https://lucide.dev/), [simple-icons](https://simpleicons.org/),
[Recharts](https://recharts.org/), [Sonner](https://sonner.emilkowal.ski/).

**Tooling:** [pnpm](https://pnpm.io/), [Vite](https://vite.dev/), [TypeScript](https://www.typescriptlang.org/),
[Biome](https://biomejs.dev/).
