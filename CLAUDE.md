# CLAUDE.md — StroyPlant

Project-specific instructions and context. The `~/.claude/CLAUDE.md` (global) file also applies (no
Co-Authored-By, always ask when in doubt, act as a mentor, get to the point quickly).

## What, for whom

Self-hosted service (replacing WatchFlower) that runs continuously on a Linux server (the production server,
Debian): BLE scanning of plant sensors, history, health scoring per species profile, automatic
watering (Parrot Pot), Home Assistant integration (MQTT), MCP server for AI agents. Personal use,
single admin user. DestCom (fullstack freelancer, ~3.5 years of experience, not a BLE/hardware
expert — explain non-trivial choices).

**Always read `docs/STROYPLANT_SPEC.md` before any architecture decision** — it's the complete
source of truth (mandated stack, batch-based roadmap, Docker/Bluetooth constraints, collaboration
rules in section 10). For the Parrot Pot's BLE protocol, `docs/PARROT_OFFICIAL_BLE_SPEC.md`
(official Parrot engineering PDF) is the absolute #1 source for everything it covers; for
everything else (Parrot-Pot-specific behavior, real app behavior),
`docs/PARROT_BLE_REVERSE_ENGINEERING.md` and `docs/PARROT_BLE_DEEP_DIVE.md` (decompilation of the
official APK) take precedence over any inference from third-party sources (WatchFlower, etc.) —
see `docs/STROYPLANT_SPEC.md` section 9 for the full hierarchy. For the detailed workings of the
health scoring engine (Batch 4), see `docs/HEALTH_ENGINE.md`.

## Non-negotiable rules

- `pnpm` exclusively (never `npm`/`yarn`), including in Dockerfiles.
- TypeScript/JavaScript everywhere, no Python.
- Never test the real BLE layer inside the Docker container on Mac (impossible anyway — Docker
  Desktop macOS has no Bluetooth passthrough) — use `mock` or `noble-bridge` in dev, `node-ble`
  only on the the production server (spec section 6).
- Never silently swallow a BLE error (identified and documented WatchFlower bug, spec section
  7.1) — every write operation (especially `trigger_watering`) must be explicitly confirmed or
  fail explicitly, never fire-and-forget.
- When in technical doubt or when the spec diverges from what's observed in reality: ask DestCom
  rather than guessing. Concrete precedents where guessing would have been wrong:
  - The Xiaomi LYWSD03MMC was assumed to be pvvx (cleartext passive advertisement) — in reality
    it's stock firmware, MiBeacon-encrypted advertisement. Resolved via real BLE capture
    (`btmon`) on the the production server, not assumption.
  - WatchFlower (and therefore us) reads the LYWSD03MMC via a GATT connection, not passively as
    the spec initially assumed — found by reading WatchFlower's actual source code, not guessed.
- Always validate empirically on real hardware when possible rather than assuming a
  format/behavior — SSH access to the the production server (`ssh the production server`) + Docker allows scanning/connecting to real
  devices with no risk (disposable containers).

## Real hardware available (for empirical testing)

On the the production server, a working built-in Bluetooth adapter (Intel Wireless-AC 3168, BT 4.2,
`10:F0:05:0F:40:4B`) — the TP-Link UB500 Plus dongle recommended by the spec hasn't arrived yet,
to be revalidated on arrival (different Realtek chipset). Devices detected within range of the
the production server:

- 2x Parrot Pot: `A0:14:3D:CD:A3:D3` and `A0:14:3D:CD:A0:73`
- Xiaomi LYWSD03MMC: `A4:C1:38:51:3B:54` (+ at least 2 more nearby, probably neighbors':
  `A4:C1:38:E1:D1:49`, `A4:C1:38:AA:29:49`)

## Project status (by batch)

