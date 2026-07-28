# CLAUDE.md — StroyPlant

Project-specific instructions and context. The `~/.claude/CLAUDE.md` (global) file also applies (no
Co-Authored-By, always ask when in doubt, act as a mentor, get to the point quickly).

## What, for whom

Self-hosted service (replacing WatchFlower) that runs continuously on a Linux server (Debian):
BLE scanning of plant sensors, history, health scoring per species profile, automatic
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
  only on the production server (spec section 6).
- Never silently swallow a BLE error (identified and documented WatchFlower bug, spec section
  7.1) — every write operation (especially `trigger_watering`) must be explicitly confirmed or
  fail explicitly, never fire-and-forget.
- When in technical doubt or when the spec diverges from what's observed in reality: ask DestCom
  rather than guessing. Concrete precedents where guessing would have been wrong:
  - The Xiaomi LYWSD03MMC was assumed to be pvvx (cleartext passive advertisement) — in reality
    it's stock firmware, MiBeacon-encrypted advertisement. Resolved via real BLE capture
    (`btmon`) on the production server, not assumption.
  - WatchFlower (and therefore us) reads the LYWSD03MMC via a GATT connection, not passively as
    the spec initially assumed — found by reading WatchFlower's actual source code, not guessed.
- Always validate empirically on real hardware when possible rather than assuming a
  format/behavior — SSH access to the production server + Docker allows scanning/connecting to real
  devices with no risk (disposable containers).

## Real hardware available (for empirical testing)

On the production server, a working built-in Bluetooth adapter (Intel Wireless-AC 3168, BT 4.2,
`10:F0:05:0F:40:4B`) — the TP-Link UB500 Plus dongle recommended by the spec hasn't arrived yet,
to be revalidated on arrival (different Realtek chipset). Devices detected within range of the
production server:

- 2x Parrot Pot: `A0:14:3D:CD:A3:D3` and `A0:14:3D:CD:A0:73`
- Xiaomi LYWSD03MMC: `A4:C1:38:51:3B:54` (+ at least 2 more nearby, probably neighbors':
  `A4:C1:38:E1:D1:49`, `A4:C1:38:AA:29:49`)

## Project status (by batch)

- **Batch 0** ✅ — Docker + Bluetooth validated on the real production server. Working config: `cap_add:
  NET_ADMIN, NET_RAW` + `network_mode: host` + mounting `/var/run/dbus/system_bus_socket` (no
  need for `privileged: true`). BlueZ had to be installed manually (`apt install bluez`, not
  present by default on the production server). Full detail in `infra/lot0/CHECKLIST.md`.
- **Batch 1** ✅ — Fastify + Prisma/SQLite backend, 3 interchangeable BLE providers, scanner +
  sequential connectionQueue, tRPC router + WS subscription (migrated from hand-written REST/raw
  WebSocket, see the tRPC migration entry below). See technical detail below.
- **Batch 2** ✅ — BetterAuth (credentials, single-admin, `disableSignUp: true`), all `/api/*`
  routes and the WS protected by session.
- **Batch 3** ✅ (complete) — Vite + React + TanStack Query/Router + Tailwind v4 + shadcn/ui
  frontend. See technical detail below.
- **Batch 4 (backend + frontend)** ✅ — WatchFlower CSV import (`plant_profiles`), health scoring
  engine (rolling baseline + comparison against species ranges, luminosity included since the
  mol/m²/day unit confirmation), API endpoints, and on the frontend side: species picker on the
  detail page (`SpeciesPickerDialog`), health banner on the dashboard and detail page, gauges with
  tone/expected range, consumer-friendly explanation of the scoring. Tested locally with the mock
  provider (real import, warming_up → warning transition, species assignment/removal), not yet
  validated by DestCom against real data accumulated on the production server. See technical detail below.
