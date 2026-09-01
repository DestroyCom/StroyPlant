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
- **3 more Parrot Pots acquired 2026-08-29** (DestCom, secondhand): 2x brick-colored on firmware
  `VE0.29.1` (same version already validated by this project, see `advertisement.ts`/
  `STROYPLANT_SPEC.md:135`) + 1x black on `VE0.28.5` (older, never tested by this project — no
  known reason it should behave differently given `node-ble`'s existing defensive per-characteristic
  best-effort reads, but not empirically confirmed). Only one MAC identified so far: one of the
  brick ones is `A0:14:3D:CD:87:33`, already added to production as `Parrot pot 8733` (no species/
  location set yet). The other 2 units' MACs aren't recorded here yet.

## Project status (by batch)

- **Batch 0** ✅ — Docker + Bluetooth validated on the real production server. Working config: `cap_add:
  NET_ADMIN, NET_RAW` + `network_mode: host` + mounting `/var/run/dbus/system_bus_socket` (no
  need for `privileged: true`). BlueZ had to be installed manually (`apt install bluez`, not
  present by default on the production server). Full detail in `infra/lot0/CHECKLIST.md`.
- **Batch 1** ✅ — Fastify + Prisma/SQLite backend, 3 interchangeable BLE providers, scanner +
  sequential connectionQueue, tRPC router + WS subscription (migrated from hand-written REST/raw
  WebSocket, see the tRPC migration entry below). See technical detail below. (The single
  always-on `scanner.ts` this batch introduced was later split into `discoverySession.ts` +
  `namedDevicePoller.ts`, 2026-07-30 — see the "Scoped BLE discovery" entry further down.)
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
- **Poll interval moved to the Settings page too** (2026-07-30) — same move as the entry above,
  for the last remaining env-var-only tunable (`PARROT_POLL_INTERVAL_MS`): DestCom's `todo.md`
  request to let users trade off data freshness against BLE/battery load without a redeploy.
  - **`PollSettings`** (singleton DB row, `pollIntervalMinutes`, default 5) +
    `backend/src/ble/pollSettings.ts` (`getPollSettings`/`upsertPollSettings`, same
    get-or-defaults shape as `health/settings.ts`). `ble/namedDevicePoller.ts`'s tick now fetches
    this fresh on every tick (same pattern `health/scheduler.ts` already uses for
    `getHealthSettings()`) instead of closing over a value passed once at `startNamedDevicePoller()`
    call time — a Settings save applies to the very next tick, no restart. The existing per-device
    exponential backoff on repeated failures (`consecutiveFailures`, capped at 1h) is unaffected —
    it multiplies whatever this base interval currently is, it doesn't replace it.
  - New `pollSettings.get`/`pollSettings.upsert` tRPC procedures + a "Synchronisation" card in
    `/settings` (`frontend/src/components/poll-settings-section.tsx`), same
    read-then-edit-then-save shape as `HealthEngineSettingsSection`. `env.parrotPollIntervalMs` and
    the `PARROT_POLL_INTERVAL_MS` env var are gone — `startNamedDevicePoller()` no longer takes a
    poll-interval parameter at all.
  - **Verified** via a scratch copy of `dev.db`: `getPollSettings()` returns the default (5) with no
    row yet, `upsertPollSettings()` persists a new value, and a re-read reflects it — the same
    round trip the tick reads on every iteration.