- **Batch 0** ✅ — Docker + Bluetooth validated on the real the production server. Working config: `cap_add:
  NET_ADMIN, NET_RAW` + `network_mode: host` + mounting `/var/run/dbus/system_bus_socket` (no
  need for `privileged: true`). BlueZ had to be installed manually (`apt install bluez`, not
  present by default on the production server). Full detail in `infra/lot0/CHECKLIST.md`.
- **Batch 1** ✅ — Fastify + Prisma/SQLite backend, 3 interchangeable BLE providers, scanner +
  sequential connectionQueue, tRPC router + WS subscription (migrated from hand-written REST/raw
  WebSocket, see the tRPC migration entry below). See technical detail below.
- **Batch 2** ✅ — BetterAuth (credentials, single-admin, `disableSignUp: true`), all `/api/*`
  routes and the WS protected by session.
- **Batch 3** ✅ (partial, see scope below) — Vite + React + TanStack Query/Router + Tailwind v4 +
  shadcn/ui frontend. See technical detail below.
- **Batch 4 (backend + frontend)** ✅ — WatchFlower CSV import (`plant_profiles`), health scoring
  engine (rolling baseline + comparison against species ranges, luminosity included since the
  mol/m²/day unit confirmation), API endpoints, and on the frontend side: species picker on the
  detail page (`SpeciesPickerDialog`), health banner on the dashboard and detail page, gauges with
  tone/expected range, consumer-friendly explanation of the scoring. Tested locally with the mock
  provider (real import, warming_up → warning transition, species assignment/removal), not yet
  validated by DestCom against real data accumulated on the the production server. See technical detail below.
- **Next batch**: Batch 5 (auto-watering scheduler wired to the Health Engine). Possibly complete
  Batch 3 first with the "Add device" and "Settings" screens from the claude.ai/design prototype
  (see below) once explicit confirmation has been given — not done for now since these screens
  depend on features not yet implemented (manual pairing, notifications, auto-watering = Batches
  5/7/8).
- **`noble-bridge` validated with real hardware** ✅ (2026-07-27) — a real Parrot Pot
  (`PARROT-A073`) connected and read end-to-end (scan → connect → activate → read
  humidity/temp/luminosity/reservoir → deactivate → disconnect) via the Mac's Bluetooth, data
  flowing through to the frontend dashboard. The other devices in range (2nd Parrot Pot, several
  Xiaomi) were detected but not always read on the first try ("not found on scan" — noble-bridge's
  scan window closes before the device's next BLE advertisement; the retry on the next poll (~5
  min) resolves this in practice). One-off validation, not an automated regression test.
- **Not done / deferred**: validating `node-ble` under real conditions on the the production server (Docker build +
  full deployment) — deliberately postponed by DestCom.
- **Migrated to tRPC** ✅ (2026-07-28) — the hand-written REST routes (`api/routes/devices.ts`,
  `.../health.ts`) and the raw WebSocket pub/sub (`api/ws.ts`) were replaced by a typed tRPC router
  (`src/api/trpc/`), shared end-to-end with the frontend via a type-only cross-package import (no
  runtime code shared, no codegen). The live-reading push also moved to a tRPC subscription
  (`readings.onReading`, backed by a Node `EventEmitter`) rather than staying a separate raw
  WebSocket. Verified end-to-end against the mock provider: session-gated queries/mutations (401/
  `UNAUTHORIZED` without a session, over both HTTP and the WS subscription), the watering
  mutation's explicit non-silent failure path (empty-reservoir `MOCK-POT-DECLINE` → `WateringEvent`
  row written + `BAD_GATEWAY` surfaced to the caller), plant-profile assign/unassign, and live
  reading events actually pushed over the subscription while connected. See technical detail below
  for the router shape and the Date-serialization detail (`api/trpc/serialize.ts`).

## Repo structure