- **Batch 3 completed (2026-07-28)** — "Add device" and "Settings" screens added, closing out the
  scope deferred since Batch 3b. Scope was clarified with DestCom rather than assumed (both screens
  depend on unimplemented features — Batches 5/7/8 — so a literal implementation of the prototype
  wasn't possible yet):
  - **"Add device"**: no real BLE pairing exists for these devices (the scanner already
    auto-discovers and upserts any device it sees), so this screen is a claiming step, not a
    pairing flow. A `Device` row with `name = null` means "seen by the scanner, not yet added" —
    `devices.listUnnamed` (tRPC) lists these, `devices.rename` (input `{deviceId, name}`) claims one
    by giving it a name. `devices.list` (used by the dashboard) now filters to `name IS NOT NULL`,
    so a freshly-scanned device no longer appears on the dashboard until named through this screen.
    Frontend: `frontend/src/routes/_authenticated/devices.add.tsx`.
  - **"Settings"**: built as a skeleton now rather than deferred entirely — an account section
    (email, from BetterAuth's `useSession()`) is functional today; auto-watering (Batch 5),
    notifications (Batch 7), and the MCP server (Batch 8) are shown as disabled "coming soon"
    cards labeled with their batch, so the nav entry exists without faking functionality that isn't
    there. Frontend: `frontend/src/routes/_authenticated/settings.tsx`.
  - Sidebar nav (`frontend/src/components/app-shell.tsx`) gained the two corresponding links.
- **Batch 5** ✅ (2026-07-28) — auto-watering scheduler, wired to the Health Engine
  (`backend/src/health/scheduler.ts`). Key decisions, all explicitly confirmed with DestCom rather
  than assumed:
  - **Trigger condition**: only `soilMoisturePercent`'s status being `too_low` (not the overall
    Health Engine status) — a temperature/luminosity issue never triggers a watering, since
    watering can't fix those.
  - **Configuration UI**: per device, on its detail page ("Arrosage automatique" section, backed by
    the new `schedule.get`/`schedule.upsert` tRPC procedures) — not a single global setting, since
    `Schedule` is a per-device row. `/settings`'s former "coming soon · Lot 5" card was replaced
    with a link to the per-device page now that the feature is real.
  - **Default active state**: a device becomes eligible for auto-watering **as soon as a species is
    assigned** — no separate opt-in toggle required. Implemented with no backfill/migration: a
    missing `Schedule` row resolves (`resolveEffectiveSchedule`) to `active =
    plantProfileId != null`, applying identically to devices assigned before or after this batch.
    **Real-hardware consequence**: `PARROT-A073` (the real Parrot Pot validated in Batch 4b)
    already has a plant profile assigned from that earlier testing, so it is immediately eligible
    for autonomous watering attempts once the scheduler runs against a real BLE provider — the
    warm-up gate (below) and the 24h default cooldown are the only safeguards, not a manual
    enable step.
  - **Warm-up safeguard**: the scheduler also skips a device while the Health Engine's overall
    status is `warming_up` (not enough personal baseline yet) — reusing the same guard the
    dashboard badge uses, since trusting a single parameter's status before that would risk a real
    watering trigger on a false read, not just a wrong badge. This wasn't one of the confirmed
    choices above — added as a direct consequence of Batch 4's existing warm-up design, flagged to
    DestCom rather than silently assumed.
  - Anti-spam cooldown and allowed-hours window default to 24h / 6h-20h, both editable per device.
  - `triggerWatering()` (`backend/src/watering.ts`) is now shared between the manual `devices.water`
    mutation and the scheduler, so the never-fire-and-forget contract (7.1) lives in one place.
  - Verified against the mock provider: `schedule.get`/`upsert` round trip, the warm-up gate
    correctly blocking a freshly-assigned device, and — after backdating a reading past the warm-up
    window — the scheduler actually calling `triggerWatering` and recording an explicit `CRON`
    failure on `MOCK-POT-DECLINE`'s empty reservoir. All test rows/users cleaned up afterward.
  - **Bugfix found during this batch**: the mock provider's simulated `luminosity` values (450/300)
    were leftover placeholders from before the unit was confirmed to be real mol/m²/day DLI (a real
    Parrot Pot capture reads ~0.1) — a healthy mock pot displayed "459 mol/m²/j" against an expected
    "4-6" range. Rescaled to realistic indoor values (~5/~3) in `backend/src/providers/mock/index.ts`.
- **Batch 6** ✅ (2026-07-28) — Plant Dr device-side calibration (`39e1FD80`), a complementary
  safety net alongside the Batch 5 scheduler (keeps watering at a minimum if the backend is
  offline/out of range). Key decisions and findings, all explicitly discussed with DestCom rather
  than assumed given this is the project's first real GATT *write* to an unconfirmed field:
  - **Design simplified during implementation**: the originally planned "air" user gesture was
    dropped. `DRY_VWC` (the firmware's "soil considered dry" threshold) is derived from the
    assigned species' `soilMoistureMinPercent` (CSV) instead — an "air" (probe out of the soil ≈
    0%) reading would set an unrealistically extreme threshold, not a sensible per-species one. The
    only remaining user action is the **"wet" capture**: triggered right after a normal watering,
    it reads the device's live calibrated soil moisture and writes it as `WET_VWC`.
  - **`DRY_N`/`WET_N` resolved empirically, not guessed**: blocked initially because this Mac
    wasn't in BLE range of the real pots — DestCom chose to unblock via `node-ble` on the production
    server instead (the first real-conditions validation of that provider, previously deferred). A
    read-only capture on `PARROT-A073` found `DRY_N=WET_N=0` with factory-default
    `DRY_VWC=17.5%`/`WET_VWC=22.5%`, and the device's own `CONFIG_ID` matched exactly what
    `computePlantDrConfigId()` computes from those values — confirming both the XOR checksum
    formula (`backend/src/ble/parrot/plantDr.ts`) and that VWC is stored as percent×10. Both
    calibration points are written with `n=0`, an evidenced default (what the device already ships
    with), not an assumption. The disposable container on the production server (and its root-owned
    `node_modules`, cleaned up via a second throwaway container rather than `sudo`) left no residue.
  - **`ALGORITHM_STATUS` (`39e1F912`) is deliberately NOT written by this batch** — only value `0`
    is confirmed in the decompiled code, values 1-6 are unconfirmed. DestCom asked for an empirical
    enable test on real hardware, but that needs sustained observation over time (does the pot
    actually water itself?), not just an instant read — tracked as a follow-up, not done this turn.
  - **Not implemented**: the "DRY_VWC automatically refined from the rolling baseline's observed low
    point over several watering cycles" idea from earlier drafts — would need a recurring rewrite
    job, and no per-device baseline history exists yet to refine from meaningfully. `DRY_VWC` is
    written once, at calibration time, and stays fixed until the user re-triggers it.
  - **`STATUS_FLAGS` (`39e1FD86`) also wired in**: decoded on every poll across all 3 providers,
    persisted on `Reading` (`isDrySoil`/`isWetSoil`/`isEmptyTank`/`isInAir`). `isInAir` readings are
    now excluded from the Health Engine's rolling-baseline/scoring entirely (`computeDeviceHealth`)
    — a probe out of the soil isn't a plant state. The other 3 flags are stored but not yet surfaced
    further in the dashboard UI.
  - Providers stay "dumb": the checksum/encoding logic lives once in `ble/parrot/plantDr.ts`
    (`computePlantDrConfigId`, `buildPlantDrWriteValues`) — `mock`/`noble-bridge`/`node-ble` just
    write the exact values they're given, in the required order, `CONFIG_ID` last.
  - New `plantDr` tRPC router (`getCalibration`, `calibrateWet`) — no new Prisma table, the device
    itself stays the source of truth for its own calibration, read live on demand.
    `calibrateWet` refuses to write if the live soil moisture isn't above the species' dry
    threshold (would write an inverted, nonsensical calibration) — validated at the boundary.
  - Frontend: new `/devices/$deviceId/calibration` page, linked from the device detail page.
  - Verified against the mock provider via curl (temp admin user, cleaned up after): checksum
    matches hand-computed XOR, the "no species assigned" guard rejects correctly, and the full
    read → calibrate → re-read round trip reflects the newly written values.
- **Batch 7** ✅ (2026-07-28) — MQTT client + Home Assistant auto-discovery
  (`backend/src/mqtt/`: `topics.ts`, `discovery.ts`, `client.ts`, `publisher.ts`, `commands.ts`).
  Key decisions, confirmed with DestCom rather than assumed:
  - **Entirely optional**: `MQTT_URL` unset (the real default today — DestCom has no
    Mosquitto/Home Assistant instance to test against yet) means `connectMqtt()` returns `null`
    and every call site treats that as "skip publishing", never as an error. Nothing about backend
    startup depends on a broker being reachable.
  - **Scope, both explicitly chosen over the simpler/safer defaults**: a "Statut santé" HA sensor
    mirroring the Health Engine's `computeDeviceHealth()` output, and an "Arroser maintenant" HA
    **button** (not read-only sensors only). Home Assistant's MQTT button has no built-in per-press
    result channel, so `triggerWatering()` (`backend/src/watering.ts` — already shared by the
    manual `devices.water` mutation and the CRON scheduler) now also takes an optional MQTT client
    and republishes the outcome to a retained `.../watering/result` topic **regardless of trigger
    source**, extending the never-fire-and-forget rule (7.1) to the HA-visible side too.
  - **One JSON state topic per device** (`stroyplant/<id>/state`, `.../health`), each entity's
    discovery config pointing at it via its own `value_template` — not one raw MQTT topic per
    sensor field.
  - Discovery (HA auto-discovery format) is republished at startup for every already-named device,
    on `devices.rename`, and once from `onDeviceSeen` the first time a device transitions to named
    — the last one needed because the mock provider pre-names its devices directly (unlike real
    BLE providers), so it would otherwise never hit the `devices.rename` hook.
  - **Verified** against the mock provider using a disposable embedded MQTT broker (`aedes`, run
    standalone in the session scratchpad — the local Docker daemon wasn't running this session):
    startup discovery for every named device (including real devices already claimed in `dev.db`
    from earlier batches), live state/health publishing, a watering-button press on the
    empty-reservoir mock pot producing an explicit failure surfaced both as a
    `WateringEvent{success:false}` row and over MQTT, and `devices.rename` republishing discovery
    with the updated name. **Not yet validated against a real Mosquitto/Home Assistant instance**
    (none exists yet) — tracked as a follow-up once DestCom sets one up.
  - Full design detail in `docs/STROYPLANT_SPEC.md` section 7.7.
- **Batch 8** ✅ (2026-07-28) — MCP server (`backend/src/mcp/`: `context.ts`, `server.ts`,
  `routes.ts`), exposing `list_devices`, `get_plant_status`, `get_plant_history`, `trigger_watering`
  (spec section 7.8) via `@modelcontextprotocol/sdk`. Key decisions, confirmed with DestCom rather
  than assumed:
  - **Mounted on the existing backend, in HTTP** — a `/mcp` Streamable HTTP endpoint on the same
    always-running Fastify process (not a separate stdio process), reusing the same BLE
    provider/connectionQueue/MQTT client. Each request builds a fresh `McpServer` + stateless
    transport (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) bound to that request's
    authenticated caller — no session state kept in memory between calls, matching the SDK's own
    documented stateless-deployment pattern; simple request/response tools don't need more.
  - **Auth: BetterAuth's official `mcp` plugin (OAuth 2.1)**, not a static API key — chosen because
    it ships in the already-installed `better-auth` package (no new dependency) and is the
    protocol-correct mechanism real MCP clients expect. Wired in `auth.ts` (`loginPage: '/login'`,
    `oidcConfig.allowDynamicClientRegistration: true`). Needed 3 new Prisma models
    (`OauthApplication`/`OauthAccessToken`/`OauthConsent`, migration
    `20260728155824_add_mcp_oauth_tables`) — same schema the plugin's underlying `oidcProvider`
    uses, managed entirely by BetterAuth, never read/written by StroyPlant's own code.
  - **No custom consent page** — BetterAuth serves its own default consent HTML when `consentPage`
    is omitted, sufficient for this single-admin, personal-use deployment. No new frontend work at
    all: an unauthenticated `/mcp/authorize` redirects to the *existing* `/login` page, and
    BetterAuth's own after-hook (a signed `oidc_login_prompt` cookie) resumes the OAuth flow
    automatically once the user signs in normally.
  - **A tRPC context is synthesized from the OAuth session** (`mcp/context.ts`): only `userId` is
    real (resolved via Prisma), the rest is a minimal but type-compliant `Session`-shaped object —
    no procedure reads session fields beyond the truthiness check `protectedProcedure` already does,
    so this is safe. Lets the 4 tools call `appRouter.createCaller(ctx)` directly, reusing the exact
    same procedures the frontend uses rather than duplicating device/health/watering logic.
  - **`trigger_watering` never fails silently** (7.1, extended to the MCP-visible side): a caught
    `TRPCError` becomes a tool result with `isError: true` and the real error message, never an
    unhandled exception or a false success.
  - **Investigation correction, not an assumption**: initially believed (from an incomplete read of
    `better-auth`'s `mcp` plugin source) that it lacked Dynamic Client Registration (RFC 7591),
    entirely unlike a real MCP client's needs — flagged to DestCom, who chose to stay on stable
    `better-auth` regardless of that apparent gap. A closer, complete read of the same file found a
    `registerMcpClient` endpoint at `/mcp/register` after all — DCR **does** work out of the box,
    confirmed empirically (see below), and no version tradeoff was actually needed.
  - **`backend/src/api/webBridge.ts`** (new, shared by the pre-existing `/api/auth/*` passthrough
    and the new MCP/discovery routes): found and fixed a real gap while testing — Fastify only
    parses JSON bodies by default, but the OAuth token endpoint needs
    `application/x-www-form-urlencoded` per RFC 6749 (what real OAuth clients send); a raw
    passthrough content-type parser was added (`registerRawBodyParser`) so that content type
    reaches BetterAuth's handler unparsed instead of getting rejected with a Fastify 415.
  - **Verified end-to-end against the mock provider via curl**, entirely from outside the app (no
    real MCP client available in this environment): discovery metadata
    (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`), anonymous
    Dynamic Client Registration, the unauthenticated `/mcp/authorize` → `/login` redirect with the
    signed cookie, sign-in resuming the flow and redirecting back to the client's `redirect_uri`
    with a code, the PKCE token exchange, and all 4 tools called over `/mcp` with the resulting
    bearer token — including `trigger_watering`'s explicit failure on the empty-reservoir mock pot.
  - **Not yet validated**: an actual connection from Claude Desktop/Claude.ai's remote-connector UI.
    One specific open risk flagged to DestCom: the frontend's `/login` page signs in via a `fetch()`
    call (`authClient.signIn.email()`), and BetterAuth's OAuth-resume mechanism overrides that same
    response into a redirect toward the MCP client's `redirect_uri` — since `fetch()` follows
    redirects internally rather than navigating the browser tab, this may surface as a confusing
    "Connexion impossible" error in the UI even when the underlying authorization actually succeeded
    (the code still reaches the client). Not fixed pre-emptively since the real behavior depends on
    the specific `redirect_uri` Claude.ai's connector uses, which can't be verified without a live
    test — tracked as the first thing to check once DestCom tries a real connection.
- **Batch 9** ✅ (2026-07-28) — Docker environment: `Dockerfile`, `docker-entrypoint.sh`,
  `docker-compose.prod.yml`, `docker-compose.test.yml`, `.github/workflows/docker-publish.yml` (all
  repo root). Key points, full detail in `docs/STROYPLANT_SPEC.md` section 14:
  - **Static frontend serving + SPA fallback finally implemented**
    (`backend/src/api/staticFrontend.ts`) — required by the spec since section 14 was written, but
    nothing had built it until now. Registered last in `api/server.ts` so it can never shadow
    `/api/*`/`/mcp*`/`/.well-known/*`; skipped entirely (not an error) when the build directory is
    absent, so local `pnpm dev` (Vite's own dev server) is unaffected.
  - **Multi-stage build using `pnpm deploy --legacy`** (not a manual `node_modules` copy) for a
    real, non-symlinked, prod-only backend `node_modules` — `noble-bridge` excluded from the
    install scope entirely (its native macOS-only bindings fail building on Linux).
  - **Two empirical bugs found and fixed while actually building/running the image** (not just
    written and assumed correct): (1) `prisma generate` needs `openssl` present at build time too,
    not just runtime — without it, it silently guesses the wrong libssl version and crashes every
    query at container startup; (2) `frontend/package.json`'s build script ran `tsc -b` before
    `vite build`, which only ever worked by accident (a stale `routeTree.gen.ts` already on disk
    from a prior `pnpm dev`) — a genuinely clean checkout fails. Both fixed; `prisma` also moved
    from `devDependencies` to `dependencies` since `docker-entrypoint.sh` needs it at runtime to
    run `prisma migrate deploy` on every container start.
  - **GitHub Action builds both `linux/amd64` and `linux/arm64`** — the production server's CPU
    architecture isn't documented anywhere, so both are built rather than guessing one.
  - **Verified**: built and ran the image locally end-to-end with the mock provider — migrations
    applying on first boot, no Prisma engine errors, SPA fallback and API/MCP routing all behaving
    correctly. **Not yet verified**: the real `docker-compose.prod.yml` path against actual
    Bluetooth hardware on the production server (network_mode: host, node-ble) — tracked as a
    follow-up.
- **MQTT + Health Engine settings moved from env vars to the Settings page** (2026-07-28,
  post-Batch-9) — DestCom's explicit request: both were originally env-var-only (Batch 7's
  `MQTT_*`, Batch 4's `HEALTH_BASELINE_WINDOW_DAYS`/`HEALTH_WARMUP_MIN_DAYS`), now DB-backed and
  editable live with no restart/redeploy.
  - **`MqttSettings`** (singleton DB row) + `backend/src/mqtt/manager.ts`: the MQTT client is now a
    live-reconfigurable module-level singleton (`getMqttState()`/`reloadMqttClient()`, same pattern
    `db/client.js`'s `prisma` export uses) instead of a value dependency-injected once at startup
    through `TrpcDeps`/the scheduler/`triggerWatering()` — all of those dropped their `mqttClient`
    parameter entirely, now importing the manager directly where needed. New `mqtt.get`/`mqtt.upsert`
    tRPC procedures + a "MQTT / Home Assistant" card in `/settings`
    (`frontend/src/components/mqtt-settings-section.tsx`) with a live connected/disconnected badge.
    Password stored in cleartext (consistent with `BETTER_AUTH_SECRET`, no vault for this
    single-admin deployment), never sent back to the client (`hasPassword: boolean` only; a blank
    password field on save keeps the existing value, distinguished via `undefined` vs `null` in the
    zod input).
  - **`HealthSettings`** (singleton DB row) + `backend/src/health/settings.ts`
    (`getHealthSettings`/`upsertHealthSettings`): `computeDeviceHealth()` (`health/scoring.ts`) now
    takes `warmupMinDays` as an explicit parameter instead of reading `env` directly, keeping it a
    pure function — the 3 call sites (scheduler, `health.deviceHealth` tRPC query,
    `mqtt/publisher.ts`'s `publishHealthState`) each fetch the settings once and pass both values
    through. New `health.getSettings`/`health.upsertSettings` tRPC procedures + a "Moteur de santé"
    card in `/settings` (`frontend/src/components/health-engine-settings-section.tsx`).
  - **Verified against the mock provider**: MQTT settings round-trip via a disposable embedded
    broker (`aedes`) — save applying live (discovery republished, new connection established with
    no restart), the watering-button → `triggerWatering` → `publishWateringResult` chain still
    working end-to-end with the new parameterized topic settings, and the "blank password keeps
    existing" behavior. Health settings verified via the tRPC round trip
    (`getSettings`/`upsertSettings`/`deviceHealth` all consistent).
- **Next batch**: Batch 10 (extension to other devices — Flower Power, Flower Care).
- **`noble-bridge` validated with real hardware** ✅ (2026-07-27) — a real Parrot Pot
  (`PARROT-A073`) connected and read end-to-end (scan → connect → activate → read
  humidity/temp/luminosity/reservoir → deactivate → disconnect) via the Mac's Bluetooth, data
  flowing through to the frontend dashboard. The other devices in range (2nd Parrot Pot, several
  Xiaomi) were detected but not always read on the first try ("not found on scan" — noble-bridge's
  scan window closes before the device's next BLE advertisement; the retry on the next poll (~5
  min) resolves this in practice). One-off validation, not an automated regression test.
- **Not done / deferred**: validating `node-ble` under real conditions on the production server
  (Docker build + full deployment) — deliberately postponed by DestCom.
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
  src/health/      Health Engine (Batch 4): plant_profiles CSV import + scoring engine + settings.ts
                   (HealthSettings, DB-backed baseline/warm-up config, see Project status)
  src/mqtt/        MQTT + Home Assistant auto-discovery (Batch 7): topics, discovery payloads,
                   manager.ts (live-reconfigurable client singleton, DB-backed via MqttSettings),
                   publisher (state/health/watering-result), commands (HA button → watering)
  src/mcp/         MCP server (Batch 8): OAuth session → tRPC context (context.ts), the 4 tools
                   (server.ts), Fastify routes for /mcp + OAuth discovery metadata (routes.ts)
  src/db/          Prisma client
  prisma/          schema.prisma + migrations
frontend/        Vite + React SPA + TanStack Router/Query + Tailwind v4 + shadcn/ui (Batch 3)
  src/routes/      TanStack Router pages (file-based): login, _authenticated (layout+guard) and its children
  src/components/  Shell (sidebar), DeviceCard, SensorGauge, HistoryChart, shadcn components in ui/
  src/lib/         auth-client (BetterAuth), trpc.ts (tRPC client + TanStack Query options proxy),
                   use-live-readings (readings.onReading subscription)
noble-bridge/    Native macOS process (outside Docker), exposes the Mac's Bluetooth over HTTP/WS —
                 used by the backend's `noble-bridge` provider for dev without a Linux dongle
infra/lot0/      Docker+Bluetooth setup scripts/checklist on the production server
docs/            Full spec, Parrot Pot BLE reverse-engineering docs, frontend design import
Dockerfile, docker-entrypoint.sh, docker-compose.prod.yml, docker-compose.test.yml (Batch 9) —
  multi-stage image build + prod/smoke-test compose files, see docs/STROYPLANT_SPEC.md section 14
.github/workflows/docker-publish.yml (Batch 9) — builds + pushes to GHCR on push to main
```

## Backend — technical detail

- **Fastify** (chosen over Express — better native TS support, official WS plugin).
- **Prisma + SQLite**. `DATABASE_URL="file:./dev.db"` in `.env` — **resolved relative to the
  `schema.prisma` folder, not the cwd** (already-encountered trap: `file:./prisma/dev.db` would
  create `prisma/prisma/dev.db`).
- Business models: `Device` (id = uppercase colon-separated MAC, kind, name, lastSeenAt, optional
  `plantProfileId`) — `name = null` means "seen by the scanner, not yet claimed by the user" (Batch
  3's "Add device" screen, see Project status), the dashboard's `devices.list` only returns named
  devices), `Reading` (all sensor fields for both device types, optional, on a single table —
  including Batch 6's `isDrySoil`/`isWetSoil`/`isEmptyTank`/`isInAir` Plant Dr STATUS_FLAGS),
  `WateringEvent` (deviceId, triggerSource MANUAL/CRON, success, errorDetail), `PlantProfile` (Batch
  4, see below), `Schedule` (Batch 5, one optional row per device — deviceId, active,
  allowedStartHour/EndHour, cooldownHours; a missing row isn't "no schedule", it resolves to
  defaults, see Project status).
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
  Android/Bluedroid code**, to be refined empirically on the production server. On `noble-bridge`/macOS,
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
  flags: Parrot company ID (`0x0043`) confirmed via real capture on both production-server Parrot Pots
  (2026-07-28), but the payload is 3 bytes (not 1 as assumed) and their exact meaning isn't
  determined** — an active correlation protocol is defined but not executed (requires physical
  access to the pots), see `docs/STROYPLANT_SPEC.md` section 7.1 for the full detail and the
  baseline values already captured. Do not interpret the 3rd byte until this protocol has settled
  the matter.
- **Xiaomi LYWSD03MMC**: GATT, service `ebe0ccb0-...`, notify on `ebe0ccc1-...`, 5-byte payload
  `[int16 LE temp/100][uint8 humidity][int16 LE voltage mV/1000]`, battery% =
  `(voltage-2.1)*100` clamped 0-100. Formula confirmed by WatchFlower AND re-validated empirically
  on a real device.
- **tRPC (`src/api/trpc/`)**: `router.ts` combines `devices` (`list`, `listUnnamed`, `rename`,
  `history`, `wateringEvents`, `water`), `health` (`plantProfiles`, `assignPlantProfile`,
  `deviceHealth`, `getSettings`/`upsertSettings` — Health Engine baseline/warm-up config, DB-backed,
  see Project status), `mqtt` (`get`, `upsert` — MQTT broker config, DB-backed, see Project status),
  `schedule` (`get`, `upsert` — Batch 5 auto-watering config, see Project status),
  `plantDr` (`getCalibration`, `calibrateWet` — Batch 6 device-side calibration, see Project status)
  and `readings`
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
  with no rewrite needed — not added now. Since Batch 8, also runs the `mcp` plugin (OAuth 2.1 for
  the MCP server, see Project status) — a second, independent auth mechanism from the cookie session
  above, used only by `/mcp` and its OAuth endpoints under `/api/auth/mcp/*`.
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
  status — offline / low reservoir / Health Engine health / normal, filtered to named/"claimed"
  devices only), device detail (gauges with tone and expected species range as a legend, 24h-7d-30d
  history/graph via `recharts`, "Recent waterings" timeline, watering trigger with confirmation for
  Parrot Pots, "Species" section with picker/removal via `SpeciesPickerDialog` and a
  consumer-friendly explanation of the scoring, "Arrosage automatique" section — Batch 5, active
  toggle + allowed-hours window + cooldown, via `AutoWateringSection`, and a "Calibration Plant Dr"
  link — Batch 6, to its own page), "Add device" (claims a scanner-discovered, not-yet-named device
  by giving it a name — see the Project status section for why this differs from the prototype's
  literal manual-pairing concept), "Settings" (account section functional, auto-watering now links
  to the per-device page instead of "coming soon", notifications/MCP still shown as disabled
  "coming soon" cards pending Batches 7/8), "Calibration" (`/devices/$deviceId/calibration`, Batch
  6 — shows the device's current Plant Dr dry/wet thresholds live and a "capture wet point" action,
  gated on a species being assigned). **Not done yet**: global "History".
- App shell layout (`components/app-shell.tsx`): the sidebar is pinned to the viewport height
  (`h-svh` + `overflow-hidden` on the root flex row) and only the content `<main>` scrolls
  (`overflow-y-auto`) — fixed 2026-07-28 after the sidebar was found stretching to the full page
  height on long content pages instead of staying fixed on screen.
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
- The GATT_ERROR=133 heuristic on `node-ble`/BlueZ is best-effort, to be refined on the production server.
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

- The production server is reachable via a pre-configured SSH key/alias. `sudo` there prompts for
  an interactive password (no NOPASSWD) — for any command requiring root on the production server,
  ask DestCom rather than trying to work around it.
- Docker on the production server doesn't require `sudo` for the regular user — `docker run`/
  `docker compose` work directly over SSH for empirical testing (disposable containers recommended).