- **First real production incident** (2026-07-29) — the first real `node-ble` prod deployment
  crash-looped (`docker inspect`'s `RestartCount=60`), then — after a fix — silently stopped
  syncing entirely for 12h+ while staying up (not crash-looping), with the web UI also unable to
  trigger watering. Two separate rounds of fixes, both root-caused against real evidence (the
  actual installed `node-ble`/`dbus-next` source, and `docker logs`/`docker inspect` on the
  production server) rather than guessed:
  - **Round 1 — D-Bus match-rule leak** (commits `3d5b312`, `0a10413`, same day, not previously
    documented here): `node-ble`'s `Device` **and** `GattCharacteristic` wrappers both register a
    D-Bus `PropertiesChanged` match rule the moment any property/method is used —
    for `GattCharacteristic` that means *every* plain `readValue()`/`writeValue()` call, not just
    notification subscriptions — and only release it via `removeListeners()`, called exclusively
    from `disconnect()`/`stopNotifications()`. Every `scan()` tick's device property reads, every
    failed `connect()`, and every sensor read/write (soil/temp/lux/tank/conductivity/status-flags/
    watering-trigger/Plant-Dr-calibration) leaked one match rule forever with no release path.
    Enough leaks hit BlueZ's `max_match_rules_per_connection=512`, and the next registration threw
    an **uncaught** `DBusError` that crashed the whole process — the cause of the 60 restarts.
    Fixed with a `releaseDbusListeners()` backstop called from `scan()`'s per-device `finally`, a
    per-GATT-session `trackedCharacteristic()` helper releasing every characteristic used, and
    `connectDevice()` releasing listeners on a failed `connect()` too. **Verified already deployed**
    to production (`docker exec stroyplant grep -c trackedCharacteristic /app/dist/...` — present),
    so the crash-loop itself is resolved.
  - **Round 2 — scanner never recovers from a transient error** (this entry, same day, DestCom
    reported "plus de sync depuis 3h" the morning after round 1's deploy): despite round 1's fix
    being live and the container no longer crash-looping, all 5 devices still went completely
    silent for 12h+, confirmed via the *complete* raw `docker logs` (not just the pasted excerpt) —
    zero log output at all after one `[SCAN] Scanner (node-ble) stopped on error result=ERROR
    detail=Resource Not Ready` line, matching `docker inspect`'s single, 17h-old `StartedAt` (no
    further restarts — this is a hang, not a crash). Root cause, untouched by round 1:
    - `startScanner()` (`ble/scanner.ts`) launched `provider.scan()` exactly once at startup and
      only logged+gave up if it ever threw — nothing ever relaunched it. Fixed: `runScanLoop()` now
      relaunches `scan()` with a capped exponential backoff (5s → 60s, reset to 5s once a run has
      stayed healthy for 60s+), and also treats a clean-but-early return from `scan()` (violates its
      own documented "runs until abort" contract) as a failure to restart from, not a silent exit.
    - The `Resource Not Ready` that killed it was itself a race: `restartAdapter()` (`retry.ts`'s
      2-consecutive-GATT_ERROR=133 policy) power-cycles the adapter via `bluetoothctl power off/on`
      with zero coordination with the concurrently-running `scan()` loop sharing the same adapter
      object — a scan cycle landing mid-power-cycle throws. Fixed: each scan cycle in
      `node-ble/index.ts`'s `scan()` is now wrapped in its own try/catch that logs and retries after
      a short pause instead of letting the whole function die on what's usually transient —
      `runScanLoop()`'s restart above is now a safety net for anything unanticipated, not the
      primary defense.
    - Also hardened while in there: all 5 `device.disconnect()` call sites are now wrapped in
      `withTimeout` too (previously only `connect()`/`gatt()` were) — an un-wrapped hung
      `Disconnect()` D-Bus call would block the single sequential `connectionQueue` forever
      (polling *and* every future manual watering trigger), a plausible contributor to DestCom
      separately reporting the web UI's watering button not responding. `releaseDbusListeners()`
      (round 1) still runs unconditionally afterward, so this doesn't regress that fix.
  - **Verified against the mock provider** (real BLE hardware not available from this environment):
    booted the backend standalone twice against a scratch, migrated copy of the dev DB — confirmed
    `devices.forceSyncAll`/`devices.sync` (see below) round-trip correctly, log (never throw) on
    devices the mock provider doesn't know about, and `devices.water` still works end-to-end on
    both a healthy mock pot (success) and the empty-reservoir one (explicit `BAD_GATEWAY`, per the
    7.1 never-fire-and-forget contract) — no regression in the existing watering path.
  - **New: manual "Forcer la synchro" global sync** (DestCom's request, alongside the fix) — a
    `devices.forceSyncAll` mutation, added next to round 1's per-device `devices.sync` in
    `api/trpc/routers/devices.ts` and built the same way (same `connectionQueue`-serialized
    `readSensors` + `persistReading()` from `readings.ts` round 1 introduced), but for every named
    device and without awaiting each read to completion — a full sequential sweep across 5 devices
    can take well over a minute behind the connectionQueue, and each reading already pushes live to
    the frontend via the existing `readings.onReading` subscription as it lands, so the mutation
    only needs to confirm the syncs were queued. Dashboard gained a "Forcer la synchro" button
    (`frontend/src/routes/_authenticated/index.tsx`), separate from round 1's per-device "sync now"
    button on the detail page.
  - **Round 3 — truncated GATT buffer crashes the whole poll, ~21h of zero readings on all 3 real
    pots** (2026-08-31, found and fixed on `feature/parrot-device-side-autonomous-watering` right
    before merge): first flagged as `[[project_a073_sensor_read_crash]]`, a single-device incident
    deferred by DestCom on 2026-08-31 — checking production again the same day for an unrelated
    reason found it had grown into all 3 real Parrot Pots going completely silent (`RestartCount=0`,
    not a crash-loop — the process stayed up, just stopped persisting any `Reading` for any Parrot
    Pot for ~21h). Root cause confirmed via real `docker logs`: a Live-service float32 characteristic
    (`fa07`/`fa09`/`fa0b`) occasionally returns a truncated GATT response (`soil=00`, 1 byte instead
    of 4), and `Buffer.readFloatLE(0)` throws a bare `RangeError` on it — deep inside `readSensors`,
    only at reading-construction time after ~300 lines of by-then-wasted BLE reads (Plant Dr,
    watering config, calibration), and mislabeled by the retry wrapper as a connection/
    `GATT_ERROR=133` failure rather than a decode bug. The same pattern existed, unguarded, inside
    `subscribeLive`'s notification handlers too — a malformed live sample would throw synchronously
    inside an `EventEmitter` listener with no error handling at all.
    - **Fix**: `readFloatLESafe()` (`node-ble/index.ts`) centralizes the length check. `readSensors`
      now decodes right after the 3 initial reads instead of ~300 lines later — a malformed buffer
      fails fast with an accurate error, before wasting the rest of the attempt, letting the existing
      retry/backoff policy handle it as intended. `subscribeLive`'s `onSoil`/`onTemp`/`onLux` catch a
      malformed notification and skip it instead of throwing — the existing "wait for the first
      complete triple" gate in `scheduleFlush` already tolerates a missing value correctly, this just
      extends that same tolerance to an occasional malformed one instead of crashing the session.
    - **Deliberately not changed**: `ParrotPotReading.soilMoisturePercent`/`temperatureC`/
      `luminosity` stay non-optional, required fields — widening them to `number | undefined` would
      ripple into the Health Engine, MQTT publisher, and every frontend gauge for a fix that doesn't
      need it; a cycle with a malformed buffer still fails that one poll attempt cleanly (as it
      effectively already did), just without the wasted work or the misleading error label.
    - **Test coverage added**: `backend/src/providers/node-ble/index.test.ts` (the first test file
      for this provider — pure buffer-decode logic, no BLE/D-Bus needed) — `backend/package.json`'s
      `test` script glob widened to include `src/providers/**/*.test.ts`.
    - **Not yet re-verified against real hardware** — the fix is mock-provider/unit-test verified
      only (this class of BLE work can't be tested on Mac at all, matches this project's own
      convention). Next production deploy should confirm the 3 real pots start producing `Reading`
      rows again and that a "buffer malformed, skipped" log line (rather than a repeat of the
      21h-silence pattern) is what shows up on the next occurrence, whenever it recurs.
    - **Still open, unrelated to this fix**: whether `fixSoilMoistureTemperatureSwap.ts`
      (`backend/scripts/`, the fa07/fa09-swap historical data correction from 2026-08-29) was ever
      actually run against production — it has zero references anywhere in this file or any other
      doc, and production's `Reading.soilMoisturePercent` is 100% `NULL` across all 6249 historical
      Parrot Pot rows, consistent with either the script having run, or with historical moisture
      simply never having been recorded pre-fix. Not confirmed either way — check before relying on
      this column's historical data meaning anything.
- **Device location + indoor/outdoor, and post-deploy triage fixes** (commit `3d5b312`, same day as
  the incident above, not previously documented here) — bundled alongside round 1's match-rule fix:
  - `Device` gained `location` (free text) and `environment` (`INDOOR`/`OUTDOOR`, nullable) columns
    (migration `20260728221126_add_device_location_environment`), editable from the device detail
    page (`frontend/src/components/edit-device-dialog.tsx`) via the new `devices.updateDetails`
    mutation. **Storage only for now** — the Health Engine still scores every device against the
    same indoor-calibrated WatchFlower ranges regardless of this value (see `docs/HEALTH_ENGINE.md`
    and the `Environment` enum's comment in `schema.prisma`); how indoor/outdoor should actually
    affect scoring is an open decision, not made yet.
  - Species CSV import (`health/importSpeciesProfiles.ts`) is now idempotent and runs on every boot
    from `docker-entrypoint.sh`, matching how `seed-admin` already worked — it used to be a manual
    step nobody had run against production, which is why no species could be assigned post-deploy.
  - BetterAuth now trusts the reverse proxy's forwarded-for header (`auth/auth.ts`), fixing a
    "could not determine a client IP" rate-limit warning in the logs.
  - Hashed static assets served by `api/staticFrontend.ts` now get long-lived cache headers.
- **Live sensor mode** ✅ (2026-07-29) — real-time GATT sampling (continuous notifications, ~1/s for
  Parrot Pot, firmware-controlled for Xiaomi) instead of waiting for the scanner's ~5min poll.
  Backend (`src/liveSession/manager.ts`) + frontend (`LiveModeSection` component on device detail page)
  + new `liveSession` tRPC router (`status`, `start`, `stop`, `onSample` subscription). Full design rationale
  in `docs/superpowers/specs/2026-07-29-live-sensor-mode-design.md`. Key implementation decisions, all
  explicit:
  - **Single shared GATT connection constraint**: the project has exactly one dongle/connection at a time,
    shared by the scanner's ~5min poll, the auto-watering scheduler, and now live sessions. Bounding it:
    only one live session globally active at a time (a second attempt throws `CONFLICT` immediately, never
    silently queues); hard 5-minute auto-cutoff (`LIVE_SESSION_MAX_DURATION_MS`), even if the user stays on
    the page; ending a session (auto-cutoff / manual stop / leaving the page) immediately frees the queue
    for everything else.
  - **`Reading.source` tagging** (`POLL`/`LIVE`): persisted on every sample (written as `'POLL'` by
    `ble/scanner.ts` (renamed `ble/namedDevicePoller.ts` 2026-07-30, see below) and the manual sync
    mutations `devices.sync`/`forceSyncAll`, as `'LIVE'` by a live
    session). 4 read sites filter to `where: { ..., source: 'POLL' }` so a live session can never skew them:
    `health/scheduler.ts`'s `evaluateDevice`, `api/trpc/routers/health.ts`'s `deviceHealth`,
    `api/trpc/routers/devices.ts`'s `history`, and `mqtt/publisher.ts`'s `publishHealthState`.
  - **Final-review fix (2026-07-29)**: the backend-side filtering above was correct from the start, but a
    pre-existing file the branch never touched — `frontend/src/lib/use-live-readings.ts` (subscribes to the
    global, unfiltered `readings.onReading` WS event) — still needed a fix on the client side. It now (a)
    skips appending to the cached `devices.history` array entirely for a `LIVE` event (was polluting an
    already-open device detail page's chart with up to ~300 dense extra points, never invalidated back out
    once the session ended), and (b) merges a `LIVE` event into the cached `devices.list` `lastReading`
    instead of fully replacing it (a live Parrot Pot sample never reports
    `waterTankLevelPercent`/status flags/conductivity, so a full replace was silently nulling those out on
    the dashboard card for up to 5 minutes) — a `POLL` event still fully replaces as before, it's always
    complete. **Known low-priority consequence, not fixed**: `mqtt/publisher.ts`'s `publishReadingState` is
    called from `persistReading` for every reading regardless of source, so a live session's retained MQTT
    state would show the same partial payload to Home Assistant for up to ~5 minutes after the session
    ends — low real-world urgency today since MQTT/HA isn't validated against a real broker yet (see Batch 7
    above).
  - **Provider scope**: `mock` (full simulation with debouncing, used in dev/testing) and `node-ble`
    (production BlueZ/D-Bus) both implement real `subscribeLive(deviceId, kind, onSample, signal)` —
    Parrot Pot via GATT notify on the 3 sensor characteristics (soil/temp/lux), Xiaomi likewise. `noble-bridge`
    explicitly throws "not implemented" if called. **node-ble implementation unverified on real hardware**
    (matching the "not yet validated" phrasing used elsewhere for the same gap) — first live test happens
    on the production server once DestCom tries the feature.
  - **Abort-signal handling (node-ble)**: `subscribeLive` re-checks `signal.aborted` at multiple points
    during connection setup (connectDevice / gatt() / getPrimaryService / getCharacteristic / startNotifications),
    not just once at function entry — a race where an abort landed while connectDevice was blocked waiting
    ~20s for the device's next advertisement used to be lost (the live-notify loop, the only place with an
    abort listener, never got created to observe it), leaving the connection hung forever and starving
    `connectionQueue`. Fixed during Task 4 review.
  - **onSample error propagation (node-ble + mock)**: failures persisting a live sample (e.g., a transient
    DB write while the graph is updating) must end the session as a thrown error, never silently become an
    unhandled rejection. Both providers chain `onSample` calls with a pending promise that catches and
    rejects the session on error (Xiaomi notify loop and Parrot Pot debounce-flushed loop both use this).
    Fixed during Task 4 review.
  - **stopLiveSession timer cleanup**: `stopLiveSession(deviceId)` now also calls `clearTimeout()` on the
    pending auto-cutoff timer — without this, a manual stop racing a near-simultaneous auto-cutoff could
    let the timeout still fire after abort() (e.g. while GATT cleanup is in flight) and overwrite stopReason
    from 'stopped' to 'timeout', misreporting a manual stop as a timeout. Fixed during Task 4 review.
  - **Frontend UX**: on a non-manual end (timeout or `error` reason), displays a transient "Session terminée"
    notice with details (e.g., "Session terminée : coupure automatique après 5 minutes.") that auto-clears
    after 6s. Also auto-resumes watching an already-active session if the page reloads while one is running
    on that device (guarded against re-firing on the component's own `endSession()` call, a race that would
    otherwise mask the "session terminée" notice). Manual stops ('stopped' reason) need no extra message,
    the button's revert is feedback enough. Implemented via `hasAttemptedResumeRef`, checked once per mount.
  - **Verification**: end-to-end against the mock provider (real hardware unavailable in this dev environment)
    — session lifecycle (start/auto-cutoff/manual stop/error cases), the 5-min timer countdown, live sample
    persistence with correct `source='LIVE'` tagging, debouncing on the Parrot side, and the "session terminée"
    notices all working. Per-device page reload resume tested. **Known gap**: a full backend-process restart
    mid-session currently leaves the frontend's WS subscription stuck retrying with no error shown — a product
    decision (bounding retries or adding a client staleness timeout) not yet made, tracked as follow-up.
- **Responsive layout + global History page** ✅ (2026-07-30) — two independent pieces of work on
  the same branch: a responsive pass over the existing frontend (mobile header + bottom tab nav
  below `md` in `app-shell.tsx`, safe-area-aware padding for the iOS home-indicator area, mobile
  padding tweaks across the dashboard/detail/add/calibration pages), and a new global "Historique"
  page (`frontend/src/routes/_authenticated/history.tsx`) showing a day-grouped feed merging every
  `WateringEvent` and the new `SyncEvent` model (backend/src/api/trpc/routers/history.ts's `list`
  procedure), filterable by device and by period (all/7d/30d).
  - **`SyncEvent`** (new Prisma model, see the Business models entry above): persists sync/BLE read
    failures that used to only be logged to the console (`ble/scanner.ts`'s `pollDeviceNow`, since
    2026-07-30 `ble/namedDevicePoller.ts`'s `pollDevice`,
    `devices.ts`'s `sync`/`forceSyncAll`) — additive to that existing `log(...)` call, never a
    replacement (docs/STROYPLANT_SPEC.md section 7.1). **Only failures are persisted, never
    successes** — a successful sync already produces a `Reading` row proving it happened, so a
    success-case row would just duplicate that with no new information.
  - **Final-review fix (name filter)**: `history.list`'s "no `deviceId`" branch originally scoped to
    every device with no name filter, unlike `devices.list`'s own `name IS NOT NULL` filter — an
    unclaimed/unnamed device (e.g. a neighbour's Xiaomi the scanner discovers but nobody claims)
    would flood the unfiltered feed with its failed reads, potentially pushing real watering events
    out of the 200-row cap. Fixed to scope both the `WateringEvent` and `SyncEvent` queries to
    `device: { name: { not: null } }` when no explicit `deviceId` is given. Verified empirically: a
    temporary unnamed device + `SyncEvent` row were seeded, confirmed excluded from the unfiltered
    query and still reachable via an explicit `deviceId` filter, then cleaned up (`dev.db` diffed
    against a pre-test backup to confirm no residue).
  - **Final-review mitigation (dedup)**: a persistently unreachable device would otherwise write a
    near-identical `SyncEvent` row every ~5min forever. `persistSyncFailure`
    (`backend/src/readings.ts`) now skips the insert if the most recent `SyncEvent` for that device
    has the same `errorDetail` and landed within the last poll interval (`DEFAULT_POLL_INTERVAL_MS`,
    exported from `ble/scanner.ts` at the time — since 2026-07-30, `ble/namedDevicePoller.ts` — and
    imported here rather than duplicated as a second constant
    — a genuine module cycle between the two files, confirmed harmless empirically since the value is
    only read inside a function body called at runtime, never at module-evaluation time). **Broader
    `SyncEvent` retention/pruning policy (e.g. a cap or a TTL) is a deliberate, explicit open
    follow-up, not an oversight** — DestCom chose to defer that decision until real production
    volume data exists to inform it, this dedup is only a stopgap against the worst case in the
    meantime.
  - Final-review also fixed: the history page previously showed "Aucun événement pour cette
    période." during loading and on a genuine query error alike (plain `data` destructuring treated
    `undefined` the same as an empty array) — now renders distinct loading/"Chargement…", error
    (inline, `error.message`), and empty states; the device-filter `<select>` gained
    `aria-label="Filtrer par plante"` (no visible `<Label>`, consistent with the compact filter-bar
    layout); and `devices.ts`'s `sync` mutation now catches a `persistSyncFailure` failure the same
    way `forceSyncAll` already did, so a secondary DB error can never mask the real BLE error as the
    thing surfaced to the caller.
- **Scoped BLE discovery + direct MAC add** ✅ (2026-07-30) — `ble/scanner.ts`'s single
  always-on loop (continuous discovery of new devices AND periodic polling of claimed ones, mixed
  together since Batch 1) is split into two independent modules and deleted. Full design rationale
  in `docs/superpowers/specs/2026-07-30-scoped-ble-discovery-design.md`. Key decisions:
  - **`ble/discoverySession.ts`** — session-scoped discovery of *new* devices, structurally
    mirroring `liveSession/manager.ts` (module-level singleton, `AbortController`, 5-minute
    auto-cutoff). Only runs while `/devices/add` is open, started/stopped via the new
    `discoverySession` tRPC router (`status`/`start`/`stop`) rather than growing `devices.ts`
    further — a deliberate naming deviation from the approved design spec (which had proposed
    `devices.startDiscovery`/etc.), matching the already-established one-manager-module-plus-its-own-
    thin-router-file pattern this codebase uses for the equivalent `liveSession` feature.
  - **`ble/namedDevicePoller.ts`** — always-on timer (started unconditionally at backend startup,
    matching `health/scheduler.ts`'s pattern) polling only already-named devices directly by MAC
    address, entirely independent of whether a discovery session is running. `lastSeenAt` fix
    (design spec's central correctness requirement): since discovery no longer runs continuously,
    a successful poll now updates `Device.lastSeenAt` itself (previously only `onDeviceSeen` did) —
    otherwise a perfectly healthy, actively-polled device would start showing "hors ligne" after 10
    minutes. `devices.sync`/`forceSyncAll` (manual sync mutations) updated the same way for
    consistency, in the same fix wave (a manual sync succeeding is equally strong evidence of
    "online").
  - **`devices.addByAddress`** (new tRPC mutation) — registers a device directly by its known MAC
    address (zod-validated `AA:BB:CC:DD:EE:FF` format), named immediately, no discovery session
    needed. A wrong/unreachable address surfaces through the existing `SyncEvent`/history feed like
    any other poll failure — no special-cased validation beyond the format check. Frontend: a small
    form on `/devices/add` alongside the auto-discovered list.
  - **Final-review fix (critical) — `connectDevice()`'s own discovery-on-forever leak**: pre-existing
    code (since Batch 1, harmless at the time because the old `scanner.ts` already kept discovery on
    forever anyway) turned BlueZ discovery on before `waitDevice()` but never turned it back off.
    Once discovery was scoped to only run during an explicit session, this silently defeated the
    entire point of this branch on real `node-ble` hardware: the very first `namedDevicePoller` read
    would turn discovery on and it would never turn off again. Fixed with a module-level
    `scanSessionActive` flag (set for the duration of `scan()`'s loop, in a `try/finally`) so
    `connectDevice()` only stops discovery if IT turned it on for this call AND no `scan()` session
    currently depends on it staying on. **Not fully provable against the mock provider** (it doesn't
    model real BlueZ discovery state) — real-hardware verification (`bluetoothctl show`'s
    `Discovering:` flag staying off across multiple poll cycles with no session active) is a
    follow-up requiring production SSH access.
    - **Known minor gap, found during the fix-wave's own re-review, not yet fixed**: the
      `scanSessionActive` flag and `connectDevice()`'s discovery-stop aren't a real lock — a narrow
      TOCTOU race exists where `connectDevice()` reads no session is active and starts
      `stopDiscovery()`, and *during that D-Bus round-trip* a new discovery session starts and reads
      `isDiscovering()` as still (stale-)true, so it skips its own `startDiscovery()` call; when
      `connectDevice()`'s stop then actually lands, discovery is off for up to one `scan()` cycle
      (≤ ~1 min) even though a session believes it's active. Self-heals at that session's next cycle
      (`scan()` re-checks `isDiscovering()` every iteration) — never a permanent stuck-off state, just
      a missed scan window. Not fixed now (a boolean flag can't fully close this, would need a real
      mutex/generation-counter); fold into the same production-server verification pass as the
      critical fix above rather than treating as a separate task.
  - **Final-review fix (important) — discovery-session ownership**: `stopDiscoverySession()` had no
    way to tell whose session it was stopping — any caller (e.g. a page instance that never
    successfully started its own session after a hard reload skipped its cleanup) could stop
    whatever session happened to be active, including a different, legitimate one (another tab's).
    Fixed by having `startDiscoverySession` generate and return a session id (`node:crypto`'s
    `randomUUID()`); `stopDiscoverySession(sessionId)` is now a no-op unless the id matches the
    currently active session. The frontend tracks the id it was given in a `useRef` (not `useState`
    — the unmount cleanup closure needs the latest value) and only ever stops that specific session.
  - **Final-review fix (important) — frontend never observed the 5-minute auto-cutoff**:
    `/devices/add`'s "Recherche en cours…" state was local, never synced with backend reality, so it
    kept showing active (and kept refetching `listUnnamed`) forever past the backend's own
    auto-cutoff. Fixed by deriving it from a polled `discoverySession.status` query
    (`refetchInterval: 5000`), following `live-mode-section.tsx`'s exact precedent for the same
    class of problem on `liveSession`.
  - **Final-review fix — progressive backoff for a permanently-failing device** (DestCom's explicit
    request, found while reviewing `addByAddress`'s failure path): a typo'd/unreachable MAC address
    used to get retried at the normal ~5min interval forever, each attempt costing up to ~55s on the
    shared `connectionQueue` (node-ble's retry/timeout policy) that blocks manual watering, sync,
    live sessions, and the auto-watering scheduler in the meantime. Fixed with a per-device
    consecutive-failure counter in `namedDevicePoller.ts`; the effective poll interval scales as
    `pollIntervalMs * 2^failures`, capped at 1 hour, reset to the normal interval on any success — a
    healthy device (0 consecutive failures) is completely unaffected.
  - Stale UI copy referencing the old always-scanning behavior (dashboard empty state, `/settings`'s
    "Ajouter un appareil" card description) reworded to describe the new session-scoped reality.
  - **Verified against the mock provider**: `backend`/`frontend` build and typecheck cleanly;
    `discoverySession`'s start/reject-second-session/stop/auto-cutoff lifecycle and
    `namedDevicePoller`'s independence from any discovery session were already proven per-task
    before this final pass; this pass additionally traced the session-id ownership logic by hand
    (own-id-null → no stop call; id-mismatch → no-op) rather than a live multi-tab browser test.
    **Not verified**: `connectDevice`'s discovery on/off bookkeeping against real BlueZ (see above)
    — the mock provider has no discovery state to observe.
  - **Regression found and fixed post-deploy (2026-07-30)**: `onDeviceSeen`'s `upsert` (this file)
    was silently reverting user-given device names back to the raw BLE name — see the "Second
    production incident round" entry further down for the full detail and fix.
- **Onboarding stepper** ✅ (2026-07-30) — replaces the old "type a name, done" add-device flow.
  Naming a device (via `devices.rename` on a discovered device, or `devices.addByAddress` by MAC)
  now redirects into a new dedicated page,
  `frontend/src/routes/_authenticated/devices.add_.$deviceId.onboarding.tsx` (URL
  `/devices/add/$deviceId/onboarding` — the `add_` filename segment un-nests it from
  `devices.add.tsx`, same escape hatch as the earlier `devices.$deviceId_.calibration.tsx` fix),
  walking through up to 3 further steps, each independently skippable and each backed by the
  same procedure the device detail page already uses on its own:
  - **Emplacement** (`devices.updateDetails` — location + indoor/outdoor, storage only, see the
    device location/environment entry above).
  - **Espèce** (`health.assignPlantProfile`) — the search-and-assign UI was extracted out of
    `SpeciesPickerDialog` into a shared `frontend/src/components/species-search.tsx`
    (`SpeciesSearch`) so the dialog (device detail page) and the wizard step share the exact same
    behavior; the dialog keeps its own "Retirer l'espèce actuelle" button and closes on assign,
    the wizard step doesn't.
  - **Arrosage automatique** — only appears if the device is a Parrot Pot AND a species was just
    assigned (recomputed live off wizard state, mirroring `AutoWateringSection`'s own
    `hasSpeciesAssigned` gating). Reuses `AutoWateringSection` verbatim, unmodified — no
    duplicated scheduling logic.
  - **Design decisions, confirmed with DestCom before implementation**: a dedicated full page
    (not a modal) over `/devices/add`'s pre-existing list, chosen for consistency with
    `/devices/$deviceId/calibration` already being its own route rather than a dialog; and this
    stepper **replaces** the old one-shot naming flow entirely rather than being an opt-in
    "guided setup" alongside it.
  - **Abandon-safe by construction**: naming the device (the one non-skippable step) already
    happens before this page loads — leaving the wizard at any point (closing the tab, refreshing)
    never leaves a broken device, only one with unset location/species/auto-watering, exactly as
    if the user had never opened this page and configured everything later from the device detail
    page instead.
  - **Verified manually** (DestCom, against the mock provider — no BLE hardware needed since none
    of the 3 steps touch BLE): full add-by-address → 3-step wizard → dashboard/detail-page
    handoff, including both "Passer" and "Suivant" on different steps and the species search
    against the real seeded WatchFlower CSV data (3404 profiles).
  - **Permanent local dev admin account**: `admin@admin.com` / `admin` (seeded via
    `pnpm seed:admin`) — reused across dev-only manual verifications instead of throwaway
    accounts per session, since this is local `dev.db`, never a shared/production database.
- **Second production incident round — connect-failure resilience** (2026-07-30) — DestCom reported
  3 separate symptoms after the scoped-BLE-discovery deploy; root-caused against real
  `docker logs stroyplant` on the production server (`ssh omv`), not guessed:
  - **Custom device names silently reverting to the raw BLE name**: `discoverySession.ts`'s
    `onDeviceSeen` (see the scoped-BLE-discovery entry above) unconditionally wrote
    `name: device.name` on its `upsert`'s `update` branch — `device.name` is always the raw
    BLE-advertised name (real providers never populate anything else, `providers/types.ts`'s
    `DiscoveredDevice`), so re-seeing an already-claimed device during any later discovery session
    (i.e. every time `/devices/add` was reopened) silently reverted its user-given name. Fixed by
    dropping `name` from the `update` branch entirely — only `create` (a genuinely new, unclaimed
    device) sets it from the advertisement. Verified against a scratch copy of `dev.db`: claim →
    re-discover → name unchanged.
  - **History page flooded with "Operation already in progress"**: confirmed via
    `docker logs --since 6h` — every occurrence followed the exact same pattern, a `TIMEOUT: connect
    (18000ms)` on attempt 1 immediately followed by "Operation already in progress" on attempts 2
    and 3 (308 occurrences in 6h, mostly against a weak-signal/likely-neighbour Xiaomi and
    occasionally the 2nd Parrot Pot). Root cause: `connectDevice()`'s `withTimeout(device.connect(),
    ...)` only stops the backend from *waiting* on a timed-out connect — it never cancels the
    underlying BlueZ `Connect()` D-Bus call, which keeps running server-side. The very next retry
    (500ms later) issues a *second* `Connect()` for the same device while BlueZ still considers the
    first one in flight, and BlueZ immediately rejects that with `org.bluez.Error.InProgress`
    ("Operation already in progress") — a message `isGattError133` doesn't recognize, so it never
    triggers an adapter restart either, it just repeats every poll cycle. Fixed by calling
    `device.disconnect()` (best-effort, timeout-wrapped) in `connectDevice()`'s catch branch when
    `connect()` itself fails, telling BlueZ to cancel the stuck attempt before the next retry.
  - **Live mode dying on `le-connection-abort-by-local`**: confirmed via the same logs — the one
    real live-session attempt in the window never reached "Activate live measure period (live
    session)" at all, meaning it died inside `connectDevice()` itself, with zero retry.
    `subscribeLive` deliberately never retries the streaming loop once started (documented reason:
    restarting a multi-minute session from scratch after it already streamed real samples would be
    wrong) — but its one-shot initial connection had also never been given the standard
    3-attempt/backoff/adapter-restart retry every other BLE operation in this file already gets,
    unlike what the original comment implied. Confirmed with DestCom before changing this
    (a previously deliberate design decision) — added `connectDeviceWithRetry()`, wrapping only the
    initial `connectDevice()` call in both `subscribeLive` branches (Xiaomi and Parrot Pot) with the
    same `withGattRetry` policy; the no-retry-once-streaming behavior is untouched.
  - **Not yet re-verified against real hardware** (all 3 fixes reason from evidence in the actual
    production logs, but the fixes themselves haven't been redeployed/observed yet) — next deploy
    should confirm the "already in progress" flood stops and a fresh live-mode attempt survives a
    transient connect failure.
- **GlitchTip error monitoring** ✅ (2026-07-31) — self-hosted, Sentry-compatible (`@sentry/node` +
  `@sentry/react`, both v10), wired into backend and frontend. Optional and off by default
  (`SENTRY_DSN` unset → `Sentry.init()` never called, both sides). Key decisions:
  - **DSN is a runtime-only value, never a build-time one** — DestCom's explicit requirement,
    since this repo's Docker image is published publicly
    (`.github/workflows/docker-publish.yml`); a Vite `VITE_SENTRY_DSN` env var would have baked
    this deployment's GlitchTip domain into the public image's bundled JS forever. Instead: the
    backend reads `SENTRY_DSN` from its container env (same pattern as every other backend env
    var, `env.ts`) and serves it through a new unauthenticated `GET /api/public-config`
    (`api/server.ts`) — deliberately unauthenticated since it must be reachable before login and a
    DSN isn't a secret by Sentry's own convention, just not something to leave sitting in a public
    artifact. `frontend/src/instrument.ts` fetches it and calls `Sentry.init()` before the app
    renders (`main.tsx` awaits `initSentry()` ahead of `createRoot(...).render(...)`); on fetch
    failure it silently no-ops rather than blocking boot.
  - **Backend**: `backend/src/instrument.ts` must be the literal first import in `index.ts` (before
    `fastify`/`node-ble`/etc. load) for the SDK's auto-instrumentation to patch them correctly —
    no `--import`/preload flag used (would need separate dev/prod script and Docker `CMD` changes
    for marginal benefit given this app's simple Fastify setup); a plain first-import is
    sufficient since ES module imports evaluate in the order listed. `Sentry.setupFastifyErrorHandler(app)`
    registered before any route (Fastify requires this ordering, unlike Express). The fatal
    `main().catch(...)` startup handler (`index.ts`) now also calls `Sentry.captureException()` +
    `await Sentry.flush(2000)` before `process.exit(1)` — previously only logged to console, never
    reported anywhere off-box.
  - **Frontend**: React 19 — both `Sentry.reactErrorHandler()` on all three `createRoot` options
    and a top-level `Sentry.ErrorBoundary` (French fallback UI, "Recharger la page" button) are
    wired, per the SDK's own React-19 guidance (belt and suspenders — the hooks catch what escapes
    a boundary, the boundary gives a real fallback UI for a caught render error).
  - **Deliberately NOT wired**: automatic forwarding of every existing `log({result: 'ERROR' |
    'TIMEOUT'})` call (`logger.ts`, ~29 call sites across BLE retry/scan/watering/mqtt code) into
    Sentry. Most of those are expected, self-healing, already-retried transient BLE conditions
    (see the "Second production incident round" entry above) — piping all of them through would
    flood GlitchTip with retry noise and defeat the point of crash alerting. What's wired instead
    is the SDK's own baseline (uncaught exceptions, unhandled rejections, Fastify route errors,
    React render crashes) plus the one true "the process is dying" case
    (`main().catch()` above). Flagged as a deliberate scope call, not an oversight — DestCom can
    ask for specific catch sites (e.g. `triggerWatering()`'s failure path) to also report to
    Sentry if the baseline proves insufficient.
  - **Tracing**: low `tracesSampleRate` (0.01 prod / 1.0 dev) on both sides, matching GlitchTip's
    own setup doc — secondary to error monitoring, not the goal. No session replay, logging, or
    profiling signals wired (not requested, and GlitchTip's feature support for those is limited
    or nonexistent — session tracking specifically isn't supported at all, per GlitchTip's docs).
  - **Verified locally** (mock provider, scratch DB copy): `/api/public-config` returns the real
    DSN when `SENTRY_DSN` is set and `null` when unset; a built frontend bundle was grepped to
    confirm no DSN string appears anywhere in it, only the runtime `fetch('/api/public-config')`
    call; both packages typecheck and build cleanly. **Not verified**: an actual event landing in
    GlitchTip (would require sending a real test error to DestCom's live instance, not done
    without asking) — next step is DestCom setting a real `SENTRY_DSN` and triggering a manual
    test error to confirm end-to-end delivery.
- **Soil conductivity self-calibration + full raw sensor log** ✅ (2026-07-31) — replaces the
  broken WatchFlower-borrowed conductivity formula (see `docs/HEALTH_ENGINE.md`'s "Soil
  conductivity / fertility index — history" section for the full backstory) with a per-device,
  self-improving calibration, plus a comprehensive raw-sensor debug log. Full design rationale in
  `docs/superpowers/specs/2026-07-31-soil-conductivity-self-calibration-and-raw-sensor-log-design.md`.
  Key decisions:
  - **Confirmed broken on real hardware first, not just suspected**: both real Parrot Pots read
    raw `fa02` values (775, 983) below WatchFlower's hardcoded `RAW_MIN=1500`, permanently clamping
    "Fertilité du sol" to 1000/1000 (max) on both — a live wrong-data bug, not cosmetic. Surveyed
    16 community Parrot/Flower-Power repos plus the 3 official `Parrot-Developers` org repos before
    concluding no validated fix formula exists anywhere to borrow — this project has to derive its
    own from real accumulated data instead of picking new constants from a single reading.
  - **Write-time → read-time interpretation**: providers (`mock`/`node-ble`/`noble-bridge`) now
    persist only the raw `fa02` uint16 (via the new `RawSensorLog` table, below) — they no longer
    write `Reading.soilConductivityUsCm` at all going forward (the column stays in place,
    historical rows keep their old frozen values, no backfill/migration). The "fertility" value is
    now derived on demand — Health Engine scoring, the frontend gauge, and `devices.ts`'s `history`
    procedure (joining each `Reading` to its `RawSensorLog.soilConductivityRaw`) all call
    `resolveConductivityValue()`/`decodeSoilConductivityRaw()` with the device's *current*
    calibration bounds, so a device's whole history benefits every time its calibration improves —
    it's never frozen against stale bounds again.
  - **Calibration confidence gate** (`backend/src/health/soilConductivityCalibration.ts`,
    `getCalibration()`): per-device all-time min/max of its own raw `fa02` readings (scoped to
    `Reading.source = 'POLL'`, same convention as every other Health Engine baseline calculation, so
    a live session can never skew it), **never expiring** — DestCom's explicit choice over a
    rolling window, since an old extreme (e.g. a fertilizer event months ago) is still real evidence
    of the widest range this specific device has shown, not something to discard as "stale." Gated
    by two plain exported constants (deliberately not a `Settings` DB row — YAGNI until there's a
    reason to tune this live): `MIN_CALIBRATION_DAYS = 14` and `MIN_CALIBRATION_RAW_RANGE = 50` (on
    the ~0-2047 raw ADC scale) — both must be satisfied before `calibrated` flips true, since
    plenty of readings piled up in a short window still isn't proof of the device's real range.
    Until then, `computeDeviceHealth()` reports a new `ParameterStatus` value, `'calibrating'`
    (`health/scoring.ts`), scoped to just this one parameter — it does not push the whole device
    into the coarser `warming_up` status, and is treated like `'n/a'` for `hasOutOfRange` purposes
    (never counted as out-of-range). Frontend gauge shows "Calibration en cours" in that state
    (same slot as the existing n/a handling, distinct label). **Consequence of no backfill**: every
    real device's conductivity calibration restarts at "calibrating" for at least 14 days
    post-deploy, even `PARROT-A073`, which already had history under the old formula — `RawSensorLog`
    genuinely didn't exist before this and has no historical raw data to draw on.
  - **`RawSensorLog`** (new Prisma model, migration `20260731095003_add_raw_sensor_log`, 1:1 via a
    unique `readingId` FK) — a debug/audit trail, not a UI-facing feature, capturing literally every
    known Parrot Pot/Xiaomi raw characteristic on every successful poll, decoded or not, used or
    not: the full Live service (`fa01`-`fa0e`, including the confirmed-dead `fa0c`/`fa0d`/`fa0e`,
    recorded as `null` rather than omitted), the Watering config service (`f903`-`f912`, previously
    untouched during normal polling), the remaining Plant Dr fields (`fd81`-`fd89`, previously only
    read on-demand via `plantDr.getCalibration`, now also read every regular poll), the Calibration
    service (`fe01` raw hex blob, `fe04`), and Xiaomi's temp/humidity/voltage raw values. Every
    field individually best-effort (matches the existing `soilConductivityRaw`/`STATUS_FLAGS`
    pattern) — one missing/errored characteristic never fails the rest of the poll. **Explicit
    non-goals**: no frontend UI surfaces any of this (debug/audit only), no retention/pruning policy
    yet (same open-ended stance as `SyncEvent` — revisit once real production volume exists, not a
    decision to make from zero data), and `39e1fe01`'s calibration blob semantics / the dead
    `fa0c`/`fa0d`/`fa0e` characteristics are logged as raw bytes only, not decoded. **Practical
    consequence**: a normal Parrot Pot poll now opens 4 GATT services (Live, Watering, Plant Dr,
    Calibration) instead of 3 — more individual read steps, each individually fail-safe, within the
    same already-open GATT session (no extra connect/disconnect overhead).
  - **Final-review fix (critical) — Live-service raw reads ordered after deactivation**: the 7 new
    Live-service raw reads (`lightRaw`/`soilTempRaw`/`airTempRaw`/`soilMoistureRaw`/`eaRaw`/
    `ecbRaw`/`ecPorousRaw`, `backend/src/providers/node-ble/index.ts`) originally landed AFTER the
    `measurePeriod.writeValueWithResponse(Buffer.from([0]))` live-mode deactivation call — this
    project's own documented invariant (see the Parrot Pot section below) is that the Live service
    stops refreshing once `fa06=0` is written, so those reads would have silently returned
    stale/frozen values with no error to reveal it, exactly the kind of silent-corruption bug this
    whole feature exists to avoid for conductivity specifically. Caught during this task's own
    review (not by a later production incident) and fixed in a follow-up commit (`b10288c`) moving
    all 7 reads to before the deactivation call, right after the existing `soilConductivityRaw`
    read on the same service — `STATUS_FLAGS` (a different GATT service, Plant Dr, with no
    measure-period gate) correctly stays read after deactivation, unaffected by this fix.
  - **`noble-bridge` scope cut**: updated for interface consistency only — forwards the new raw
    Live-service fields (`soilConductivityRaw`/`lightRaw`/`soilTempRaw`/`airTempRaw`/
    `soilMoistureRaw`, `noble-bridge/src/parrot.ts`) so dev-on-Mac readings populate the same
    `RawSensorLog` columns as the other providers, but does **not** gain Watering/Plant-Dr/
    Calibration-service parity — matches its existing lower-priority "Mac dev tool, not production"
    status (see the `DeviceProvider` section below), not validated against real hardware for this
    change specifically.
  - **Verified**: `mock` provider updated to simulate plausible raw values with enough variation
    over simulated time for the calibration gate to flip to `calibrated` in tests; full workspace
    build (`pnpm -r build`) passing across `backend`/`frontend`/`noble-bridge`. **Not yet
    re-validated against real Parrot Pot hardware** post-deploy (the original 775/983 raw readings
    that motivated this fix came from a one-off disposable-container test, not a running
    deployment) — next step is confirming both real pots actually reach `calibrated: true` after
    14+ days of normal polling in production.
- **Health Engine consistency fixes** ✅ (2026-07-31) — an independent audit of the Health Engine, run
  deliberately without reading project documentation (code + real `dev.db` data + the decompiled
  official Parrot app only, DestCom's explicit request), found 5 issues; a 6th, unrelated but minor
  finding from an external (non-DestCom, non-this-assistant) review of the wider codebase was
  cross-checked against the real code and folded in alongside them (most of that external review's
  other claims either restated already-known/correct behavior or were themselves mistaken — e.g. a
  claimed "duplicate poll" bug in `namedDevicePoller.ts` that doesn't exist, the code's actual
  ordering exists specifically to prevent that). Full design in
  `docs/superpowers/specs/2026-07-31-health-engine-consistency-fixes-design.md`.
  - **Indoor luminosity floor comparison**: `Device.environment === 'INDOOR'` now switches the
    luminosity comparison to a floor-only check against a published low/medium/high-light houseplant
    DLI category (2/5/10 mol/m²/day, derived from the species' own outdoor CSV minimum) instead of
    the outdoor-oriented CSV range directly — a real production Parrot Pot reads as low as 0.1
    mol/m²/day, structurally `too_low` forever against the CSV's typical 2-7.5 mol/day minimums.
    `OUTDOOR`/unset devices unaffected.
  - **Personal-deviation signal**: `ParameterHealth` gained `personalDeviation`
    (`'unusual_low'/'unusual_high'/'normal'`, mean ± 2σ against the device's own history, excluding
    the recent-hour slice) — additive/display-only, deliberately never influencing `status`,
    `hasOutOfRange`, or `health/scheduler.ts`'s auto-watering trigger (confirmed explicitly with
    DestCom given the real-world consequence of loosening that condition).
  - **Conductivity calibration**: bounds switched from the device's all-time absolute raw min/max to
    the 5th/95th percentile — an isolated spurious raw reading can no longer permanently redefine the
    whole 0-1000 output scale and silently reshape historical chart values.
  - **`DeviceHealth.warningParameters`**: the frontend's `healthHeadline` (`format.ts`) used to pick
    the first `too_low`/`too_high` parameter via `Object.entries(...).find(...)`, silently relying on
    `PARAMETERS_BY_KIND`'s array order to avoid surfacing conductivity (excluded from the badge) as a
    warning's cause. `computeDeviceHealth` now exposes the authoritative list directly.
  - **Frontend**: new `SensorGauge` `notice` tone (muted, distinct from the orange `warning`) for
    informational-only out-of-range parameters (conductivity today) plus a `personalDeviationHint`
    shown on every gauge; `rangeHint`/`referenceLinesFor` handle an open-ended (`null`) upper bound
    for the indoor-luminosity case.
  - **`namedDevicePoller.ts`**: `lastPolled`/`consecutiveFailures` Maps now pruned of deleted devices
    on every tick (the one legitimate finding from the external review).
  - **Verified**: all changes are pure computation/UI logic, no new migration. Backend logic verified
    via scratch-copy-of-`dev.db` scripts (percentile calibration resists an outlier, indoor
    luminosity floor + personal baseline behave as expected, poller pruning removes only deleted
    devices); frontend verified against the mock provider in a real browser session (notice tone,
    explanatory hint text, open-ended range display).
- **Health Engine consistency fixes — Part H, real daily light integral** ✅ (2026-08-03) — added to
  the same batch above after SSH'ing into the production server and pulling 5 days of real `Reading`
  rows for both real Parrot Pots, prompted by DestCom noticing the dashboard calling out "not enough
  light" at times a plant obviously couldn't be receiving any (nighttime). The real data showed the
  luminosity comparison was broken at any time of day, not just at night: `39e1fa0b` behaves as an
  instantaneous reading (flat ~0.1 mol/day overnight, ~70 mol/day peak at solar noon on one real
  pot), not a true daily total, so comparing it directly against a full-day species threshold was
  structurally invalid. `health/dailyLightIntegral.ts`'s `computeDailyTotals()` (new file) now
  trapezoidal-integrates each raw reading across real calendar days (in a new
  `HealthSettings.timezone`, editable on `/settings`, default UTC) into a true daily total — this,
  not the old hourly average, is what `luminosity`'s status now compares, across every environment
  (not just indoor, unlike Part B above). A day is only "complete" if no gap between consecutive
  readings exceeds 2h, and the still-in-progress current day is never counted. Zero complete days
  yet reuses the existing `'calibrating'` status (Part D). The gauge separately shows the live
  instantaneous reading (informational only), and a "Lumière insuffisante depuis 3 jours" advisory
  appears if the 3 most recent complete days were all `too_low` — a single overcast day never
  triggers it. `personalDeviation` is deliberately left at `'normal'` for luminosity (Part C's
  instantaneous-value baseline isn't meaningful against a daily total; not asked for during
  brainstorming, flagged as a possible future follow-up rather than silently attempted).
  - **Verified**: `computeDailyTotals` against synthetic day/night data (a gapped day correctly
    excluded, today never included, a plausible mid-range total for a clean sun curve); full
    `computeDeviceHealth` integration against a scratch `dev.db` copy (3 good days → `ok` status +
    `luminosityRecentDaysTooLow: false`, a brand-new device with < 1 day of history → `'calibrating'`
    with a populated `liveValue`); `HealthSettings.timezone` default/round-trip/invalid-rejection.
    **Not yet re-validated against the real production Parrot Pots** (the 5-day dataset that
    motivated this fix predates the fix itself) — next deploy should be followed by checking both
    real pots' luminosity status once a few real calendar days have accumulated under the new logic.
- **Settings page: 2-column layout + running-version display** (2026-08-13) — two small,
  unrelated fixes bundled together after DestCom noticed both while checking whether the Phase B
  shadow-mode toggle had reached production:
  - **Layout**: `/settings` was capped at `max-w-xl` and stacked every card in a single column
    regardless of viewport, wasting most of the screen on desktop. Switched to a CSS grid
    (`grid-cols-1 lg:grid-cols-2`, `max-w-5xl`) — single column below `lg`, unchanged on mobile.
  - **Version card** (`frontend/src/components/version-settings-section.tsx`) — surfaces which
    commit is actually running and warns when GitHub's `main` has moved past it, prompted directly
    by that same incident: the code was already merged and pushed to `origin/main`, but the
    production container was still serving the old image with no way to notice from the UI.
    - The Docker image now bakes the git SHA at build time: `Dockerfile`'s new `GIT_SHA` build
      arg (empty by default for a local `docker build`) is set from `github.sha` by
      `.github/workflows/docker-publish.yml`, exposed to the running container via `env.gitSha`
      (`backend/src/env.ts`), and surfaced read-only through the existing unauthenticated
      `GET /api/public-config` endpoint (same pattern already established for `sentryDsn` — see
      the GlitchTip entry above — not a secret, this repo is public).
    - The frontend card fetches `/api/public-config` for the running SHA and, separately,
      GitHub's public REST API directly from the browser (`GET
      /repos/DestroyCom/StroyPlant/commits/main`, unauthenticated, no backend involvement) for the
      latest `main` HEAD. A mismatch shows a warning badge + a reminder to `docker compose pull &&
      up -d` — purely informational, never blocking: a local dev build (`GIT_SHA` unset) or a
      failed/rate-limited GitHub fetch both silently show no warning rather than an error.
    - **Deliberately no automated "check for updates" polling or push notification** — this is a
      single-admin tool, checked whenever `/settings` happens to be open, not a monitored fleet.
  - **Verified**: `pnpm typecheck`/`pnpm build` (frontend) and `tsc --noEmit` (backend) both clean,
    repo-wide `pnpm lint` clean. **Not yet verified**: an actual mismatched-version render (would
    need a real stale production container or a deliberately wrong `GIT_SHA` build) — the
    match/no-warning case was confirmed via a local dev build (`gitSha: null` → no badge, "build
    de développement local" message).
- **`plantDr.calibrateWet` made non-blocking — Cloudflare 502 root-caused** (2026-08-29) — DestCom
  ran a real wet-point capture on `PARROT-A073` (Pot blanc) after acquiring 3 more secondhand
  Parrot Pots and revisiting the still-never-calibrated device flagged in the soil-conductivity
  work; the UI showed "Échec de la calibration" with a description mentioning "DOCTYPE" every time.
  Root-caused with real evidence rather than guessed (systematic-debugging): first hypothesis
  (SWAG's reverse-proxy timeout) was checked directly against `/config/nginx/proxy.conf` on the
  server and **falsified** (240s, far more than needed) before being ruled out — the real cause,
  confirmed from the browser's own Network tab, was **Cloudflare** (`plant.stroyco.eu` sits behind
  it, in front of SWAG) returning its own 502 HTML page once its origin timeout (~100s, not
  configurable on a standard plan) elapsed, which the tRPC client then failed to `JSON.parse`,
  surfacing as `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. `calibrateWet` ran 2
  sequential `connectionQueue`-serialized BLE operations (read then write), each with its own
  up-to-3-attempt/backoff/adapter-restart retry policy — easily exceeding ~100s when queued behind
  another device's poll, exactly as seen in `docker logs` at the time. Confirmed the device itself
  had actually been calibrated correctly on at least one of the failed-looking attempts (the
  displayed wet threshold kept changing between retries, e.g. 22.5%→22.8%) — the backend was doing
  its job, only the HTTP response was getting lost.
  - **Fix**: `calibrateWet` no longer blocks on the full sequence — it validates synchronously
    (species/dry-threshold check, unchanged, still fails immediately with a real error), then kicks
    off the read+validate+write chain in the background and returns `{status: 'started'}`
    immediately. New module `backend/src/plantDrCalibrationSession.ts` tracks per-device run state
    (`idle`/`running`/`success`/`error`), exposed via a new `plantDr.calibrationRunStatus` query —
    same module-singleton-plus-polled-status shape as `liveSession`/`discoverySession`, chosen over
    `forceSyncAll`'s "fire and rely on an existing DB-persisted side effect" pattern since a
    calibration write has no DB row to piggyback on (the device is the only source of truth, section
    7.11). Frontend (`devices.$deviceId_.calibration.tsx`) polls the new status query
    (`refetchInterval`, 1.5s while running) instead of reading the mutation's own result, showing
    "Calibration en cours…" until it resolves — this also means a page reload no longer loses track
    of an in-flight capture the way a single blocking request would have. A second click while one
    is already running now gets a clean `CONFLICT` instead of silently overlapping.
  - **Verified against the mock provider**: `tsc --noEmit`/`tsc -b` (backend + frontend) and
    `biome check` on the touched files clean, all 128 pre-existing backend tests still passing
    (untouched code path), and a live curl-driven run — `calibrateWet` returns `{status:'started'}`
    immediately, `calibrationRunStatus` reflects `running` then `success` with the correct written
    values, `getCalibration` reflects them afterward, and the synchronous no-species-assigned guard
    still fails immediately as before (not deferred into the async path). **Not yet re-verified
    against the real Cloudflare/SWAG path in production** — next real capture attempt on Pot blanc
    (or any future manual BLE action) should confirm the button now returns instantly with no
    DOCTYPE error, regardless of how long the actual BLE sequence takes underneath.
- **In-app notification bell** ✅ (2026-08-29) — the first, minimal piece of the "alertes réservoir
  bas, appareil hors ligne ou score de santé dégradée" promise the Settings page's "Notifications"
  card has always described (see the entry below for that card's own status). Real-time push
  notifications are still out of scope (separate, unplanned batch) — this is an always-visible,
  in-app substitute: a bell icon in `app-shell.tsx` (both the mobile header and the desktop
  sidebar, so it's visible on every authenticated page, not just the dashboard) with a count badge,
  opening a `Dialog` listing each alert with a link to the relevant device. No dismiss — an alert
  stays until the underlying condition clears, DestCom's explicit choice over a localStorage-backed
  "seen" state, to never risk hiding a real ongoing problem.
  - **No new backend endpoint**: `frontend/src/lib/notifications.ts`'s `computeDeviceAlerts` is a
    pure function reusing `format.ts`'s existing `isDeviceOnline`/`isTankLow`/`statusHeadline` —
    same priority order as the dashboard card badge (hors ligne > réservoir bas > santé "warning"),
    so the two can never disagree about what counts as a real issue. One additional, independent
    line fires on `health.deviceHealth`'s `luminosityRecentDaysTooLow` even when the primary status
    is otherwise `ok`, since that's deliberately a separate advisory (Part H), not a substitute for
    the per-parameter check.
  - **Real bug found and fixed while verifying this in a browser** (not just typechecked/linted —
    see the "Fastify's router caps..." entry in Gotchas below for the full detail): mounting
    `NotificationBell` app-wide meant every page now fires one `health.deviceHealth` query per
    named device on top of whatever that page already queries, and tRPC's batch link joins every
    simultaneous query's procedure *name* into one URL path segment — routinely exceeding Fastify's
    default 100-char cap on a single dynamic segment (`FST_ERR_MAX_PARAM_LENGTH` → 414), breaking
    data loading for that whole batch on any page with enough devices. Fixed at the source
    (`Fastify({ maxParamLength: 2000 })`, `api/server.ts`) rather than by reducing how many queries
    the bell fires. Also switched `httpBatchLink` to `methodOverride: 'POST'`
    (`frontend/src/lib/trpc.ts`, paired with the new `allowMethodOverride: true` the Fastify tRPC
    plugin needs server-side to accept it) — an independent, correct hardening even though it
    turned out not to be the actual fix for this specific bug — batched GET queries were still
    putting every input in the URL query string, which has the same kind of length ceiling as the
    path did.
  - **Verified**: `tsc --noEmit`/`tsc -b` (backend + frontend) and `biome check` on every touched
    file clean, all 128 pre-existing backend tests still passing. Manually verified in a real
    browser (Playwright) against the mock provider: the bell renders with the correct count on the
    dashboard, the dialog lists every alert with the right message and links to the right device,
    and — after the maxParamLength/methodOverride fixes — the device detail page (the specific
    route that surfaced the 414) loads with zero console errors.
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
- **Horticultural inference engine — V1 vertical slice, Phase A** ✅ (2026-08-10, on branch
  `worktree-inference-engine-v1`, not yet merged to `main`) — the first step of a multi-phase
  replacement for the Health Engine (`backend/src/health/`, still the live/production code path;
  nothing below is wired into any real consumer yet). Full design in
  `docs/superpowers/specs/2026-08-07-horticultural-inference-engine-design.md` (RFC, DestCom-approved
  after several rounds of review) and `docs/superpowers/plans/2026-08-07-horticultural-inference-engine-v1-slice.md`
  (18-task implementation plan, executed via subagent-driven-development with a task review + fix
  loop after every task, plus a final whole-branch review). Explicitly positioned as a rule-based,
  deterministic, explainable expert system — never an LLM making the diagnosis, never a black-box
  model — see the RFC's "Non-negotiable principles" section.
  - **What was built**: a 5-layer pure-function pipeline (`backend/src/inference/`) —
    Measurements → Indicators (4: rolling soil-moisture/temperature averages,
    `dryingRateDeviationSigma`, `wateringIntervalDeviationSigma`) → Facts (3, boolean+confidence
    only, no severity) → Symptoms (2: `water_stress`, `irregular_watering`, graded 0-1 severity) →
    Diagnosis (1: `chronic_underwatering`) → Recommendation (1: `TRIGGER_WATERING`), orchestrated by
    a fully domain-blind `InferenceEngine` class (`engine.ts` — contains zero concrete rule ids
    anywhere, mechanically enforced by `validateRegistry()` at construction time). Every rule
    composes exactly 2 canonical evidence-combination functions (`combineWeightedEvidence` for
    severity, `combineNoisyOr` for confidence, both in `evidence.ts`) — no rule ever reimplements
    combination math; a whole-branch audit confirmed this held uniformly across all 4 rule layers.
  - **Species-blindness**: the engine core never imports `PlantProfile` — only
    `referenceProfile.ts`'s `resolveReferenceProfile()` may, mechanically enforced by
    `backend/scripts/checkInferenceBoundary.ts` + `.github/workflows/inference-boundary-check.yml`
    (recursive filesystem scan, fails CI on any other file importing it). Verified twice: once per
    its own task, once again independently by direct `grep` during the final whole-branch review.
  - **Two statistical safety fixes, both DestCom-directed rather than plan-literal** (found during
    implementation, not anticipated by the RFC): (1) `dryingRateDeviationSigma`/
    `wateringIntervalDeviationSigma` floor their baseline standard deviation
    (`MIN_STDDEV_PERCENT_PER_DAY`/`MIN_STDDEV_HOURS`) so a device with a very *stable* history can't
    produce an artificially huge, physically meaningless z-score from near-zero natural variance —
    the most stable, healthiest devices were the ones structurally most exposed to this false
    signal before the fix; (2) `engine.ts`'s `classifyTiers` gained a `MINIMUM_REPORTABLE_IMPORTANCE`
    noise floor after the end-to-end integration test (Task 16) revealed a healthy device could still
    produce a spurious near-zero `weak_hypothesis` diagnosis purely from an always-slightly-nonzero
    evidence term (a `sigmoid()`-transformed temperature contribution) — distinct from the existing
    `WEAK_HYPOTHESIS_IMPORTANCE_THRESHOLD`, which classifies tier among findings that already clear
    this floor.
  - **Final whole-branch review** (independent of the 18 per-task reviews) additionally fixed: a
    cross-task regression where a concrete rule name leaked back into an `engine.ts` comment after
    being removed once already; a real bug in `reconcileRecommendations` where merging two
    same-action Recommendation candidates took the max `confidence`/`importance` but silently kept
    whichever candidate's `urgency` was evaluated first, never comparing via the existing
    `URGENCY_RANK` table (unreachable today — only one `RecommendationAction` exists — but fixed
    now while `engine.ts` is undisturbed); `SymptomResult`/`DiagnosisFinding` widened to carry
    `severityBreakdown` AND `confidenceBreakdown` (previously only the confidence-producing
    `combineNoisyOr` breakdown was kept, meaning `severity` — the number a user actually sees —
    was not explainable by descending the evidence tree, contradicting an explicit RFC guarantee);
    CI wiring so `pnpm test`/`tsc --noEmit`/`biome check` actually run on every PR touching
    `backend/src/inference/`, not just the species-blindness script.
  - **Deliberately deferred as a single "before Phase C wiring" checklist** (documented in a comment
    atop `registry.ts`, DestCom-approved, zero risk while the module stays unwired): `AvailabilityReason`
    is never actually set by any adapter (`EvidenceBreakdown.missing` always reports `sensor_absent`
    regardless of the real reason); no clock injection (all 4 Indicators call `Date.now()` directly,
    so the pipeline is not replayable/reproducible against historical readings, undermining the
    RFC's stated reason for not persisting the full evidence tree); the two rolling-average
    Indicators' stale-data fallback has no age bound (a device offline for months could still
    produce a confident-enough value reaching `TRIGGER_WATERING`); `dryingRateDeviationSigma` buckets
    days in hardcoded UTC rather than the device's configured timezone, unlike this codebase's own
    established convention (`health/dailyLightIntegral.ts`'s `HealthSettings.timezone`).
  - **Verified**: 91 tests (`cd backend && pnpm test`, Node's built-in `node:test` via `tsx` — the
    first test infrastructure this monorepo has ever had), `tsc --noEmit` and `biome check` both
    clean, all independently re-run and confirmed during the final review rather than only trusted
    from per-task reports. An end-to-end integration test (`registry.test.ts`) proves the full
    `chronic_underwatering` slice fires correctly against hand-crafted 40-day synthetic
    healthy/underwatered device histories, run through the real wired `InferenceEngine` — not just
    unit-tested in isolation.
  - **Not done**: no consumer is wired to `inferenceEngine` yet — no tRPC procedure, no MQTT
    publisher, no MCP tool, no scheduler change. `backend/src/health/` remains the only code path
    actually read by the app today. The RFC's own 5-phase Migration Plan (shadow mode → migrate
    read-only consumers → migrate the auto-watering scheduler only after zero-disagreement
    verification → cleanup) is the deliberate next step, not started.
- **Inference engine — Phase A hardening** ✅ (2026-08-11) — fixed the 4 findings the V1 slice's
  final whole-branch review had deferred as a "before Phase C wiring" checklist (comment atop
  `backend/src/inference/registry.ts`), per DestCom's explicit request to resolve them now rather
  than carry them into Phase C. Full design in
  `docs/superpowers/specs/2026-08-10-inference-engine-phase-a-hardening-design.md`. Still entirely
  isolated under `backend/src/inference/` — no consumer wiring, same as the entry above.
  - **Clock injection**: `InferenceEngine.run` gained an optional 5th parameter, `now: Date = new
    Date()`, threaded down into every `IndicatorDefinition.compute(observations, environment, now)`
    call — all 4 Indicators now use the injected `now` instead of reading `Date.now()`/`new Date()`
    internally, making the pipeline genuinely replayable against historical readings (the RFC's own
    stated justification for not persisting the full evidence tree).
  - **Staleness bound**: the two rolling-average indicators' stale-data fallback (last 5 readings
    when nothing is within the last hour) now discards the fallback entirely — returning `{ value:
    null, confidence: 0 }` instead of a falsely-confident stale average — if the most recent
    fallback reading is more than `MAX_STALE_FALLBACK_AGE_MS` (24h, an initial engineering estimate)
    old.
  - **Timezone-aware day bucketing**: `EnvironmentContext` gained an optional `timezone` field
    (IANA name, defaulting to `'UTC'`). `dryingRateDeviationSigma`'s day-bucketing `dayKey` helper
    now uses it via the same `Intl.DateTimeFormat`/`en-CA` technique already used by
    `health/dailyLightIntegral.ts`'s own `dayKey` — deliberately duplicated, not imported, since
    `backend/src/inference/` must never depend on any other part of the app. Closes a ~2h/day blind
    spot right after UTC midnight where the "today" bucket couldn't span the minimum window for a
    device whose real local day had already been running for hours.
  - **`AvailabilityReason` threading (Indicator level only)**: `IndicatorValue` gained an optional
    `unavailableReason` field, set by all 4 Indicators on every null-returning path
    (`'no_recent_data'` vs. `'insufficient_history'`, per indicator) and read by `adapters.ts`'s
    `indicatorEvidence`, which now populates `EvidenceBreakdown.missing` with the real reason
    instead of always defaulting to `'sensor_absent'`. Deliberately not threaded further through
    Facts/Symptoms/Diagnoses in this pass (DestCom's explicit choice) — `registry.ts`'s comment now
    records this as the one remaining deliberately-deferred residual.
  - **Verified**: full `pnpm test` suite (all existing tests plus new determinism/staleness/
    timezone/`unavailableReason` cases) and `tsc --noEmit`/`biome check` both clean.
- **Inference engine — Phase B, shadow mode** ✅ (2026-08-12) — the RFC's Migration Plan's first
  real step: the new engine now runs *alongside* the legacy Health Engine on every scheduler tick,
  for every named Parrot Pot with a species assigned, and logs+persists a structured comparison
  whenever they disagree. The legacy engine (`computeDeviceHealth`) remains the **sole** authority
  for the dashboard and the **sole** input to the real auto-watering trigger — nothing about real
  watering behavior changes in this phase. Off by default (`HealthSettings.shadowModeEnabled`,
  toggle in `/settings`'s "Moteur de santé" card). Full design in
  `docs/superpowers/specs/2026-08-11-inference-engine-phase-b-shadow-mode-design.md`, implementation
  plan in `docs/superpowers/plans/2026-08-11-inference-engine-phase-b-shadow-mode-plan.md` (7 tasks,
  subagent-driven-development, one task needed a fix round, one coordinated final-review fix wave).
  - **`backend/src/health/inferenceShadow.ts`'s `evaluateShadow(device, healthSettings)`** — the
    only file that imports both engines. Re-fetches its own `readings`/`wateringEvents` and calls
    `computeDeviceHealth()` a second time rather than threading `evaluateDevice`'s already-computed
    state out to the caller — deliberate isolation over micro-optimization, since refactoring the
    safety-critical `evaluateDevice` to expose state on every one of its early-return paths wasn't
    worth the risk for a handful of devices evaluated once every ~5-15min. Runs **unconditionally**
    with respect to `evaluateDevice`'s own schedule-active/allowed-window/cooldown gates — shadow
    mode wants to see what the new engine would say even when the legacy engine wouldn't act, so
    those only feed `OperationalConstraints` as inputs to the new engine's Recommendation
    confidence, never as early returns. Gated (does nothing at all) only when the legacy status is
    `'warming_up'` or `'no_profile'` — neither engine's status is meaningful yet in that state.
  - **Wired into `scheduler.ts`'s `tick()`** as an independent step, in its own try/catch, strictly
    *after* (never inside) the existing `evaluateDevice()` call for the same device — a
    shadow-evaluation failure can never affect or be masked by the real watering-decision path.
    `evaluateDevice()`'s own body and try/catch are untouched (verified byte-for-byte by two
    separate task reviews, given the safety stakes).
  - **`toLegacyDeviceHealth`/`collectMainDifferences`** (`backend/src/health/
    inferenceShadowMapping.ts`) — the only two **pure** functions in this feature, with real
    `node:test` coverage (the first automated tests anywhere outside `backend/src/inference/` in
    this project's history; `pnpm test`'s glob widened to `'src/inference/**/*.test.ts'
    'src/health/**/*.test.ts'`). `toLegacyDeviceHealth` maps the new engine's diagnoses to a
    legacy-comparable status (`dominant`/`secondary` tier → `'warning'`, everything else → `'ok'`).
    `collectMainDifferences` walks a diagnosis's evidence tree — recursively descending into a
    symptom-sourced item's *own* evidence too, not just one level — collecting the `migrationNote`
    of every Fact/Symptom that meaningfully contributed (a final-review fix: the one-level version
    missed Fact-level notes nested inside Symptom evidence, since the only registered Diagnosis
    consumes only Symptoms, never Facts directly — the strongest evidence in a real underwatered
    scenario was going unexplained until this was caught).
  - **`migrationNote?: string`** — new optional field on `FactDefinition`/`SymptomRule`
    (`backend/src/inference/types.ts`), a static French explanation of what a rule newly considers
    that the legacy engine didn't. Set on 2 of the 3 Facts and the 1 Symptom (`soil_moisture_below_
    profile_min` has a direct legacy equivalent, so it never explains a real divergence on its own).
  - **`ShadowDivergence`** (new Prisma model) — one row per genuine divergence, deliberately lighter
    than the RFC's full `DiagnosisEvent`/`Contributor`/`Recommendation` schema (that's a later
    increment for aggregate Success Metrics, not needed for manual review). **Deduped**: skips the
    write (and the log) if the device's most recent row within one scheduler-tick interval already
    has the same `legacyStatus`/`inferenceDiagnosisId`/`inferenceTier` — mirrors `readings.ts`'s
    `persistSyncFailure` pattern, added in the final-review fix wave after the first pass would have
    written a near-identical row every tick forever for any persistently-diverging device (~1,350
    rows/week for two real pots). No UI yet — reviewed via Prisma Studio/SQL for now, matching how
    `SyncEvent` was reviewed before the History page existed.
  - **Deliberate deviation from the RFC's literal text**: the RFC triggers the shadow comparison on
    the `health.deviceHealth` tRPC query (UI-driven); this phase triggers it on the scheduler's
    periodic tick instead (DestCom's explicit choice) — needed for the RFC's own "Detection
    metrics" (time-earlier-detection) to be measurable at all, since a query-driven trigger only
    produces data whenever someone happens to have the dashboard open.
  - **Two real bugs caught by task review before merge, not after**: (1) a plan-authoring mistake
    (mine, not an implementer's) — `cooldownActive` was computed from the last *successful*
    watering event only, diverging from `evaluateDevice`'s real semantics (any outcome, including
    failures, extends the cooldown) — fixed to match exactly. (2) The `collectMainDifferences`
    one-level-walk gap described above, caught only at the final whole-branch review since no
    single task's diff-scoped review could see that Task 2's notes and Task 5's wiring didn't
    actually meet in the middle.
  - **Not done / deliberately out of scope**: no automated integration tests for the
    Prisma-touching `evaluateShadow` itself (matches this project's established convention —
    `backend/src/health/` has never had automated DB-backed tests; verified manually against a
    scratch copy of `dev.db` instead, including a full end-to-end scheduler-tick run with the mock
    provider). No feature flag beyond the one settings toggle (the RFC's `INFERENCE_ENGINE_ENABLED`
    env var and per-device override are Phase C/D concerns — shadow mode never makes a real
    decision, so an incident kill switch isn't needed yet).
  - **Discovered, unrelated, flagged separately**: `cd frontend && pnpm typecheck`/`pnpm build`
    currently fails on 5 `erasableSyntaxOnly` TypeScript errors in `backend/src/inference/
    engine.ts`'s `InferenceEngine` constructor (parameter-property shorthand, e.g. `constructor(
    private indicatorDefs: ...)`) — `frontend/tsconfig.app.json`/`tsconfig.node.json` set
    `erasableSyntaxOnly: true` while `backend`'s own isolated `tsconfig.json` doesn't, and
    `frontend`'s `tsc -b` project-references `backend`'s sources. Confirmed pre-existing (introduced
    in the original V1 slice, commit `ab6efd0`, weeks before this branch) and confirmed untouched
    by any of this branch's commits — every prior verification in this project's history only ever
    ran `backend`'s isolated `tsc`, never `frontend`'s project-referenced build, so this has
    apparently been silently broken since the inference engine first shipped. **This means the
    Docker image build (`frontend/package.json`'s `tsc -b && vite build`) currently cannot succeed
    from a clean checkout** — a real, pre-existing shipping blocker, not a cosmetic nit, tracked as
    a separate follow-up (not fixed here — out of scope for shadow mode, and the fix itself is a
    judgment call: rewrite the constructor to non-parameter-property style, or rescope
    `erasableSyntaxOnly`).
  - **Verified**: full `pnpm test` (128/128, up from 115 pre-branch) and `tsc --noEmit`/`biome
    check` (backend's own isolated config) both clean; `evaluateShadow` manually verified against a
    scratch `dev.db` copy (healthy-agreement → zero writes; genuine divergence → one correctly-shaped
    row + log line); the full `scheduler.ts` wiring manually verified end-to-end (mock provider,
    shortened tick interval, ~10 ticks, real divergences detected/logged/persisted, `evaluateDevice`
    unaffected); the frontend toggle's save→DB→full-page-reload→still-checked round trip verified
    directly (Playwright) after the task's own manual-verification narrative proved insufficient.
- **Parrot plant database import** ✅ (2026-08-29, on branch `feature/parrot-plant-database-import`,
  not yet merged to `main`) — `PlantProfile` gains a second, higher-priority data source: the
  official "Flower Power" iOS app's own bundled plant database (8090 species,
  manufacturer-calibrated for this exact sensor hardware), extracted from the app bundle on
  DestCom's Mac (`/Applications/Flower Power.app`) and overlaid onto the existing 3404-row
  WatchFlower import on every container boot. Full design rationale and every decision below in
  `docs/superpowers/specs/2026-08-29-parrot-plant-database-import-design.md`, implementation plan
  in `docs/superpowers/plans/2026-08-29-parrot-plant-database-import-plan.md` (9 tasks,
  subagent-driven-development with a task review + fix loop, plus a coordinated final perf fix).
  - **Source priority, confirmed live with DestCom**: for the ~3400 species present in both
    datasets, Parrot's values win for every field it actually provides (soil moisture via
    `vwc_dry`/`vwc_wet`, temperature, light, conductivity) — WatchFlower remains the *only* source
    for soil pH and air humidity, since Parrot's dataset has no equivalent there. Made with full
    awareness this immediately changes the Health Engine's live status and the Batch 5
    auto-watering trigger condition for already-assigned real devices the moment this import runs
    against production. **Real-hardware consequence, confirmed on a scratch copy of the real
    production `dev.db`**: `PARROT-A073` (species Alcea rosea, already assigned from earlier
    testing) saw its soil moisture range shift from 15-60% to 32-51% and its soil conductivity
    range from 350-2000 to 1000-3000 µS/cm — proof the overlay actually took effect on an
    already-assigned real device, not just on paper.
  - **Stored ahead of the consumer, nothing wired to read it yet** — same posture this project
    already uses for Plant Dr calibration fields (Batch 6): multi-locale (7 languages: DE/EN/ES/
    FR/IT/JA/ZH) free text (`PlantProfileTranslation`, 56490 rows), filter-taxonomy attribute codes
    (`PlantProfileAttribute`, 77641 rows), fertilizer types (`PlantProfileFertilizerType`, 9308
    rows), search names (`PlantProfileSearchName`, 201305 rows), and an archival, deliberately
    locale-scoped attribute-number mapping (`PlantAttributeNumberMapping`, 630 rows = 90 codes × 7
    locales; `PlantProfileAttributeNumber`, 641165 rows) — the last one confirmed to differ between
    locales for the same code, so it's stored but must never be read as if it were universal.
    Irrigation/command soil-moisture thresholds (`vwc_irr`/`vwc_cmd` + eco variants) and calibration
    sample counts (`n_wet`/`n_irr`/`n_irr_eco`) are stored the same way — a real anomaly was found
    here (`n_wet=288` on 8089/8090 species, plus `n_irr`/`n_irr_eco` varying 0/384/672) but not
    acted on: `backend/src/plantDr.ts`'s `calibrateWet` still writes `n=0` unchanged, this is a lead
    for the separately-planned BLE-sniff phase (understanding the official app's real protocol
    behavior), not this batch's job.
  - **Sentinel values kept raw, not nulled**: `dli_max=99` (7239/8090 species) and `ec_min=-1`
    (432/8090 species, 358 of them overlapping with the dli_max sentinel — 7313/8090 species
    affected by at least one) are Parrot's own generic per-sun/water-category
    defaults, not real per-species measurements — confirmed by cross-checking against the
    `sun`/`water` ordinal categories rather than assumed from the value alone. DestCom's explicit
    choice to keep them raw rather than null them: accepted consequence is that the Health Engine's
    range check becomes practically always-satisfied (not literally absent) for the affected
    parameter on those species — flagged explicitly since a future direct query (Prisma Studio, an
    admin UI) could otherwise mistake a sentinel for a real threshold.
  - **Real duplicate-name data-quality finding, ruled not fixed**: Parrot's own source data has 10
    duplicate `fullname` values among its 8090 species (e.g. "Abelia hybrids" under two different
    `parrotSpeciesId`s, one of them the generic-catch-all-looking `99999`), orphaning ~20 species
    (~0.25%) across every downstream Parrot table via last-write-wins on the name-based upsert —
    confirmed by `PlantProfileTranslation`'s skip count (140, not the expected 0) and
    `PlantProfile`'s total (9120, not the ~9138 a clean 1:1 join would produce). Accepted as a
    narrow, upstream-data-quality-caused limitation — no real assigned device is among the affected
    species, and re-deriving the match key from name to `parrotSpeciesId` would be a larger
    architecture change disproportionate to the value.
  - **Real performance finding + fix**: the full import (`pnpm import:species`) initially took 8
    minutes 9 seconds against the real data, dominated by ~641,165 individual unbatched sequential
    `upsert()` calls in `importParrotAttributeNumbers()`, each an implicit SQLite auto-commit with
    its own fsync — a genuine operational risk, not just slowness, since `docker-entrypoint.sh` runs
    this import on every container boot and each import function's idempotency gate ("any rows
    exist → skip entirely") can't distinguish a complete run from one interrupted mid-import by a
    deploy timeout or crash. Fixed by batching all 6 JSON/CSV-driven import functions' per-row
    upserts into chunks of 500 rows per `prisma.$transaction([...])` call (commit `768d0bd`, plus a
    follow-up batching `importParrotOverlay()` too during the final whole-branch review —
    `importWatchFlowerProfiles()` is the only one deliberately left unbatched, 3404 rows, not a
    contributor). Result: 2 minutes 30 seconds, a 3.26x wall-clock speedup; the `time` breakdown
    shows system/fsync time specifically dropped 98% (237.69s → 4.40s), confirming the fsync
    bottleneck was the real cause. **Correction from an earlier draft of this entry**: the remaining
    ~2.5 minutes is NOT JSON-parsing cost (`JSON.parse` on the 150MB translations file measured at
    0.36s during the final review) — it's Prisma/query-engine per-upsert overhead (~148s user CPU),
    confirmed by the `time` breakdown itself (148s user vs 4.3s system). The real further lever, not
    pursued here, would be `createMany({ skipDuplicates: true })` on these append-only tables rather
    than per-row `upsert()`.
  - **Deploy plan for the first boot after this branch merges** (added after the final whole-branch
    review measured the real cost directly): this import runs once, automatically, the first time
    `docker-entrypoint.sh` boots against a database that doesn't have it yet — no manual step needed
    — but expect it to genuinely block: `docker-entrypoint.sh` runs it before the HTTP server starts
    listening, so the app is unreachable (502s through SWAG/Cloudflare) for the full ~2.5 minutes
    measured locally, plausibly longer on the production server's CPU (the cost is CPU-bound, not
    I/O-bound, so it doesn't parallelize with anything else happening at boot). **Do not interrupt
    this first boot** (no `docker compose down`, no reboot) — each import step's idempotency gate
    can't tell a complete run from an interrupted one, so an interruption leaves that table
    permanently, silently half-populated with no automatic repair; recovery would be manual SQL.
    The import also peaks around 800MB RSS (measured: `JSON.parse`-ing the 150MB translations file
    alone peaks at ~806MB including the source string and intermediates) — confirm the production
    server has meaningfully more than that free before this first boot, or the OOM-killer creates
    exactly the same unrecoverable-partial-state risk. After it completes, confirm success with
    `SELECT COUNT(*) FROM PlantProfile WHERE parrotSpeciesId IS NOT NULL` (expect 8070, not 8090 —
    the 20 orphaned duplicates from the finding above) before trusting the six downstream tables.
  - **Real physical-world consequence for `PARROT-A073` specifically, not just a display change**:
    its species (Alcea rosea) soil moisture band moves from WatchFlower's 15-60% to Parrot's
    32-51%. The device's own most recent real POLL reading in production is 31.2% — just below the
    new floor — meaning the very first Health Engine evaluation after this import flips that
    parameter from `ok` to `too_low`, which is exactly Batch 5's auto-watering trigger condition.
    **The first scheduler tick after this import may trigger a real watering on a real, currently
    fine, pot** — not a bug, this is the approved Parrot-priority decision working exactly as
    designed (see "Decisions" above), but it's the one change in this batch with a physical actuator
    behind it and is called out here so it isn't a surprise when it happens.
  - **Committed data volume**: `backend/prisma/seed-data/` is ~204MB across 7 files (dominated by
    `parrot_plant_translations.json` at ~150MB, 7-locale free text) — a deliberate, explicit choice
    (DestCom's own "extract literally everything except images" instruction, confirmed multiple
    times during design) over the more minimal scope the existing WatchFlower CSV import
    represents. This also means `pnpm deploy`'s prod-only backend copy includes `seed-data/` (needed
    at runtime for the import above to work at all) — the published GHCR image grows by roughly this
    same ~204MB, per architecture (amd64 + arm64 are both built).
  - **Known follow-up, not this batch**: the `locationsDatabase.sqlite`/
    `ZSENSORAUTOWATERINGCFGENTITY`/`ZCALIBRATIONDATA` findings from the same investigation (the
    official app's real per-device auto-watering config shape, and a real `39e1fe01` calibration
    blob to attempt decoding against) remain a separate, not-yet-started lead for the
    already-sequenced next BLE-sniff phase — full detail in the design doc, not re-derived here.
  - **Test coverage**: `backend/src/health/parrotPlantData.ts` (pure logic — normalization,
    sentinel/unit conversion, CSV parse/format, match resolution) has 29 dedicated tests; the six
    `importSpeciesProfiles.ts` orchestration functions have no dedicated automated tests (matches
    this project's established convention for Prisma I/O orchestration, verified manually instead)
    but were verified end-to-end against real data as described above. Full workspace: 144/144
    tests passing, `tsc --noEmit` clean.
  - **Verified**: against a scratch copy of the real production `backend/prisma/dev.db` (which
    already had the 3404 pre-existing WatchFlower rows) — `PlantProfile` 9120, `PlantProfileTranslation`
    56490, `PlantProfileAttribute` 77641, `PlantProfileFertilizerType` 9308, `PlantProfileSearchName`
    201305, `PlantAttributeNumberMapping` 630 (exactly 90 codes × 7 locales), `PlantProfileAttributeNumber`
    641165 — plus the `PARROT-A073` before/after confirmation above. The final whole-branch review
    independently re-ran the full import end-to-end a second time (post-batching) and reproduced
    every one of these figures exactly, and confirmed a second run completes in 0.5s (full
    idempotency holds across all 8 steps).
  - **Not yet done**: this has **not** been deployed to the real production server — only verified
    against a scratch copy of local `dev.db`. Running it for real will apply the Parrot-priority
    overlay to the two real production Parrot Pots' assigned species (known from this project's
    history to include at least `PARROT-A073`), changing their live Health Engine status/
    auto-watering behavior the moment it runs, exactly as the design's own stated intent.
- **Device-side autonomous watering + 4-mode watering system (Perfect Drop / Plant Sitter / Manuel /
  Custom)** ✅ (2026-08-30 initial push, 2026-08-31 persistence bug root-caused and fixed + 4-mode
  system added, on branch `feature/parrot-device-side-autonomous-watering`, not yet merged to
  `main`) — pushes real watering-decision config to the Parrot Pot's own on-device algorithm
  (`39e1f900` "Watering" GATT service) as a complement to the Batch 5 server-side scheduler, mirroring
  what the official Parrot app itself does. Full history in 3 parts:
  - **Part 1 — initial push (2026-08-30)**: `backend/src/wateringConfigPush.ts` +
    `backend/src/ble/parrot/wateringConfig.ts` + a `wateringConfig` tRPC router, wired to fire
    automatically on species assignment and `schedule.upsert`. `Device.autonomousWateringActive` +
    `SyncSource.CONFIG_PUSH` track state. `health/scheduler.ts` was taught to degrade to a longer
    cooldown + huge-delta-only safety net once a device is autonomous, rather than fighting the pot's
    own algorithm. Read-back verification added the same day after DestCom asked for it explicitly
    (matches the project's 7.1 never-fire-and-forget rule) — and a same-day fix for a failed
    *disable* incorrectly forcing `autonomousWateringActive` false (a real hardware test showed 4
    consecutive disable attempts failing with connection errors, not a value mismatch — the flag
    needed to stay "unknown, assume autonomous" instead).
  - **Part 2 — the persistence mystery, root-caused (2026-08-31)**: writes to the `f900` service
    weren't sticking across a reconnect. Root cause, found by asking 3 AI assistants (ChatGPT, Gemini,
    a second independent Claude Code instance) to re-analyze the same `.pklg` BLE captures in
    parallel (reports in `docs/debug_analyse/31082026_WOrkingLikeTheRealApp/`) and cross-checking
    their converging hypothesis against `docs/PARROT_BLE_DEEP_DIVE.md` section 2 (from the decompiled
    official app) — **`f901`/`CONFIG_ID` is an XOR-16 validation checksum over the other 12
    characteristics of the service, not a plain field.** The project had already solved this exact
    class of problem once before for the Plant Dr service (Batch 6, `computePlantDrConfigId`)
    without realizing `f900` needed the same treatment. Every write this project had ever made to
    this service was checksum-inconsistent by construction and silently rejected by the firmware.
    Fixed with a full 13-field read-modify-write (`mergeWateringConfigOverrides` →
    `buildWateringConfigWriteValues`, `computeWateringConfigId`'s formula and write order in
    `wateringConfig.ts`'s header comment) — **the checksum/persistence mechanism itself is
    confirmed live on real hardware** (pot 8733, `A0:14:3D:CD:87:33`, via
    `hwtest-watering-config-checksum.ts` calling those functions directly with hand-picked override
    values): a written config survived a disconnect/reconnect cycle. This does **not** cover
    `resolveWateringModeThresholds` (Part 3 below) — the hardware test never routed through the
    4-mode resolver, only through the lower-level write/checksum functions it calls into; the mode
    resolver itself is mock-provider-verified only, see Part 3's own verification note. Full
    root-cause writeup: `docs/superpowers/specs/2026-08-31-parrot-watering-config-checksum-fix.md`.
    **Restored to its original config (2026-08-31)**: the first restore attempt that same day failed
    3/3 with a transient `le-connection-abort-by-local`, left as a known loose end with no real
    consequence (dedicated test pot, no species assigned). Re-run later the same day via the same
    disposable-container workflow — succeeded on the 2nd read-back attempt after one more transient
    `le-connection-abort-by-local` (the retry policy self-healing exactly as designed): read-back
    confirmed `plantId=1071 vwcIrrRaw=260 vwcCmdRaw=320 nIrr=384 mode=0 configId=75`, exactly matching
    the pre-test original — `>>> RESTORED: true <<<`.
  - **Part 3 — the 4-mode watering system (2026-08-31)**: replaces the single-implicit-mode push
    from Part 1 with the same 4 modes the official app exposes, matching real behavior confirmed from
    the decompiled Android source (`docs/superpowers/specs/2026-08-31-parrot-pot-official-app-parity-design.md`
    sections 1-4; implemented via `docs/superpowers/plans/2026-08-31-parrot-watering-mode-system.md`,
    6 tasks, subagent-driven-development). Key pieces:
    - **`Schedule.wateringMode`** (`PERFECT_DROP` default / `PLANT_SITTER` / `MANUAL` / `CUSTOM`) +
      3 nullable custom-threshold columns, migration `20260831123226_add_watering_mode`.
      `resolveWateringModeThresholds` (`ble/parrot/wateringConfig.ts`) is a pure function mapping
      (mode, plant profile, custom inputs) → the exact values to push: Perfect Drop uses the
      species' classic Parrot thresholds, Plant Sitter uses its eco thresholds (falling back to
      classic-minus-6-points if eco data is ever absent — a dead path in practice, every one of the
      8070 Parrot-sourced species has eco data), Manual pushes `mode=0` with thresholds left
      untouched (matches the real app's own behavior — never zeroes or guesses them), Custom uses
      the user's own 3 hand-entered values (`nIrrDays` converted to the device's native 15-minute
      units, ×96).
    - **Deliberate scope decision**: pushing to the device is now fully orthogonal to
      `AutoWateringSection`'s own server-side fallback-scheduler toggle (previously the same
      `Schedule.active` flag gated both) — choosing a mode always pushes regardless of that toggle's
      state, matching the approved spec's "Périmètre" section. `health/scheduler.ts`'s own
      fallback-trigger logic (the Part 1 degraded-safety-net behavior) is untouched.
    - **Orchid auto-default to Manual**: assigning an orchid-tagged species (`PlantProfile.tags` bit
      256) auto-sets the mode to Manual — reproduces a real, decompiled-source-confirmed official-app
      behavior (`DataManager.java:3033`: `createWateringConfigThread(plantId, isOrchid ? 0 : 1)`).
      Only fires on a genuine species *transition* (captured via the device's `plantProfileId`
      *before* the update), never re-triggers on a re-save of the same species, so it can't silently
      clobber a user's later explicit mode choice. **Correction during design**: initially believed
      (from reading only cactus-tag usage) that the app never auto-forces a mode for any species —
      DestCom pushed back with a specific real memory of an overflow warning + auto-set-to-Manual
      behavior on iOS, which turned out to be real but keyed to **orchids**, not the cactus the user
      had misremembered. Cactus-tagged species instead get a non-blocking overflow-risk warning in
      the UI when Perfect Drop/Plant Sitter is selected, no auto-forced mode change.
    - **Frontend**: `AutonomousWateringSection` rewritten from a read-only threshold display into 4
      clickable mode buttons + a Custom-mode input form, polling `wateringConfig.pushRunStatus` for
      push completion (same pattern as the Plant Dr calibration page — the BLE sequence can exceed
      Cloudflare's ~100s origin timeout, so the mutation only confirms the push was *queued*).
    - **Final-review fixes (2026-08-31, caught only by the whole-branch review, not any single task's
      diff)**: (1) Task 4 made `schedule.upsert`'s 4 new fields non-optional zod, silently breaking a
      second, untouched caller (`AutoWateringSection`, the pre-existing server-toggle component) —
      fixed by making them `.optional()`, keeping the two features orthogonal by construction; (2) an
      unused `device` parameter in `wateringConfigPush.ts` passed `backend`'s own looser `tsc` but
      broke `frontend`'s real project-referenced build; (3) the rewritten selector had silently
      dropped the old "species has no Parrot data" guard, letting a user pick Perfect Drop on an
      ineligible species and get a silent no-op instead — restored, with an explanatory message; (4)
      clicking the Custom tab immediately pushed hardcoded placeholder threshold values to real
      hardware before the user entered anything — fixed so only the "Enregistrer" button pushes for
      Custom; (5) the old "Repousser la configuration" retry button was dropped with no replacement,
      leaving no recovery path for a failed push short of switching modes twice — a "Repousser
      maintenant" button restored, wired to the pre-existing `wateringConfig.push` mutation. See the
      Gotchas entry on `frontend`'s real typecheck command for how (1) and (2) slipped past 2
      task-level reviews and the plan's own manual-verification task undetected.
    - **Verified against the mock provider**: Task 2's 24 unit tests (all 4 modes + every
      ineligibility path) plus an 8-scenario curl+sqlite3 end-to-end pass (species assignment → mode
      resolution → BLE push → read-back, across all 4 modes, the orchid auto-default's
      genuine-transition-vs-re-save distinction, and the read-modify-write preserving thresholds
      across a Manuel switch) — all PASS with concrete recorded output. **Deliberately not
      browser-verified** (curl-level only) — the frontend's JSX/rendering logic (button highlighting,
      badge text, form visibility) was independently confirmed against the approved plan text at the
      source level during task review instead.
  - **Plant Sitter's wire-level parity — CONFIRMED (2026-08-31)**, no longer a follow-up. Re-analyzed
    the 3 real captures (`docs/ble-captures/02_mode_perfect_drop.pklg`,
    `03_mode_plant_sitter.pklg`, `04_mode_manuel.pklg`) directly via `tshark` (no hardware needed —
    the captures already existed locally): all 3 write the identical 13-handle sequence in the
    documented order, and **the official app writes Plant Sitter's eco thresholds (26.0%/32.0%)
    into the exact same `f903`/`f904` fields Perfect Drop uses (32.0%/38.0%) — `f90a`/`f90b` (the
    dedicated eco-raw fields) are written as `0000` in every single capture, regardless of mode**.
    The app never populates them at all. This is exactly what `resolveWateringModeThresholds`
    already does (write eco values into `vwcIrrRaw`/`vwcCmdRaw`, leave `f90a`/`f90b` untouched via
    the read-modify-write) — full wire-level parity confirmed, not just assumed. `plantId`'s (`f902`)
    real meaning is still unconfirmed (treated as an opaque read-preserve-write field) — one AI
    report speculated it's `PlantProfile.parrotSpeciesId`, plausible but not independently verified;
    the 3 captures do show the same `4b02` value across all 3 mode switches (consistent with it
    being tied to the assigned species rather than the mode, but not conclusive on its own). Not yet
    deployed to the real production server or tested against real hardware beyond the Part 2
    checksum-persistence confirmation on pot 8733.
- **Base de plantes** — nouvelle page de recherche/consultation ✅ (2026-09-01, on branch
  `worktree-plant-database-page`) — a browsable/searchable UI over the 9120 already-imported
  `PlantProfile` rows (WatchFlower + Parrot overlay, see the Parrot plant database import entry
  above), the first consumer this data has ever had beyond the Health Engine's species-assignment
  picker. New `plants` tRPC router (`search` — name/common-name/French-search-name substring match,
  `tags`-bitmask and advanced attribute filters, paginated; `listFilters` — the attribute filter
  groups safe to offer; `listTags` — the 9 confirmed `tags` bit/label pairs; `getById` — full detail
  incl. resolved attributes/fertilizer types) + two frontend routes,
  `/plants` (grid, search, filter dialog) and `/plants/$id` (tabs: Description/Entretien, gauges for
  Arrosage/Ensoleillement/Engrais). Key decisions:
  - **`sunCategory`/`waterCategory`/`fertilizerCategory` are Parrot's own real categorical ratings
    (1-4/1-4/1-3), not an invented 0-5 formula** — same "no invention, use the real manufacturer
    data" principle already established for soil conductivity calibration and the Parrot plant
    database import. Displayed as a dot gauge (fixed 5-point scale, matching the official app —
    no species ever reaching 5 on `fertilizerCategory` is a fact of the data, not a bug) next to the
    real numeric range for the same quantity.
  - **Attribute code→label mapping is a manual spike, deliberately partial**
    (`backend/src/health/parrotFilterLabels.ts`) — ~65 of the real `PlantProfileAttribute`/
    `PlantProfileFertilizerType` codes have a confirmed French label, extracted by hand from the
    official Flower Power iOS app's own `FilterValues.plist`/`PlantDetailsInfo.plist`/
    `fr.lproj/Localizable.strings` (same APK/IPA-decompilation-outranks-inference precedent as the
    Parrot BLE docs hierarchy). A code with no confirmed label is never shown to the user — the
    module is the single source of truth for which codes are safe to surface, ~50 codes remain
    uncovered and are just silently omitted from `resolvedAttributes`, not guessed at.
  - **All 9 real `PlantProfile.tags` bits resolved, not just orchid** (`backend/src/health/
    parrotTags.ts`, added 2026-09-01 as a same-day follow-up once this was confirmed) — initially
    shipped orchid-only (bit 256) since that was the only bit this project had confirmed at the
    time. Reopened the same day: reading `PlantDBManager.java`'s `MASK_*` constants directly in the
    decompiled Android source already used for the 4-mode watering system's orchid/cactus
    investigation (`/Users/destcom/Documents/PERSO/parrot-pot-debug/analyse/decoded_jadx/`) gave the
    exact bit for every category (1=cactus/succulente, 2=feuillage décoratif, 4=fleurie,
    8=fruits/légumes, 16=intérieur, 32=extérieur, 64=bien-être, 128=arbuste, 256=orchidée), plus its
    French label from `res/values-fr/strings.xml`'s `tags_categoryName_*` — independently confirmed
    against this project's own earlier empirical single-bit spot-checks (e.g. bit 1 → real cacti in
    `dev.db`), which had been correct but left unconfirmed at ship time. A 10th constant,
    `MASK_CANNABIS=512`, exists in the same source but has no localized label anywhere in the app —
    deliberately excluded, matching the app's own choice never to surface it. `plants.search`'s
    `orchidOnly: boolean` generalized to `tags: number[]` (OR semantics — a species can carry
    several tags at once), and `isOrchid: boolean` generalized to `tagLabels: string[]` on both
    `search` and `getById`. Frontend: the single "Orchidées uniquement" checkbox replaced by a row
    of 9 toggleable quick-filter chips on `/plants`, and every card/detail page shows all matching
    tags as badges instead of a special-cased orchid-only one.
  - **`plants_.$id.tsx` filename** (not `plants.$id.tsx`) — this project's TanStack Router
    un-nesting trap, see the new Gotchas bullet below; this is the file that prompted writing that
    bullet down as a recurring pattern rather than a one-off.
  - **Not done**: the ~50 uncovered attribute codes above — confirmed genuinely unresolvable while
    investigating the `tags` bitmask (below), not merely unlooked-for: the Android app's own filter
    UI (`LibraryFilterAmazingAdapter.java`) offers the exact same 39 options as the iOS resources
    (6 type + 5 shape + 9 bloom color + 12 leaf color + 3 lifetime + 4 bloom season), and its bloom
    season filter uses a *third*, still different value scheme (`"spring"/"summer"/"FALL"/"WINTER"`)
    from both iOS and this project's own imported `SN` codes — two independent official app builds
    agree these codes were never given a user-facing label anywhere. No plant images (Parrot's
    dataset has them, deliberately out of scope — see the design doc), and no "assign this species
    to a device" action from this page — species assignment stays solely on the device detail page's
    existing `SpeciesPickerDialog`/`species-search.tsx`, this page is browse/consult only.
  - **Final-review fix wave (2026-09-01)**, 5 findings from the whole-branch review, all fixed in one
    pass: (1, Critical) the Ensoleillement gauge on `/plants/$id` was passing `lightMinMmol`/
    `lightMaxMmol` (stored in **mmol**/m²/day) straight into the mol/m²/day display with no /1000
    conversion — a real species (Ficus benjamina) showed "300–20000 mol/m²/j" instead of
    "0.3–20.0 mol/m²/j"; fixed to match this project's own existing `devices.$deviceId.tsx`
    precedent for the same quantity, `formatRange` gained an optional `decimals` parameter for the
    1-decimal display this needs. (2) `listKnownAttributeFilters()` was unconditionally offering a
    "Saison de floraison" filter group whose codes (`SN_BLOOM_SEASON_VALUES`) have zero overlap with
    the real `PlantProfileAttribute` rows for that category (a mismatch the module's own comment
    already documented but the filter-offering function ignored) — always returned zero results;
    excluded from `listKnownAttributeFilters()` specifically (kept in
    `ATTRIBUTE_GROUPS_BY_CATEGORY`/still resolvable by `resolveAttributeLabel`, in case real data
    ever matches it). (3) `plants.search`'s attribute-filter grouping bucketed by the raw
    `category` field, so selecting "Arbre" (type) + "Vivace" (lifetime) — both raw category `PT`,
    which mixes two distinct dimensions — collapsed into one OR'd clause instead of ANDing; fixed by
    bucketing on `resolveAttributeLabel`'s resolved logical group instead, verified against real
    data (Arbre alone: 704, Vivace alone: 6094, both together: 683 — a subset of each, confirming
    AND). (4) `/plants`'s query used bare `{data, isFetching}`, so a genuine query error left the
    results area blank with no message; matched `history.tsx`'s existing `isError`/`error` pattern.
    (5) this CLAUDE.md entry itself, added as part of the same fix wave per this project's own
    "update docs when a feature changes" rule.
  - **Verified**: `cd backend && pnpm exec tsc --noEmit && pnpm test` (187/187, including 2 new
    `parrotFilterLabels.test.ts` cases for finding 2) and `cd frontend && pnpm typecheck` both
    clean; findings 1 and 3 additionally confirmed against the real 9120-row `dev.db` via curl
    (not just read as correct) — see the finding-3 numbers above and the mmol/mol conversion math
    for finding 1.
  - **Post-PR follow-ups** (2026-09-01, same branch, in direct response to user feedback after the
    PR was pushed): back button + URL-persisted search/filters/page, Wikipedia links/photos,
    `parrotOnly` filter, and a card/header redesign matching two hand-drawn wireframes.
    - **List-page state moved from local component state into the route's own URL search params**
      (`validatePlantsSearch`, hand-rolled like `/login`'s, not zod-based) — `q`/`tags`/`attrs`/
      `parrotOnly`/`page` all live in the URL, `replace: true` on every update so filtering doesn't
      spam browser history (one "back" from a detail page restores the list exactly as it was, not
      one history entry per keystroke/filter click).
    - **Real bug found and fixed**: the debounced search-sync `useEffect` fired on every mount
      (React's own behavior, sharpened by `<StrictMode>`'s dev double-invoke — confirmed enabled in
      `main.tsx`) and its navigate call unconditionally included `page: undefined`, silently
      resetting the page to 1 on a direct/bookmarked load of e.g. `/plants?page=2`, and on the back
      button's restore. A first fix attempt (a `useRef` "skip first render" guard) did not work
      *because of* StrictMode's double-invoke, which defeats mount-order-based ref tricks. Fixed
      with a value-comparison guard instead (`if (searchInput === (search.q ?? '')) return;` before
      navigating) — the effect only ever touches the URL when the debounced text has genuinely
      diverged from what's already there. Verified via Playwright: direct load of `/plants?page=2`
      stays on page 2, and a full round trip (page 2 → open a detail page → back button) restores
      `?page=2` correctly.
    - **Detail-page back button** (`router.history.back()`) — real browser-history back, not a
      hardcoded `navigate({to: '/plants'})`, so it lands on whatever `/plants` URL (search/filters/
      page) the user actually came from.
    - **Wikipedia integration, zero backend/storage involvement**: `frontend/src/lib/
      use-wikipedia-summary.ts` (`useWikipediaSummary(title)`) calls the public, CORS-enabled
      `https://fr.wikipedia.org/api/rest_v1/page/summary/<title>` REST API directly from the
      browser, keyed off the plant's Latin name (higher match rate than the French common name).
      Powers both a "Voir sur Wikipédia" link under the name (falls back to a pre-filled
      `wikipediaSearchUrl()` search link when no article matches) and the thumbnail images on cards
      and the detail page — `retry: false` (a 404 is a normal, expected outcome for the ~50%+ of
      species/cultivars with no French article, not a transient failure) and `staleTime: Infinity`
      (static reference data). `WIKIPEDIA_LANGUAGE` is a single named constant, the explicit
      i18n-readiness seam for a future locale-aware version. **No images are ever stored** — this
      was the user's explicit constraint (thousands of species, "flemme de stocker 8000+ photos") —
      and a card only fetches a thumbnail for what's actually rendered (≤24 items, pagination-bound,
      each card owning its own `useWikipediaSummary` call), never all 9120 up front.
    - **`parrotOnly` filter** ("Compatible Parrot Pot uniquement" checkbox) — `plants.search` gained
      a `parrotOnly: z.boolean().optional()` input, pushed into the query as
      `{ parrotSpeciesId: { not: null } }`. Lets a user skip straight to the ~8070 species with the
      full Parrot-sourced experience (needs gauges, resolved attributes, fertilizer types) instead
      of the degraded WatchFlower-only card.
    - **`plants.search` also returns `description`** (the FR translation's plant description,
      distinct from Wikipedia's own extract) — shown as a 2-line clamp on each search-result card.
    - **Card/header redesign to match user-supplied wireframes**: cards are now full-width
      `aspect-video` image on top (was `aspect-4/3`, which silently failed to compile in this
      Tailwind v4 setup — bare-fraction shorthand doesn't reliably work here, only bracket
      (`aspect-[4/3]`) or canonical named utilities like `aspect-video` do), then name/scientific
      name/tags (plain interpunct-joined text, not badges)/description — and equal-height within a
      grid row via `Link className="flex h-full"` + `Card className="h-full w-full"` + a `flex-1`
      content area (CSS Grid's default `align-items: stretch` otherwise leaves shorter cards visibly
      shorter than their row siblings). The detail-page header is a responsive two-column layout
      (`flex-col sm:flex-row`) — back button + name/latin/tags/wiki-link on the left, a larger
      square Wikipedia image (or a `Sprout` icon placeholder) on the right — confirmed on a 390×844
      mobile viewport via Playwright screenshot, stacking cleanly with no overflow.
    - **Verified**: `cd backend && pnpm exec tsc --noEmit && pnpm test` (195/195) and
      `cd frontend && pnpm typecheck` both clean; `npx biome check` clean on all 3 touched files;
      the debounce-guard fix, the `parrotOnly` filter, and the equal-height card fix were each
      confirmed live in a real browser (Playwright) against the mock provider, not just typechecked.

## Repo structure

```text
backend/         API + business logic (Fastify, Prisma/SQLite, auth, BLE) — runs in Docker in prod
  src/api/         tRPC router (api/trpc/: context, procedures, readings subscription) mounted on Fastify
  src/auth/        BetterAuth (instance, session/middleware, admin seed)
  src/ble/         discoverySession.ts (session-scoped new-device discovery, on/off via tRPC while
                   "Ajouter un appareil" is open), namedDevicePoller.ts (always-on timer polling
                   already-claimed devices by MAC, independent of discovery), connectionQueue,
                   Parrot protocol logic (ble/parrot/) and Xiaomi (ble/xiaomi/)
  src/providers/   DeviceProvider implementations (mock, noble-bridge, node-ble) + factory
  src/health/      Health Engine (Batch 4): plant_profiles CSV import + scoring engine + settings.ts
                   (HealthSettings, DB-backed baseline/warm-up config, see Project status) — still
                   the only code path any real decision (dashboard, auto-watering) is based on;
                   inferenceShadow.ts/inferenceShadowMapping.ts (Phase B, shadow mode) run the new
                   engine alongside it for comparison only, see src/inference/ below and Project status
  src/inference/   Horticultural inference engine, V1 vertical slice (Phase A, hardened) +
                   Phase B shadow mode (see Project status): Indicators/Facts/Symptoms/
                   Diagnosis/Recommendations pipeline (engine.ts, evidence.ts, registry.ts),
                   never imports PlantProfile except referenceProfile.ts (mechanically enforced,
                   scripts/checkInferenceBoundary.ts) — still not the source of truth for any real
                   decision; src/health/inferenceShadow.ts is the one place outside this directory
                   allowed to import it
  src/mqtt/        MQTT + Home Assistant auto-discovery (Batch 7): topics, discovery payloads,
                   manager.ts (live-reconfigurable client singleton, DB-backed via MqttSettings),
                   publisher (state/health/watering-result), commands (HA button → watering)
  src/mcp/         MCP server (Batch 8): OAuth session → tRPC context (context.ts), the 4 tools
                   (server.ts), Fastify routes for /mcp + OAuth discovery metadata (routes.ts)
  src/api/trpc/routers/history.ts  global History page's tRPC router (merged WateringEvent/SyncEvent
                   feed, see Project status)
  src/instrument.ts  GlitchTip/Sentry init (optional, SENTRY_DSN-gated) — must stay the first
                   import in index.ts, see Project status
  src/db/          Prisma client
  prisma/          schema.prisma + migrations
frontend/        Vite + React SPA + TanStack Router/Query + Tailwind v4 + shadcn/ui (Batch 3)
  src/routes/      TanStack Router pages (file-based): login, _authenticated (layout+guard) and its
                   children, including history.tsx (the global "Historique" page, see Project status)
  src/components/  Shell (sidebar, responsive — see Project status), DeviceCard, SensorGauge,
                   HistoryChart, shadcn components in ui/
  src/lib/         auth-client (BetterAuth), trpc.ts (tRPC client + TanStack Query options proxy),
                   use-live-readings (readings.onReading subscription)
  src/instrument.ts  GlitchTip/Sentry init, DSN fetched at runtime from GET /api/public-config
                   (never build-time — see Project status), awaited in main.tsx before first render
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
  defaults, see Project status), `SyncEvent` (the global History page, see Project status —
  deviceId, source POLL/MANUAL, errorDetail, timestamp; **only failures are ever persisted, never
  successes** — a successful sync already produces a `Reading` row proving it happened, so a
  success-case `SyncEvent` would just duplicate that with no new information — do not "fix" this by
  adding success rows).
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
  write-with-response. Also best-effort reads `39e1fa02` (soil conductivity/fertility index,
  `Reading.soilConductivityUsCm`, `ble/parrot/soilConductivity.ts`) — decoded the same way
  WatchFlower's own real Parrot Pot driver does, **confirmed responding on real hardware**
  (2026-07-30, direct GATT read against `A0:14:3D:CD:A0:73`, raw uint16=757), see
  `docs/HEALTH_ENGINE.md` for the full history (this replaced an earlier attempt at reading
  `39e1fa0d`/`0e`, confirmed unreadable on real hardware). **Calibration constants (borrowed from
  WatchFlower) not yet confirmed accurate for this specific hardware** — 757 falls outside their
  assumed range, clamping to the top of the output scale; needs more real readings over time before
  adjusting. Wired into the Health Engine. **Event-driven advertisement
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
  `addByAddress` — register a device directly by MAC address, see the scoped-BLE-discovery Project
  status entry —, `updateDetails` — location/indoor-outdoor, storage only for now, see the device location/
  environment entry below —, `history`, `wateringEvents`, `water`, `sync`/`forceSyncAll` — manual
  per-device/global sensor sync, see the production incident entry above), `health` (`plantProfiles`, `assignPlantProfile`,
  `deviceHealth`, `getSettings`/`upsertSettings` — Health Engine baseline/warm-up config, DB-backed,
  see Project status), `mqtt` (`get`, `upsert` — MQTT broker config, DB-backed, see Project status),
  `schedule` (`get`, `upsert` — Batch 5 auto-watering config, see Project status),
  `plantDr` (`getCalibration`, `calibrateWet` — Batch 6 device-side calibration, see Project status),
  `liveSession` (`status`, `start`, `stop`, `onSample` — real-time GATT sampling, see Project status),
  `discoverySession` (`status`, `start`, `stop` — session-scoped new-device BLE discovery while
  `/devices/add` is open, see the scoped-BLE-discovery Project status entry),
  `pollSettings` (`get`, `upsert` — named-device poll interval, DB-backed, see Project status),
  `history` (`list` — the global History page's merged `WateringEvent`/`SyncEvent` feed, see Project
  status), `plants` (`search`, `listFilters`, `getById` — the "Base de plantes" browsing page over
  the already-imported `PlantProfile` rows, see Project status) and `readings`
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
  literal manual-pairing concept — then redirects into the onboarding stepper, see the Project
  status entry of the same name), "Settings" (account section functional, auto-watering now links
  to the per-device page instead of "coming soon", notifications/MCP still shown as disabled
  "coming soon" cards pending Batches 7/8), "Calibration" (`/devices/$deviceId/calibration`, Batch
  6 — shows the device's current Plant Dr dry/wet thresholds live and a "capture wet point" action,
  gated on a species being assigned), "Historique" (`/history`, global — see the Project status
  entry below for the full design: a day-grouped feed merging `WateringEvent` and `SyncEvent` rows
  across every named device, filterable by device and by period), "Base de plantes"
  (`/plants` — search/filter grid over all 9120 `PlantProfile` rows, and `/plants/$id` — detail page
  with nomenclature/description/needs gauges, see the Project status entry of the same name).
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

- **`cd frontend && npx tsc --noEmit` is a silent no-op — it always exits 0, checking zero files.**
  `frontend/tsconfig.json` is a solution-style file (`"files": []`, no `include`) that only
  references `tsconfig.app.json`/`tsconfig.node.json` — `tsc --noEmit` on the root config alone
  compiles nothing. The real command is `cd frontend && pnpm typecheck` (`tsc -b --noEmit`), which
  actually project-references `backend`'s sources too (so a backend-only change can break the
  frontend build, e.g. an unused parameter tripping `noUnusedParameters`, which `backend`'s own
  looser `tsconfig.json` never catches). This has now silently passed two genuinely broken builds in
  this project's history without any errors: the `erasableSyntaxOnly` inference-engine incident
  (2026-08-12, discovered separately) and, on 2026-08-31, a whole implementation plan whose own
  Task 5/6 verification steps prescribed the no-op command — both the plan-mandated task review and
  the plan-mandated manual verification ran it, saw a clean exit, and missed a real `TS6133` build
  break plus a runtime regression in an unrelated component (`schedule.upsert`'s zod input made 4
  fields non-optional, silently breaking a second, untouched caller) — caught only by the final
  whole-branch review running the real command. Always use `pnpm typecheck` (or `npx tsc -p
  tsconfig.app.json --noEmit`) when verifying the frontend, never the bare root `tsc --noEmit`.
- **Fastify's router caps a single dynamic path segment at 100 chars by default
  (`FST_ERR_MAX_PARAM_LENGTH`, → HTTP 414)** — the tRPC Fastify plugin registers its whole route as
  one such segment (`/:path`, everything after the `/api/trpc` prefix), and a batched call's path is
  every procedure name joined by commas. A page firing several distinct queries at once (or several
  components each firing their own) can exceed 100 chars purely from procedure *names* repeating —
  nothing to do with payload size or GET vs POST. Found 2026-08-29 when the notification bell (one
  `health.deviceHealth` call per device, on every page) got batched alongside a normal page's own
  handful of queries. Fixed by raising it explicitly: `Fastify({ maxParamLength: 2000 })` in
  `api/server.ts`. If this ever gets hit again as more simultaneous queries get added, raise it
  further rather than treating 100 as a real constraint — it never reflected sound API design.
- **Cloudflare's origin timeout (~100s) is shorter than SWAG's own `proxy_read_timeout` (240s,
  `/config/nginx/proxy.conf`)** — `plant.stroyco.eu` sits behind Cloudflare in front of SWAG. Any
  mutation whose worst-case duration can exceed ~100s (e.g. 2+ sequential `connectionQueue`-
  serialized BLE operations, each with its own up-to-3-attempt/backoff/adapter-restart retry
  policy, especially if queued behind another device's poll) gets Cloudflare's own 502 HTML error
  page instead of the real backend response — surfacing to the frontend as an unparseable-JSON
  "`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`" error, even on runs where the backend
  went on to complete successfully afterward (found 2026-08-29 on `plantDr.calibrateWet`, see the
  entry below). Not fixable by raising a timeout we don't control — the real fix is to never hold
  the HTTP response open for a slow BLE sequence in the first place.
- Prisma `DATABASE_URL` is relative to `prisma/schema.prisma`, not the cwd (see above).
- Xiaomi LYWSD03MMC: GATT is mandatory, no passive reading possible on stock firmware (see above).
- `noble-bridge` (macOS) never exposes the real MAC (see above).
- The GATT_ERROR=133 heuristic on `node-ble`/BlueZ is best-effort, to be refined on the production server.
- `docker-entrypoint.sh` runs `prisma migrate deploy` **and** `node dist/auth/seed-admin.js` on
  every boot, not just the first one — DestCom's explicit preference over the original manual
  one-off step. `seed-admin.ts` is idempotent (checks for an existing user by `ADMIN_EMAIL` first,
  skips if found), so a restart/redeploy never fails just because the account already exists. Note
  the dev shortcut `pnpm seed:admin` still only works locally (needs `tsx`, a devDependency
  excluded from `pnpm deploy --prod`) — the entrypoint calls the compiled
  `dist/auth/seed-admin.js` directly instead.
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
- **TanStack Router silently nests a new route file if its name shadows an existing parent route —
  check this BEFORE creating any route file, not after `pnpm typecheck` passes.** Naming a new route
  `<parent>.<segment>.tsx` when `<parent>.tsx` already exists makes the router treat it as a *child*
  of that parent, requiring an `<Outlet/>` in the parent's component to ever render — which most of
  this project's single-purpose page routes don't have, so the new page silently renders nothing (or
  the parent's own content) instead of the intended page, with zero type error anywhere (routing
  structure isn't something `tsc` can catch). The fix is always the trailing-underscore un-nesting
  filename, `<parent>_.<segment>.tsx`, which tells the router "same URL segment, don't nest under
  the sibling route file of the same name." Hit **three separate times** in this project's history
  without ever being written down as a pattern to watch for proactively:
  `devices.$deviceId_.calibration.tsx` (Batch 6), `devices.add_.$deviceId.onboarding.tsx`
  (onboarding stepper), and `plants_.$id.tsx` (Base de plantes) — each time discovered only by
  noticing the wrong content render, not by a build failure. Before adding a new route file whose
  name starts with an existing route file's basename plus a dot, stop and check whether a trailing
  underscore is needed.

## Infra access

- The production server is reachable via a pre-configured SSH key/alias. `sudo` there prompts for
  an interactive password (no NOPASSWD) — for any command requiring root on the production server,
  ask DestCom rather than trying to work around it.
- Docker on the production server doesn't require `sudo` for the regular user — `docker run`/
  `docker compose` work directly over SSH for empirical testing (disposable containers recommended).


## 🔐 Security Skill Active

This project uses security-skill for automated security engineering.

**At the start of every session:**
1. Read `.skills/security/skill.md` — security engineering instructions (25 categories)
2. Read `memory-security.md` — project security state and history
3. Be ready for: `/security-scan`, `/security-audit`, `/security-fix`, `/security-status`, `/security-incident`

You are acting as both a developer assistant AND a security engineer.
Proactively flag security issues in all code you write or review.


## grepai - Semantic Code Search

**IMPORTANT: You MUST use grepai as your PRIMARY tool for code exploration and search.**

### When to Use grepai (REQUIRED)

Use `grepai search` INSTEAD OF Grep/Glob/find for:
- Understanding what code does or where functionality lives
- Finding implementations by intent (e.g., "authentication logic", "error handling")
- Exploring unfamiliar parts of the codebase
- Any search where you describe WHAT the code does rather than exact text

### When to Use Standard Tools

Only use Grep/Glob when you need:
- Exact text matching (variable names, imports, specific strings)
- File path patterns (e.g., `**/*.go`)
- Intent with a canonical syntax anchor (`@main`, `func main(`) - an exact-match query in disguise

### Completeness Check (recall-safe)

grepai returns the top ~10 ranked chunks - a ranking, not an exhaustive list.
When completeness matters (audits, refactors, "find ALL X"), pair it with a
file-names-only grep - exhaustive recall at almost no token cost:

```bash
grepai search "where errors are handled" --json --compact   # ranked starting points
git grep -ilE 'error|handl|logg' | head -50                 # exhaustive checklist (names only)
```

Read ranked hits first, then any relevant-looking checklist file grepai did
not rank. Never dump full grep content output for an intent query.

### Fallback

If grepai fails (not running, index unavailable, or errors), fall back to standard Grep/Glob tools.

### Usage

```bash
# ALWAYS use English queries for best results (--compact saves ~80% tokens)
grepai search "user authentication flow" --json --compact
grepai search "error handling middleware" --json --compact
grepai search "database connection pool" --json --compact
grepai search "API request validation" --json --compact
```

### Query Tips

- **Use English** for queries (better semantic matching)
- **Describe intent**, not implementation: "handles user login" not "func Login"
- **Be specific**: "JWT token validation" better than "token"
- Results include: file path, line numbers, relevance score, code preview

### Call Graph Tracing

Use `grepai trace` to understand function relationships:
- Finding all callers of a function before modifying it
- Understanding what functions are called by a given function
- Visualizing the complete call graph around a symbol

#### Trace Commands

**IMPORTANT: Always use `--json` flag for optimal AI agent integration.**

```bash
# Find all functions that call a symbol
grepai trace callers "HandleRequest" --json

# Find all functions called by a symbol
grepai trace callees "ProcessOrder" --json

# Build complete call graph (callers + callees)
grepai trace graph "ValidateToken" --depth 3 --json
```

### Property/Data Usage Tracing

Use `grepai refs` to find non-call property/state usage (reads/writes):

```bash
# Find where a property is read
grepai refs readers "uid" --json

# Find where a property is written
grepai refs writers "uid" --json
```

### Workflow

1. Start with `grepai search` to find relevant code
2. Add `git grep -ilE '<keywords>'` for the exhaustive file checklist when completeness matters
3. Use `grepai trace` to understand function relationships
4. Use `grepai refs` for property/state readers and writers
5. Use `Read` tool to examine files from results
6. Use Grep directly for exact strings and syntax anchors