```text
backend/         API + business logic (Fastify, Prisma/SQLite, auth, BLE) — runs in Docker in prod
  src/api/         tRPC router (api/trpc/: context, procedures, readings subscription) mounted on Fastify
  src/auth/        BetterAuth (instance, session/middleware, admin seed)
  src/ble/         scanner, connectionQueue, Parrot protocol logic (ble/parrot/) and Xiaomi (ble/xiaomi/)
  src/providers/   DeviceProvider implementations (mock, noble-bridge, node-ble) + factory
  src/health/      Health Engine (Batch 4): plant_profiles CSV import + scoring engine
  src/db/          Prisma client
  prisma/          schema.prisma + migrations
frontend/        Vite + React SPA + TanStack Router/Query + Tailwind v4 + shadcn/ui (Batch 3)
  src/routes/      TanStack Router pages (file-based): login, _authenticated (layout+guard) and its children
  src/components/  Shell (sidebar), DeviceCard, SensorGauge, HistoryChart, shadcn components in ui/
  src/lib/         auth-client (BetterAuth), trpc.ts (tRPC client + TanStack Query options proxy),
                   use-live-readings (readings.onReading subscription)
noble-bridge/    Native macOS process (outside Docker), exposes the Mac's Bluetooth over HTTP/WS —
                 used by the backend's `noble-bridge` provider for dev without a Linux dongle
infra/lot0/      Docker+Bluetooth setup scripts/checklist on the the production server
docs/            Full spec, Parrot Pot BLE reverse-engineering docs, frontend design import
```

## Backend — technical detail

- **Fastify** (chosen over Express — better native TS support, official WS plugin).
- **Prisma + SQLite**. `DATABASE_URL="file:./dev.db"` in `.env` — **resolved relative to the
  `schema.prisma` folder, not the cwd** (already-encountered trap: `file:./prisma/dev.db` would
  create `prisma/prisma/dev.db`).
- Business models: `Device` (id = uppercase colon-separated MAC, kind, name, lastSeenAt, optional
  `plantProfileId`), `Reading` (all sensor fields for both device types, optional, on a single
  table), `WateringEvent` (deviceId, triggerSource MANUAL/CRON, success, errorDetail),
  `PlantProfile` (Batch 4, see below). `schedules` not yet created (Batch 5).
- **`DeviceProvider`** (`src/providers/types.ts`): common interface `scan()` /
  `readSensors(id, kind)` / `triggerAction(id, action)`. `kind` is passed by the caller because a
  provider can't always infer the device type from its id alone.
  - `mock`: 2 simulated Parrot Pots (`MOCK-POT-NORMAL` healthy, `MOCK-POT-DECLINE` declining
    humidity + empty reservoir from the start to test watering failure) + 1 Xiaomi
    (`MOCK-XIAOMI-01`).
  - `noble-bridge`: HTTP/WS client to the `noble-bridge/` process (native macOS,
    `@abandonware/noble`, derived from the `parrot-pot-debug` PoC). **Never exposes the real MAC**
    (CoreBluetooth masks it) — logical ids `PARROT-XXXX` (suffix of the advertised name) /
    `XIAOMI-<noble uuid>`. Do NOT match `node-ble`'s MAC ids — expected, this provider validates
    the protocol, not data continuity across environments.
  - `node-ble`: real BlueZ/D-Bus (`node-ble` package v1.13+, API verified against the real
    package, not guessed — `writeValueWithResponse`/`writeValueWithoutResponse`, no native
    `enable()`/`disable()` on the Adapter so `restartAdapter()` shells out to `bluetoothctl power
    off/on`).
- **GATT retry pattern** (`src/ble/parrot/retry.ts`): 3 attempts, 18s timeout, 500ms backoff on
  GATT_ERROR≈133, adapter restart on the 2nd consecutive occurrence. "133" detection is a
  heuristic on error messages — **best-effort, BlueZ has no 1:1 equivalent of the
  Android/Bluedroid code**, to be refined empirically on the the production server. On `noble-bridge`/macOS,
  CoreBluetooth swallows the real code: any connection failure is treated as a 133 (no automatic
  restart of the Mac's Bluetooth, that would take down the whole system — just a log recommending
  manual action).
