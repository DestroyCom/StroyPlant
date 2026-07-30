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
  src/ble/         discoverySession.ts (session-scoped new-device discovery, on/off via tRPC while
                   "Ajouter un appareil" is open), namedDevicePoller.ts (always-on timer polling
                   already-claimed devices by MAC, independent of discovery), connectionQueue,
                   Parrot protocol logic (ble/parrot/) and Xiaomi (ble/xiaomi/)
  src/providers/   DeviceProvider implementations (mock, noble-bridge, node-ble) + factory
  src/health/      Health Engine (Batch 4): plant_profiles CSV import + scoring engine + settings.ts
                   (HealthSettings, DB-backed baseline/warm-up config, see Project status)
  src/mqtt/        MQTT + Home Assistant auto-discovery (Batch 7): topics, discovery payloads,
                   manager.ts (live-reconfigurable client singleton, DB-backed via MqttSettings),
                   publisher (state/health/watering-result), commands (HA button → watering)
  src/mcp/         MCP server (Batch 8): OAuth session → tRPC context (context.ts), the 4 tools
                   (server.ts), Fastify routes for /mcp + OAuth discovery metadata (routes.ts)
  src/api/trpc/routers/history.ts  global History page's tRPC router (merged WateringEvent/SyncEvent
                   feed, see Project status)
  src/db/          Prisma client
  prisma/          schema.prisma + migrations
frontend/        Vite + React SPA + TanStack Router/Query + Tailwind v4 + shadcn/ui (Batch 3)
  src/routes/      TanStack Router pages (file-based): login, _authenticated (layout+guard) and its
                   children, including history.tsx (the global "Historique" page, see Project status)
  src/components/  Shell (sidebar, responsive — see Project status), DeviceCard, SensorGauge,
                   HistoryChart, shadcn components in ui/
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
  `history` (`list` — the global History page's merged `WateringEvent`/`SyncEvent` feed, see Project
  status) and `readings`
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
  across every named device, filterable by device and by period).
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

## Infra access

- The production server is reachable via a pre-configured SSH key/alias. `sudo` there prompts for
  an interactive password (no NOPASSWD) — for any command requiring root on the production server,
  ask DestCom rather than trying to work around it.
- Docker on the production server doesn't require `sudo` for the regular user — `docker run`/
  `docker compose` work directly over SSH for empirical testing (disposable containers recommended).