- **`connectionQueue`**: a single GATT connection at a time, shared between Parrot Pot AND Xiaomi
  (both require a connection — correction of the spec's initial assumption that Xiaomi was purely
  passive).
- **Parrot Pot**: mandatory activation (write `1` to `39e1fa06`) before reading `39e1fa09/0a/0b`
  (float32 LE, already-calibrated VWC/temp/luminosity), otherwise readings silently freeze. Write
  `0` at the end of the session. Watering trigger: write `[0x08,0x00]` to `39e1f906`,
  write-with-response. Also best-effort reads `39e1fa0d`/`0e` (soil conductivity candidates,
  `Reading.soilConductivityEcb`/`soilConductivityEcPorous`) — never used by the official app.
  `soilConductivityEcPorous` is wired into the Health Engine (see `docs/HEALTH_ENGINE.md` for the
  reasoning and the limitation: mapping unconfirmed on real data). **Event-driven advertisement
  flags: Parrot company ID (`0x0043`) confirmed via real capture on both the production server Parrot Pots
  (2026-07-28), but the payload is 3 bytes (not 1 as assumed) and their exact meaning isn't
  determined** — an active correlation protocol is defined but not executed (requires physical
  access to the pots), see `docs/STROYPLANT_SPEC.md` section 7.1 for the full detail and the
  baseline values already captured. Do not interpret the 3rd byte until this protocol has settled
  the matter.
- **Xiaomi LYWSD03MMC**: GATT, service `ebe0ccb0-...`, notify on `ebe0ccc1-...`, 5-byte payload
  `[int16 LE temp/100][uint8 humidity][int16 LE voltage mV/1000]`, battery% =
  `(voltage-2.1)*100` clamped 0-100. Formula confirmed by WatchFlower AND re-validated empirically
  on a real device.
- **tRPC (`src/api/trpc/`)**: `router.ts` combines `devices` (`list`, `history`, `wateringEvents`,
  `water`), `health` (`plantProfiles`, `assignPlantProfile`, `deviceHealth`) and `readings`
  (`onReading`, a subscription) into `appRouter`; its type (`AppRouter`) is the single source of
  truth shared with the frontend. `trpc.ts` defines `publicProcedure`/`protectedProcedure`
  (`protectedProcedure` throws `TRPCError({code:'UNAUTHORIZED'})` when there's no session — same
  check `requireAuth` used to do). `context.ts`'s `createContext` resolves the BetterAuth session
  from the request headers (works identically for HTTP calls and the WS upgrade). Mounted in
  `api/server.ts` via `fastifyTRPCPlugin` at prefix `/api/trpc` with `useWSS: true`, so regular
  procedure calls (HTTP) and the `readings.onReading` subscription (WS) share the same prefix —
  reuses the `@fastify/websocket` plugin, no separate `/ws` route anymore. The watering mutation
  keeps the exact same never-silent-failure sequence as the old REST handler: on failure it still
  writes a `WateringEvent{success:false, errorDetail}` row AND throws a `TRPCError({code:
  'BAD_GATEWAY'})`, never just logs and returns quietly. **Date serialization**: tRPC's default
  (no-transformer) wire format has no way to revive a `Date` back from JSON on the client, so
  Prisma's `Date` fields are converted to ISO strings explicitly in the router (`serialize.ts`) —
  deliberately not using a transformer like superjson for this, to keep the wire format identical
  to what the old REST endpoints already returned and avoid touching how dates are rendered
  elsewhere in the frontend (charts, relative-time formatting).
- **Health Engine (Batch 4, `src/health/`)** — WatchFlower CSV import + scoring engine
  (`computeDeviceHealth`), exposed as the `health` tRPC router above. `devices.list` and
  `health.assignPlantProfile` return `plantProfile` as an included relation (not just the id), so
  the frontend can show the species name without an extra request. **Full explanation of how it
  works (data sources, algorithm, known limitations) in `docs/HEALTH_ENGINE.md` — do not duplicate
  that detail here.** Wired into the frontend (species picker, health banner) since Batch 4b.
- **Auth (BetterAuth)**: `src/auth/auth.ts`. `emailAndPassword` enabled but `disableSignUp: true`
  — no self-registration. `admin` plugin used only for `auth.api.createUser()` (the only
  documented way to create an account without going through the public sign-up endpoint, which
  respects `disableSignUp`) — no real multi-user role management. `pnpm seed:admin`
  (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) creates the single account. Every tRPC procedure except the raw
  `/api/auth/*` passthrough goes through `protectedProcedure` (401/`UNAUTHORIZED` without a
  session, verified for both HTTP calls and the WS subscription). `trustedOrigins` hardcodes
  `http://localhost:5173` — needed for dev (the Vite proxy doesn't rewrite the `Origin` header,
  only `Host`); without it BetterAuth rejects the login with "Invalid origin". No impact in prod
  (front+back on the same origin, section 14). Ready for a future OIDC plugin addition (Authentik)
  with no rewrite needed — not added now.
- Homegrown structured logging (`src/logger.ts`): timestamp, direction (SCAN/CONNECT/READ/WRITE/
  ...), uuid, hex payload, result — never a silent log for a BLE operation.

## Frontend — technical detail (Batch 3)

- **Vite + React 19 + TypeScript**, **Tailwind v4** (`@tailwindcss/vite`, CSS-first config via
  `@theme inline` in `src/index.css`, no `tailwind.config.js`) + **shadcn/ui** (`shadcn` CLI v4,
  `radix-nova` style, components in `src/components/ui/` — treated as vendored code, not
  hand-reformatted; `biome.json` has an `overrides` section that disables
  `noDangerouslySetInnerHtml`/`noArrayIndexKey` on that folder for this reason).
- **TanStack Router** (file-based, `@tanstack/router-plugin/vite` plugin, generates
  `src/routeTree.gen.ts` — gitignored, regenerated by `pnpm dev`/`pnpm build`) + **TanStack Query**
  (cache updated live by the `readings.onReading` tRPC subscription via `queryClient.setQueryData`,
  see `src/lib/use-live-readings.ts`, mounted only in `AppShell` so only active after login).
- **tRPC client** (`src/lib/trpc.ts`): `createTRPCClient` with a `splitLink` — `httpBatchLink` for
  queries/mutations at `/api/trpc` (with `credentials:'include'` so the BetterAuth session cookie
  rides along, replacing the old `apiFetch()` wrapper), `wsLink`/`createWSClient` for the
  `readings.onReading` subscription. `createTRPCOptionsProxy` binds it to the shared `queryClient`
  (moved into `src/lib/query-client.ts` to avoid a circular import between `trpc.ts` and
  `main.tsx`). Call sites use `trpc.devices.list.queryOptions()` /
  `trpc.devices.water.mutationOptions()` etc. directly — this replaced the old
  `lib/api.ts`/`lib/queries.ts` hand-written fetch wrappers and `queryOptions()` factories, now
  deleted. The `AppRouter` type is imported from the backend package via a type-only path alias
  (`@stroyplant/backend/*` → `../backend/src/*` in `tsconfig.app.json`) — no runtime backend code
  is bundled (erased entirely as `import type`), no shared package needed.
- **BetterAuth React client** (`src/lib/auth-client.ts`, `createAuthClient()` with no `baseURL` —
  resolves to `/api/auth` relatively, correct as long as front and back share the same origin).
  Auth guard in `src/routes/_authenticated.tsx` (`beforeLoad` + `authClient.getSession()`).
- **Design**: two separate claude.ai/design projects referenced by
  `docs/webdesign_claudecode.md` — the design system (color/typography/spacing tokens +
  shadcn-like components) and **the real 7-screen prototype `StoryPlant.dc.html`** (login,
  dashboard, detail, history, settings, add, calibration) which is authoritative for the real
  content/layout. **The prototype is entirely in French** — the app's UI follows that language,
  not the design system README's English. Satoshi fonts self-hosted in `public/fonts/` (only 4
  weights: Regular/Medium/Bold/Black — no italics or variable font, to stay lightweight).
- **Currently covered scope**: login, dashboard (device grid with a colored banner based on real
  status — offline / low reservoir / Health Engine health / normal), device detail (gauges with
  tone and expected species range as a legend, 24h-7d-30d history/graph via `recharts`, "Recent
  waterings" timeline, watering trigger with confirmation for Parrot Pots, "Species" section with
  picker/removal via `SpeciesPickerDialog` and a consumer-friendly explanation of the scoring).
  **Not done yet** (depend on unimplemented features): "Add device" screen (manual pairing),
  "Settings" (notifications, auto-watering, MCP), global "History", "Calibration" — see the
  Project status section.
- Displayed titles/statuses (`src/lib/format.ts`, `statusHeadline`/`statusBandClasses`) prioritize
  verifiable facts (connectivity, reservoir level) then, since Batch 4b, the Health Engine's
  judgment (`healthHeadline`, if a species is assigned to the device) — with no species assigned,
  behavior is unchanged (no judgment made).
- Icons: `lucide-react` everywhere, `simple-icons` for the Xiaomi logo. No Parrot logo in
  simple-icons (only "Parrot Security", unrelated) — lucide fallback for the Parrot Pot.

## Tooling

- **Biome** for lint/format (`pnpm lint` / `pnpm lint:fix` from the root) — 2 spaces, single
  quotes, no tabs (custom config in `biome.json`, different from Biome's defaults).
- **Git** initialized at the root, commits with no Co-Authored-By (global rule).
- `pnpm` workspace (`pnpm-workspace.yaml`): `backend`, `frontend`, `noble-bridge`.

## Gotchas already encountered (so as not to rediscover them)

- Prisma `DATABASE_URL` is relative to `prisma/schema.prisma`, not the cwd (see above).
- Xiaomi LYWSD03MMC: GATT is mandatory, no passive reading possible on stock firmware (see above).
- `noble-bridge` (macOS) never exposes the real MAC (see above).
- The GATT_ERROR=133 heuristic on `node-ble`/BlueZ is best-effort, to be refined on the the production server.
- `BETTER_AUTH_SECRET` runs on an insecure dev fallback if absent from `.env` (just a startup
  warning) — generate a real value (`openssl rand -base64 32`) before any real deployment.
- BetterAuth rejects the login in dev with "Invalid origin" if `trustedOrigins` doesn't include
  the Vite frontend's origin (see Auth section above) — the Vite proxy only rewrites `Host`, not
  `Origin`.
- Two separate claude.ai/design projects for this project (design system vs. 7-screen prototype,
  see Frontend section) — always check which one is authoritative before coding a screen: the
  prototype takes precedence for real content/layout, the design system for reusable
  tokens/components.
- `@abandonware/noble` (used by `noble-bridge`): the prebuilt native binary shipped in the package
  doesn't always cover `darwin-arm64` + recent Node ABIs ("No native build was found" error). The
  module uses N-API (ABI-stable), so a simple rebuild from source is enough — no need to downgrade
  Node: `cd node_modules/.pnpm/@abandonware+noble@*/node_modules/@abandonware/noble && pnpm dlx
  node-gyp rebuild` (requires Xcode Command Line Tools, already present on DestCom's machine). Must
  be redone if `pnpm install` reinstalls the package (e.g. after deleting `node_modules`).

## Infra access

- the production server reachable via `ssh the production server` (key already configured, user `[user]`). `sudo` there prompts for an
  interactive password (no NOPASSWD) — for any command requiring root on the the production server, ask DestCom
  rather than trying to work around it.
- Docker on the the production server doesn't require `sudo` for the `[user]` user — `docker run`/`docker compose`
  work directly over SSH for empirical testing (disposable containers recommended).
