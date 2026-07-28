# StroyPlant — Complete Project Specification

> Project name: **StroyPlant** (decided, final).
> This document is the project's source of truth. It consolidates all architecture decisions made upstream. Any ambiguity not covered here must be asked to the user (DestCom), never guessed.

---

## 1. Context & goal

Replace WatchFlower (Qt desktop/mobile app, not suited to 24/7 server use) with a **self-hosted** service running continuously on a Debian production server, capable of:

- Continuously scanning BLE plant sensors
- Saving reading history
- Evaluating plant health against per-species profiles
- Triggering automatic watering based on rules (Parrot Pot)
- Integrating with Home Assistant
- Exposing access for AI agents (MCP server)

## 2. Scope

**Included (v1)**:

- P0/P1 devices listed in section 3
- Web monitoring dashboard
- Programmable automatic watering (Parrot Pot only, the only device with an actuator)
- Basic single-user auth
- Home Assistant integration (MQTT)
- MCP server for AI agents

**Explicitly out of scope (v1)**:

- Multi-user / complex role management (personal use, a single admin account)
- Native mobile app (the responsive web dashboard is sufficient)
- Docker Desktop macOS/Windows support in production (see section 5 — confirmed limitation, not an oversight)
- Generic "plug any BLE sensor" system — each new device type needs a hand-written dedicated driver

## 3. Supported devices (by priority)

| Priority | Device                            | BLE mode                              | Capabilities                                |
| -------- | --------------------------------- | ------------------------------------- | ------------------------------------------- |
| **P0**   | Parrot Pot                        | GATT connection                       | Sensor reading + manual/auto watering       |
| **P0**   | Xiaomi LYWSD03MMC (pvvx firmware) | Passive advertisement (no connection) | Temperature / humidity                      |
| P1       | Flower Power                      | GATT connection                       | Sensor reading only                         |
| P1       | Flower Care / Flower Care Max     | GATT connection                       | Sensor reading + on-device internal history |
| P2       | RoPot, others                     | —                                     | Deferred until the core is validated        |

Important architectural point: the two P0 devices operate in fundamentally different BLE modes. The passive Xiaomi scan can run in the background continuously without ever monopolizing the dongle, while the GATT connection queue (Parrot Pot) runs its one-off, sequential cycles (BLE does not handle multiple simultaneous GATT connections well on a standard USB dongle).

## 4. System architecture (production target)

```
Production server (Debian 12, USB BLE dongle — TP-Link UB500 Plus, Bluetooth 5.3, Realtek chipset)
 └── Docker (native Linux Docker Engine)
      ├── backend (Node.js/TypeScript)
      │    - BLE layer (node-ble via BlueZ/D-Bus in prod)
      │    - Auth (BetterAuth)
      │    - Health Engine (plant profiles + scoring)
      │    - Scheduler (auto-watering cron)
      │    - SQLite (via Prisma)
      │    - tRPC router (queries/mutations over HTTP + a WS subscription for live readings)
      │    - MQTT client (Home Assistant auto-discovery)
      │    - MCP server (tools for AI agents)
      └── (the frontend is built as static assets and served by the backend — no separate container)
```

## 5. Docker & Bluetooth constraints — to be strictly followed

- The backend container needs real, non-virtualizable hardware access: either `--privileged`, or `NET_ADMIN` + `NET_RAW` capabilities + `network_mode: host` + mounting `/var/run/dbus/system_bus_socket`.
- **Only works on native Linux Docker Engine** (Debian/Ubuntu, Raspberry Pi under Linux). The recommended dongle (TP-Link UB500 Plus, Realtek RTL8761B chipset) should work with any dongle recognized by the Linux kernel — BlueZ absorbs chipset differences.
- **Does NOT work on Docker Desktop macOS/Windows.** Confirmed and non-negotiable: Docker Desktop runs in a hidden Linux VM with no reliable native Bluetooth passthrough. The only workaround (USB/IP) is slow, heavy, and not suited to real use — do not try to set it up, it is not the approach chosen (see section 6 for the Mac dev strategy).
- On Coolify (already used by DestCom elsewhere), these settings (`privileged`, `network_mode: host`, mounts) will require manual editing of the generated docker-compose, not a "standard" deployment via the UI.

## 6. Development strategy — 3 interchangeable BLE providers

DestCom develops on a **MacBook Air M3 (macOS)**, but the production target is **Linux (the production server)**. Since Docker doesn't allow real BLE on macOS (section 5), the real BLE layer must **never be developed/tested directly in the container locally on Mac**. Use an abstract `DeviceProvider` interface, with three interchangeable implementations via a `BLE_PROVIDER` environment variable:

| Provider       | Where it runs                                                                                                      | Library used                         | What it validates                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------- |
| `mock`         | In the container, Mac dev                                                                                          | None (simulated data)                | Pure business logic: Health Engine, cron, API, frontend, auth          |
| `noble-bridge` | A small **native macOS** Node process (outside Docker) exposing a local HTTP API, called by the dockerized backend | `@abandonware/noble` (CoreBluetooth) | Real BLE protocol against real hardware — but not the real Linux stack |
| `node-ble`     | Directly in the container, production server only                                                                  | `node-ble` (BlueZ/D-Bus)             | The real production stack — the final, incompressible validation       |

Notes:

- `mock` must be able to simulate useful scenarios (e.g. humidity progressively dropping to test that an alert triggers, a watering trigger that fails to test error handling), not just flat random values.
- `noble-bridge` can reuse as-is the logic from the already-developed `parrotpot-poc/` CLI PoC (see section 9) — same UUIDs, same read/write commands, just exposed via a small HTTP API instead of a CLI.
- The move from `mock`/`noble-bridge` to the real `node-ble` should **never** be considered a given just because the other two pass — these are different libraries (noble vs node-ble), so behavior (timing, GATT error handling, event format) must be revalidated on the production server with the checklist in section 9.
- **Before starting Batch 0 (see section 11)**, ask DestCom whether he wants this batch (and the final validation of the `node-ble` provider) done by working directly on the production server over SSH (real bash access to the target machine, autonomous iteration possible), rather than locally on his Mac with manual test round-trips. Do not assume the answer.

## 7. Detailed functional modules

### 7.1 BLE Layer

- Continuous scanner (discovery), with throttling to avoid saturating the dongle
- Sequential connection queue for the Parrot Pot (only one GATT connection at a time)
- One driver per device, behind the common `DeviceProvider` interface: `scan()`, `readSensors()`, `triggerAction()`
- Exhaustive logging of every BLE operation (timestamp, direction, UUID, hex payload, detailed result) — **never swallow an error silently**, unlike WatchFlower, which has a "fire-and-forget" watering write with no verification (bug identified and documented during initial Parrot Pot debugging)
- For mapping GATT error codes to readable log messages, see the reference table in `PARROT_BLE_DEEP_DIVE.md` section 5 (these are standard Bluetooth/Bluedroid codes, not specific to the Parrot Pot — noble/node-ble expose them natively, no need to redefine them)
- **Resilience pattern confirmed by the official app (to be replicated in Batch 1)**, from the PoC investigation of the decompiled code:
  - GATT connection retry: up to 3 attempts, 15-20s timeout per attempt
  - On `GATT_ERROR` (code 133, very frequent): fixed 500ms backoff before retry; if the error occurs a 2nd consecutive time, restart the Bluetooth adapter itself (`disable()` then `enable()`, with up to 60s wait) rather than continuing to retry on an adapter likely in a bad state
  - Continuous scan cycle (not a single attempt): ~10s scan then pause (1 min in normal use, 10s in "aggressive" mode), filtered by advertised service UUID + minimum RSSI (`-90`); a device "seen" remains considered valid for 3 cycles before being declared lost
  - No silent mid-task reconnection: a disconnection during an operation surfaces directly as an error (consistent with our principle of never swallowing an error silently)

**Important nuance between the PoC (macOS/noble) and production (Linux/node-ble)**: the PoC ran into a limitation specific to `@abandonware/noble` on macOS — the native CoreBluetooth binding doesn't expose the real error code (`NSError` swallowed), making it impossible to distinguish a GATT 133 from another failure, and a clean restart of the macOS Bluetooth adapter isn't simple (it would impact the whole Mac's Bluetooth, not just the targeted device) — hence a pragmatic compromise in the PoC (every failure treated as equivalent, log recommending manual action rather than an automated restart). **This limitation is specific to noble/macOS, not to node-ble/BlueZ**: on the production server, `node-ble` talks to BlueZ over D-Bus, which exposes real GATT status codes — the full pattern from the official app (precise 133 detection, 500ms backoff, automatic adapter restart on the 2nd failure) must be fully implemented for Batch 1; do not carry over the PoC's limitation as a production constraint.

**Official connection strategy vs StroyPlant's need (decision made, not yet implemented)**:
`docs/PARROT_OFFICIAL_BLE_SPEC.md` confirms that the official Parrot app only connects to the device
under 3 precise conditions ("unread entries" or "move detected" flag in the advertisement, or an
explicit user action) — never through blind periodic polling. StroyPlant nonetheless keeps its
current periodic polling (`ble/scanner.ts`, `PARROT_POLL_INTERVAL_MS`) **as is**: the Health
Engine needs regular sampling for its rolling baseline/trend detection (section 7.3), a need the
original device (occasional cloud sync) didn't have — switching to pure event-driven mode would
break this data continuity. Decision: **add advertisement flag parsing on top of polling** (immediate
connection as soon as an "unread entries"/"move detected" flag is seen, without replacing the
periodic cycle) — better responsiveness without losing anything.

**Byte location confirmed by real capture on the production server's 2 Parrot Pots (2026-07-28)**:
Parrot SA's Bluetooth SIG Company ID = `0x0043`, confirmed — both devices do advertise
manufacturer data under this key. Observed payload (`node-ble.getManufacturerData()['67']`, already
stripped of the company ID by BlueZ):

| Device          | Payload (hex) |
| --------------- | ------------- |
| Parrot pot a073 | `01 23 03`    |
| Parrot pot a3d3 | `01 23 23`    |

**3 bytes, not 1 as initially assumed.** The "1 flags byte" table in the official PDF is
explicitly scoped to firmwares < 1.1 — the Parrot Pot (VE0.29.1, confirmed identical on both
devices, no OTA) is likely not covered by that table. The first two bytes (`01
23`, identical on both devices) are very likely a static identifier
(firmware/hardware version) — not investigated further. Only the 3rd byte (`03` vs `23`) varies between
devices and is the candidate for the flags.

**Active correlation protocol decided (not yet executed — physical access to the pots required, pending
DestCom)**:

1. Read `NB_ENTRIES`/`LAST_ENTRY_INDEX` via GATT (History service, read-only counters —
   this does not reopen the question of the sample format, definitively dropped in section 7.10).
   Wait for `CURRENT_SESSION_PERIOD` to elapse (already read on `a073`: 900, probably
   seconds = 15 min), re-scan the advertisement and compare the 3rd byte before/after — if a bit
   changes consistently with a new sample appearing, "unread entries" is confirmed.
   **Baseline already captured on `a073` (A0:14:3D:CD:A0:73)**: before connection, payload `01 23 03`;
   NB_ENTRIES=346, LAST_ENTRY_INDEX=3044, CURRENT_SESSION_ID=10,
   CURRENT_SESSION_START_INDEX=2899, CURRENT_SESSION_PERIOD=900. Still need to redo the reading after
   the delay and compare.
2. Physically move a pot (probe removed then replanted elsewhere), compare the 3rd byte
   before/after — tests "move detected".
3. Restart a pot, observe the 3rd byte in the first 3 minutes vs afterwards — tests
   "starting".

**Status (2026-07-28)**: protocol defined, no test executed (DestCom has no physical access
to the pots for now) — to resume once access is possible. **Do not interpret the 3rd
byte or implement any logic based on it until these tests produce a reproducible result**
— if no test moves a bit consistently, stay in "raw log, no interpretation" mode indefinitely
rather than forcing a mapping, and Batch 1's connection strategy remains a classic fixed-interval
scan.

### 7.2 Persistence (SQLite + Prisma)

Tables at minimum:

- `devices` (id, mac/identifier, type, name, last connection)
- `readings` (device_id, timestamp, soil_moisture, conductivity, temp, luminosity, water_level, ...)
- `watering_events` (device_id, timestamp, trigger_source: manual|cron, success bool, error detail if failed)
- `schedules` (device_id, thresholds, allowed_hours, active bool) — implemented as `Schedule`
  (Batch 5, see 7.4), one optional row per device
- `plant_profiles` (imported from CSV — see 7.3)

### 7.3 Health Engine

- **Import of the `assets/plants/watchflower_plantdb.csv` file** from the `emericg/WatchFlower` repo (3404 plant profiles). Useful columns: Soil moisture MIN/MAX (%), Soil conductivity MIN/MAX, Soil PH MIN/MAX, Temperature MIN/MAX (°C), Humidity MIN/MAX (%RH), Light MIN/MAX (lux and mmol).
- Caution: some values are `0;0` — treat as "not applicable", not as a real literal zero. Check case by case during parsing.
- Health scoring by comparing readings (ideally a rolling average, not just the instant value) against the profile's ranges — per-parameter status (`ok` / `too low` / `too high`) + overall status
- Trend detection (degradation over several days), not just the instantaneous state
- Exclude from baseline/scoring calculations any reading where `STATUS_FLAGS.isInAir = 1` (section 7.11 / 8) — a probe out of the soil doesn't represent a plant state, don't let it pollute the averages
- This module feeds: the dashboard, the scheduler (7.4), and the MCP server (7.8)

**Per-device rolling baseline — the primary mechanism, not a bonus (important context constraint)**:

At launch in prod, the pots will already be in soil with existing plants — **no controlled calibration window available for almost all devices** (impossible to test "probe in air" / "dry soil" / "saturated soil" without disturbing an already-installed plant). The system must therefore be able to start blind and progressively build its own personalized reference, rather than depending on an initial calibration:

- Calculate rolling statistics (min/max/average/standard deviation) per device and per metric (VWC, temperature, conductivity, luminosity) over a configurable window (e.g. 7/14/30 days)
- **"Warm-up" period**: for a newly seen device, reduce confidence in health alerts (or suspend them entirely) until a sufficient personal baseline has been accumulated (e.g. at least a few days of data) — avoids false positives from day 1 based solely on a generic species range that may not exactly match this real sensor/pot
- **Combining both sources**: species ranges (CSV, absolute, generic) act as a coarse guard rail (detecting a totally aberrant value); the per-device rolling baseline (relative, personalized) refines the actual scoring over time, once enough data has accumulated
- Drift of the rolling baseline itself (e.g. the average gradually shifts with no watering event or seasonal explanation) is a signal in its own right — may indicate a sensor problem (fouling, calcification) rather than a plant problem, to be distinguished in the dashboard

**Device-side calibration (Plant Dr service) — Batch 6, implemented, secondary option, not an
onboarding prerequisite**:

Initially planned as a 2-user-gesture flow ("air" + "wet"). **Simplified further after discussion
with DestCom during Batch 6 implementation**: the firmware's `DRY_VWC` field (the point below
which the device-side algorithm considers soil "dry") is populated from the assigned species'
`soilMoistureMinPercent` (CSV) — not from a user "air" gesture, which would set an unrealistically
extreme threshold (probe out of the soil ≈ 0%, not a sensible "this plant needs water" line for
real soil). The "air" step was dropped entirely as a result — there is no longer a separate user
gesture for it. The only user action is the **"wet" capture**: right after a normal watering (a
gesture the user does anyway), triggering the calibration reads the device's current calibrated
soil moisture live and writes it as `WET_VWC`.

**`DRY_N`/`WET_N` — resolved empirically, not guessed** (2026-07-28, read-only capture on the real
`PARROT-A073`, see `backend/src/ble/parrot/plantDr.ts`): a real, never-manually-calibrated pot had
`DRY_N = WET_N = 0` alongside factory-default `DRY_VWC=17.5%`/`WET_VWC=22.5%`, and the device's own
`CONFIG_ID` matched exactly what `computePlantDrConfigId()` computes from those values — confirming
both the XOR checksum formula and that VWC fields are stored as percent×10. Since N contributes
nothing to the checksum when 0, and it's what the device already ships with, both calibration
points are written with `n=0` — an evidenced default, not an assumption. Whether the real official
app ever writes a different value for `N` during a live calibration remains unconfirmed, but doesn't
block this implementation (the checksum only depends on the exact values written, and matches).

**Not implemented in Batch 6** (flagged, not silently added): the "automatically rewritten/refined
once the rolling baseline has observed a real low point over several watering cycles" refinement
of `DRY_VWC` mentioned in earlier drafts of this section — this would need a recurring job
re-deriving and rewriting the config over time, and no per-device baseline history exists yet to
refine from meaningfully this early in the project. `DRY_VWC` is currently written once, at
calibration time, from the species minimum, and stays fixed until the user re-triggers calibration.

**`ALGORITHM_STATUS` (`39e1F912`) is not written by this batch** — only `0` (reset) is confirmed in
the decompiled code; values 1-6 are accepted by the firmware but their real effect (does the
device actually water itself autonomously?) isn't confirmed. DestCom asked for an empirical test on
a real pot before Batch 6 is considered fully closed — not yet executed (needs sustained
observation over time, not just an instant read-back), tracked as a follow-up, see section 11.

This calibration remains available and useful for **new devices added after launch** (pot not yet
planted, so a realistic calibration), or if DestCom voluntarily chooses to recalibrate an existing
pot. Not required when adding a device — offered as an optional action (device detail page →
"Calibration Plant Dr" → `/devices/$deviceId/calibration`), with the rolling baseline (above)
covering all devices that never go through this step.

### 7.4 Scheduler / auto-watering (Batch 5, implemented)

- `backend/src/health/scheduler.ts` — `setInterval` tick every `SCHEDULER_TICK_INTERVAL_MS` (15min
  default). Only reads already-collected `Reading` rows (never triggers its own BLE read cycle,
  only a watering write when it decides to act) — kept deliberately independent from the BLE
  scan/poll interval.
- Each tick queries every `PARROT_POT` device with a `plantProfileId` set (Xiaomi has no pump; no
  profile means the Health Engine can't produce a soil-moisture status to act on) and, per device:
  1. Resolves the effective schedule (`resolveEffectiveSchedule`) — a device with no `Schedule` row
     yet still has one: `active` falls back to `plantProfileId != null` (**auto-on as soon as a
     species is assigned, DestCom's explicit choice — no separate opt-in step**), the allowed-hours
     window falls back to 6h-20h and the cooldown to 24h.
  2. Skips if not `active`, outside the allowed hours window, or watered (any source) more
     recently than `cooldownHours` ago (anti-spam).
  3. Skips if the Health Engine's overall status is `warming_up` — same safeguard the dashboard
     uses (7.3): trusting a single parameter before enough personal baseline exists would risk a
     real-world watering trigger on a false read, not just a wrong badge.
  4. Triggers watering only if `soilMoisturePercent`'s status is specifically `too_low` (not the
     overall status — a temperature/luminosity issue never triggers watering, per DestCom).
- `backend/src/watering.ts`'s `triggerWatering()` is shared between this scheduler and the manual
  `devices.water` mutation — the never-fire-and-forget contract (7.1) is enforced in one place:
  every attempt, from either caller, writes an explicit `WateringEvent{success, errorDetail}` row.
- Configured per device on its detail page ("Arrosage automatique" section) via
  `schedule.get`/`schedule.upsert` (tRPC) — active toggle, allowed-hours window, cooldown. Not a
  global setting (`/settings` only links to the per-device page) — each `Schedule` row belongs to
  one device.
- **Real-hardware implication**: any Parrot Pot with a plant profile already assigned becomes
  eligible for autonomous watering the moment this scheduler runs against a real BLE provider — no
  migration/backfill was done, this falls out of the "no schedule row = active if profile assigned"
  default applying uniformly to devices assigned before or after this batch.

### 7.5 Backend API

**tRPC**, not hand-written REST — chosen for real end-to-end type safety between backend and
frontend (single source of truth for input/output shapes, no manually duplicated fetch wrappers or
route/URL strings to keep in sync by hand), which matters more as the API surface grows across
Batches 4-8. Implemented as `appRouter` (`backend/src/api/trpc/router.ts`), mounted on Fastify via
`fastifyTRPCPlugin` (`useWSS: true`) so regular procedure calls and the live-reading subscription
share the same `/api/trpc` prefix — see `CLAUDE.md`'s backend detail section for the exact
procedure list and the Date-serialization note. Current procedures:

- `devices.list` — list + latest reading per device, only devices with a name set (see `Device.name`
  in 7.2/CLAUDE.md — `null` means seen by the scanner but not yet claimed)
- `devices.listUnnamed` / `devices.rename` — backs the "Add device" screen (Batch 3): list devices
  the scanner discovered but the user hasn't named yet, and claim one by giving it a name
- `devices.history` — time series for graphs
- `devices.wateringEvents` — last 10 watering attempts (success/failure) for a device
- `devices.water` — manual trigger, never fire-and-forget (7.1)
- `health.plantProfiles` / `health.assignPlantProfile` / `health.deviceHealth` — Health Engine (7.3)
- `schedule.get` / `schedule.upsert` — per-device auto-watering configuration (Batch 5, see 7.4).
  `get` always resolves to a full object (active/allowed hours/cooldown), never `null` — a device
  with no `Schedule` row yet still has a well-defined effective schedule.
- `readings.onReading` — subscription, replaces the native WebSocket push of new readings (backed
  by a Node `EventEmitter` server-side, consumed via `@trpc/tanstack-react-query`'s
  `useSubscription` client-side)

### 7.6 Auth

- **BetterAuth** (already used by DestCom on other projects, do not reinvent custom auth)
- Start with credentials (email/password), a single admin account
- Design now for a future addition of BetterAuth's native OIDC plugin, without rewriting — the future target is a self-hosted IdP such as **Authentik** (LDAP outpost + OIDC provider in one place), not Keycloak (too heavy for this use case)
- The MCP server (7.8) must be protected by this same auth layer, or at minimum restricted to the local network — never exposed unprotected since it exposes a real action (`trigger_watering`)

### 7.7 Home Assistant integration (Batch 7, implemented)

- **MQTT + auto-discovery** (no HACS Python custom component — consistent with the refusal to mix Python into a 100% TS stack)
- The backend publishes sensors on an MQTT topic in HA's discovery format; Home Assistant detects them automatically with no custom code on the HA side

**Implementation** (`backend/src/mqtt/`: `topics.ts`, `discovery.ts`, `client.ts`, `publisher.ts`,
`commands.ts`):

- **Entirely optional, off by default**: `MQTT_URL` unset means `connectMqtt()` returns `null` and
  every call site treats that as "skip publishing", never as an error — DestCom has no
  Mosquitto/Home Assistant instance to test against yet in production, so the integration must
  never block the backend from starting. `MQTT_USERNAME`/`MQTT_PASSWORD` optional,
  `MQTT_DISCOVERY_PREFIX` (default `homeassistant`) and `MQTT_BASE_TOPIC` (default `stroyplant`)
  configurable.
- **One JSON state topic per device** (`stroyplant/<sanitized-id>/state`), not one raw topic per
  sensor field — each HA entity's discovery config points at the same state topic with its own
  `value_template` (e.g. `{{ value_json.soilMoisturePercent }}`). A separate
  `stroyplant/<id>/health` topic carries the Health Engine's `computeDeviceHealth()` output verbatim
  (7.3) — the "Statut santé" sensor is only meaningful once a species is assigned, but is always
  declared so HA shows "unknown" rather than nothing until then.
- **Entities per device kind**: Parrot Pot gets soil moisture (%), temperature (°C), luminosity
  (mol/m²/j), reservoir level (%), a health-status sensor, an "Arroser maintenant" **button**, and a
  "Dernier arrosage" result sensor (see below). Xiaomi gets temperature, humidity, battery, and the
  same health-status sensor. **Scope explicitly confirmed with DestCom**: the watering button and
  the health-status sensor were both chosen over the simpler/safer "read-only sensors" default.
- **Availability**: a single bridge-wide topic (`stroyplant/bridge/status`), `online` published on
  connect, `offline` as the MQTT client's LWT (retained) — entities go "unavailable" in HA if the
  backend process dies or loses its broker connection, without per-device BLE-connectivity
  granularity (that's a different concept, already shown in StroyPlant's own dashboard).
- **Discovery is republished, not just published once**: at startup, for every already-named
  (claimed) device; on `devices.rename` (a device just got claimed or renamed — same "claimed"
  definition `devices.list` already uses, so nothing appears in HA that isn't in StroyPlant's own
  dashboard); and once from `onDeviceSeen` the first time a device transitions from unnamed to
  named — needed because the mock provider pre-names its devices directly (unlike real BLE
  providers, whose raw advertisement never carries a friendly name), so mock devices would
  otherwise never trigger the `devices.rename` hook at all.
- **The watering button and the never-fire-and-forget rule (7.1)**: Home Assistant's MQTT `button`
  component is a fire-and-forget `command_topic` with no built-in per-press result channel. Rather
  than accept a silent HA-side failure, `triggerWatering()` (`backend/src/watering.ts`) — already
  shared by the manual `devices.water` mutation and the CRON scheduler — now also takes an optional
  MQTT client and publishes the outcome (`success`, `errorDetail`, `timestamp`) to a retained
  `stroyplant/<id>/watering/result` topic **regardless of which surface triggered the watering**, so
  a failure (e.g. empty reservoir) stays visible in Home Assistant too, not just in StroyPlant's own
  UI/logs or the `WateringEvent` table. `backend/src/mqtt/commands.ts` subscribes once to
  `stroyplant/+/watering/set`, resolves the sanitized topic segment back to a real device by
  recomputing `sanitizeDeviceId()` over every named device (ids are MAC addresses containing `:`,
  not reversible from the sanitized form), and calls the exact same `triggerWatering()`.
- **Verified** against the mock provider with a disposable embedded MQTT broker (`aedes`, run
  standalone in the session scratchpad — the local Docker daemon wasn't running this session, so a
  disposable Mosquitto container wasn't an option this time): startup discovery for every named
  device (including real devices already claimed in `dev.db` from earlier batches), live
  state/health publishing on every poll, a watering button press on the empty-reservoir mock pot
  producing an explicit failure surfaced both as a `WateringEvent{success:false}` row and over MQTT,
  and `devices.rename` republishing discovery with the updated device name. No production
  Mosquitto/HA instance exists yet to validate against — this remains to be re-confirmed once one
  is available.

### 7.8 MCP server (Batch 8, implemented)

- Tools to expose: `list_devices()`, `get_plant_status(device_id)`, `get_plant_history(device_id, range)`, `trigger_watering(device_id)`
- Directly reuses the Health Engine (the AI agent consumes the already-computed score, doesn't reinvent the threshold logic)
- Protected by the Auth layer (7.6)

**Implementation** (`backend/src/mcp/`: `context.ts`, `server.ts`, `routes.ts`, using
`@modelcontextprotocol/sdk`): a `/mcp` Streamable HTTP endpoint mounted directly on the same
always-running Fastify backend — confirmed with DestCom over a separate stdio process, since it
lets the MCP server reuse the same BLE provider/connectionQueue/MQTT client with no extra process to
run on the production server. Each request builds a fresh `McpServer` and a stateless transport
(`sessionIdGenerator: undefined`, `enableJsonResponse: true`) bound to that request's authenticated
caller — the 4 tools are simple request/response calls with no server-initiated push, so there's no
session state worth keeping between calls (the MCP SDK's own documented stateless-deployment
pattern). The 4 tools call `appRouter.createCaller(ctx)` directly (`mcp/server.ts`), reusing the
exact same tRPC procedures the frontend uses rather than duplicating device/health/watering logic a
second time. `trigger_watering` never fails silently (7.1): a caught `TRPCError` becomes a tool
result with `isError: true` and the real error message.

**Auth: BetterAuth's official `mcp` plugin (OAuth 2.1)**, confirmed with DestCom over a simpler
static API-key mechanism — it ships in the already-installed `better-auth` package (no new
dependency) and is the protocol-correct mechanism real MCP clients expect (discovery metadata,
Dynamic Client Registration, PKCE authorization code flow). Registered in `auth.ts` with
`loginPage: '/login'` (the app's existing login page — no new frontend work) and
`oidcConfig.allowDynamicClientRegistration: true`. Needs 3 new Prisma models
(`OauthApplication`/`OauthAccessToken`/`OauthConsent`, migration `20260728155824_add_mcp_oauth_tables`)
— the same schema the plugin's underlying `oidcProvider` plugin uses, owned entirely by BetterAuth.
No `consentPage` configured — BetterAuth serves its own default consent HTML, sufficient for this
single-admin, personal-use deployment. An unauthenticated `/mcp/authorize` redirects to `/login`; a
signed `oidc_login_prompt` cookie lets BetterAuth's own after-hook resume the OAuth flow
automatically once the user signs in normally, redirecting to the client's `redirect_uri` with a
code — no bespoke continuation logic needed on StroyPlant's side.

`buildMcpContext` (`mcp/context.ts`) synthesizes a tRPC `Context` from the OAuth session: only
`userId` is real (resolved via Prisma), the rest is a minimal but type-compliant `Session`-shaped
object, since no procedure reads session fields beyond the truthiness check `protectedProcedure`
already does.

`backend/src/api/webBridge.ts` (new, shared by the pre-existing `/api/auth/*` passthrough and the
new MCP/discovery routes) fixes a real gap found while testing: Fastify only parses JSON bodies by
default, but the OAuth token endpoint needs `application/x-www-form-urlencoded` per RFC 6749 (what
real OAuth clients send) — a raw passthrough content-type parser (`registerRawBodyParser`) lets that
content type reach BetterAuth's handler unparsed instead of a Fastify 415.

**Verified end-to-end against the mock provider via curl** (no real MCP client available in this
environment): discovery metadata (`/.well-known/oauth-authorization-server`,
`/.well-known/oauth-protected-resource`), anonymous Dynamic Client Registration, the unauthenticated
`/mcp/authorize` → `/login` redirect with the signed cookie, sign-in resuming the flow and
redirecting back to the client's `redirect_uri` with a code, the PKCE token exchange, and all 4
tools called over `/mcp` with the resulting bearer token — including `trigger_watering`'s explicit
failure on the empty-reservoir mock pot. **Not yet validated**: an actual connection from Claude
Desktop/Claude.ai's remote-connector UI. One open risk flagged to DestCom: the frontend's `/login`
page signs in via `fetch()` (`authClient.signIn.email()`), and BetterAuth's OAuth-resume mechanism
overrides that same response into a redirect toward the MCP client's `redirect_uri` — since
`fetch()` follows redirects internally rather than navigating the browser tab, this may surface as a
confusing "Connexion impossible" error in the UI even when the underlying authorization actually
succeeded. Not fixed pre-emptively since the real behavior depends on the specific `redirect_uri`
Claude.ai's connector uses, unverifiable without a live test — first thing to check at the next real
connection attempt.

### 7.9 Frontend

- **Vite + React + TypeScript**, NOT Next.js (no need for SSR/SEO for an internal dashboard, avoid the weight of a fullstack framework when the backend already exists separately — see detailed reasoning in section 12)
- **tRPC client** (`@trpc/client` + `@trpc/tanstack-react-query`) — `httpBatchLink` for queries/mutations, `wsLink` for the `readings.onReading` subscription. `createTRPCOptionsProxy` produces `queryOptions()`/`mutationOptions()` consumed directly by TanStack Query (see 7.5)
- **TanStack Query** for data fetching/caching (cache updated live by the `readings.onReading` subscription via `queryClient.setQueryData`, not raw WebSocket message handling)
- **TanStack Router** (not React Router) — ecosystem consistency with Query, loaders that preload into the Query cache, full typing of routes/params. Important: TanStack Router alone does NOT imply TanStack Start (the fullstack framework) — we stay on a simple static SPA, no SSR server.
- Tailwind CSS + shadcn/ui
- The build (`dist/`) is served statically directly by the Node backend — no separate nginx/Caddy container, one less process to run on the production server
- Multi-stage Dockerfile: a Node stage that builds Vite, copied into the backend's final image

### 7.10 Parrot Pot history — final decision: fallback to live polling only

**Final decision, no longer an open question.** The History/Upload service (`39e1FC00`/`39e1FB00`) **is not used**. Justification:

- The binary sample format is never deserialized on the official app's side (relayed raw as base64 to the Parrot cloud for server-side decoding) — not deducible via static reverse engineering.
- A plausible hypothesis (16-byte header + 274 entries of 22 bytes `[uint16][float32×5]`, consistent with the 5 raw characteristics `39e1fa01-05`) was tested empirically on a real device and **invalidated**: the decoded floats are denormals/exponents with no physical meaning whatsoever.
- In line with the time-boxing principle, only one verification was attempted, no new hypothesis to explore.

**Consequence for the architecture**: Parrot Pot time series are reconstructed solely via live polling (`39e1fa09/0a/0b`, already covered by Batch 1) and stored as they come into `readings`. No `source` column needed (no more `live`/`history_import` distinction since there's only one source). No Clock synchronization needed for this purpose (its overall status is deprioritized, see section 8). **This batch is removed from the roadmap (see section 11) — its need is already covered by Batch 1, no additional dedicated work.**

### 7.11 Plant Dr integration (device-side calibration) — Batch 6, implemented (write path; `ALGORITHM_STATUS` enable pending real-hardware test)

Read the official Parrot BLE doc /docs/FlowerPower-BLE.pdf to see if there's more information about the Plant Dr service.

The **Plant Dr** service (`39e1FD80`) allows configuring a "dry"/"wet" calibration algorithm **directly on the device**. Once its `ALGORITHM_STATUS` is enabled, the Parrot Pot can decide and act autonomously — even if our backend is offline or out of BLE range.

**Implementation** (`backend/src/ble/parrot/plantDr.ts`, `DeviceProvider.readPlantDrCalibration`/`writePlantDrCalibration` in all 3 providers, `plantDr` tRPC router, `/devices/$deviceId/calibration` frontend page): the checksum/encoding logic lives once in `plantDr.ts` (`computePlantDrConfigId`, `buildPlantDrWriteValues`) — providers are "dumb", they just write the exact `{dryN, dryVwcRaw, wetN, wetVwcRaw, configId}` values they're given, in order, over GATT (node-ble/noble-bridge) or in-memory state (mock, seeded with the real factory-default values below for realism). `plantDr.calibrateWet` (tRPC mutation) derives `DRY_VWC` from the assigned species' `soilMoistureMinPercent`, reads the live calibrated soil moisture as `WET_VWC`, refuses to write if the live reading isn't above the dry threshold (would produce an inverted, nonsensical calibration — validated at the system boundary rather than trusting the caller), then writes all 5 characteristics. See section 7.3 for the full design history (why the "air" gesture was dropped, why `N=0`).

**Confirmed decision (both coexist, this is no longer an open question)**:

- **Backend scheduler (Batch 5)**: the Health Engine (species profiles from the CSV, scoring, trends) remains the **primary** decision, triggering remote watering on every cron cycle.
- **Plant Dr (device-side)**: configured as a **complementary safety net**, active in parallel — the pot keeps watering itself at a minimum according to its own calibration if the backend goes down or loses BLE connectivity. Doesn't replace the Scheduler, adds to it.

**Critical implementation details (from `PARROT_BLE_DEEP_DIVE.md`, to be strictly followed — a mistake here causes the firmware to silently reject the config)**:

- **Writing the watering config is NOT a simple write-only operation**: it's a **read-modify-write** pattern. First read the current state of all Watering service characteristics, only modify the relevant fields, then write back in this exact order: `PLANT_ID` (39e1F902) → `VWC_IRR` (39e1F903) → `VWC_CMD` (39e1F904) → `N_IRR` (39e1F905) → `VWC_IRR_ECO` (39e1F90A) → `VWC_CMD_ECO` (39e1F90B) → `N_IRR_ECO` (39e1F90C) → `TIME_SLOT_START` (39e1F90E) → `TIME_SLOT_DURATION` (39e1F90F) → `VACATION_START` (39e1F910) → `VACATION_END` (39e1F911) → `MODE` (39e1F90D) → **`CONFIG_ID` (39e1F901) last**.
- **`CONFIG_ID` is a validation XOR checksum**, not a simple identifier: XOR of all config fields (each truncated to int16, the two 32-bit timestamps split into low/high halves). The firmware likely compares this value to validate/commit the config — writing it wrong or omitting it risks silently rejecting the whole config. Exact formula in `PARROT_BLE_DEEP_DIVE.md` section 2.
- Same logic for **Plant Dr**: `DRY_N` (39e1FD82) → `DRY_VWC` (39e1FD83) → `WET_N` (39e1FD84) → `WET_VWC` (39e1FD85) → `CONFIG_ID` (39e1FD81, XOR checksum of the 4 previous values, written last).
- **`ALGORITHM_STATUS` (39e1F912) remains unclear for values other than 0**: only the value `0` (reset after maintenance) is confirmed in the observed code. Values 1 through 6 are accepted by the app's validation but their exact meaning (probably an enable/disable or a mode) is not confirmed — **do not assume that a specific value "enables" the algorithm without empirical validation on the real device before implementing this behavior in prod.**

**`STATUS_FLAGS` (`39e1FD86`) fully decoded and wired in (Batch 6)**: a single byte, read best-effort
alongside the other sensors on every poll (`decodePlantDrStatusFlags`, all 3 providers), persisted
on `Reading` (`isDrySoil`/`isWetSoil`/`isEmptyTank`/`isInAir`). 4 significant bits:

| Bit | Mask   | Meaning                                              |
| --- | ------ | ---------------------------------------------------- |
| 0   | `0x01` | Soil detected dry                                    |
| 1   | `0x02` | Soil detected wet/saturated                          |
| 2   | `0x04` | Water reservoir empty ("low reservoir")              |
| 3   | `0x08` | Sensor out of soil (probe poorly planted or removed) |

These flags aren't mutually exclusive (soil neither dry nor wet = normal state). `isInAir=true`
readings are excluded from the Health Engine's rolling-baseline/scoring calculations entirely
(`computeDeviceHealth`, section 7.3) — a probe out of the soil isn't a plant state. The other 3
flags are stored but not yet surfaced in the dashboard UI beyond that (future work, not blocking).

## 8. BLE reference — Parrot Pot

**Absolute source of truth: `docs/PARROT_OFFICIAL_BLE_SPEC.md`** — condensed from the official
Parrot engineering PDF, ranking above any decompilation in case of divergence (see section 9). For
anything it doesn't cover (Parrot Pot-specific), **`PARROT_BLE_REVERSE_ENGINEERING.md`** (at the
project root), obtained from a direct decompilation of the official Parrot Flower Power APK v4.6.2
(non-obfuscated Java code), remains source #2 — ranking above any deduction made from WatchFlower
in case of divergence. **Systematically consult both before implementing anything
touching the Parrot Pot BLE protocol.**

Custom Parrot base UUID: `39e1xxxx-84a8-11e2-afba-0002a5d5c51b`.

**Important correction (from `PARROT_BLE_DEEP_DIVE.md`) — sensor characteristics actually to be used**:
The official app **does NOT use** `39e1fa01` through `39e1fa05` in live mode (these are vestigial characteristics, never subscribed to by the app for the Parrot Pot). Instead it uses:

| UUID       | Role                   | Format                                                            |
| ---------- | ---------------------- | ----------------------------------------------------------------- |
| `39e1fa09` | VWC (soil moisture, %) | **little-endian float32**, already calibrated by the firmware     |
| `39e1fa0a` | Temperature (°C)       | float32 LE, already calibrated                                    |
| `39e1fa0b` | Luminosity             | float32 LE, already calibrated (exact unit confirmed: mol/m²/day) |

**Unit confirmed 100%, no residual ambiguity**: `39e1fa0b` is documented in black and white
as **"calibrated DLI"** (Daily Light Integral) in the official Parrot PDF
(`docs/PARROT_OFFICIAL_BLE_SPEC.md`) — mol/m²/day. This definitively confirms the deduction made
via the third-party lib `Parrot-Developers/node-flower-power` (same UUID named `CALIBRATED_DLI_UUID`,
README documenting `readCalibratedSunlight()` in "photons per square meter (mol/m²/d)"); the old
WatchFlower label ("µmole.m⁻².s⁻¹") is therefore a WatchFlower error/imprecision, not the official
source. See `docs/HEALTH_ENGINE.md` for how it's used in scoring (compared against the CSV column
`Light MIN/MAX (mmol)`, with a ×1000 mol→mmol conversion).

**EC/conductivity characteristics — read since 2026-07-28, CSV mapping still undetermined**:
the Parrot Pot has a soil conductivity sensor (`39e1fa02`, raw, `UUID_LIVE_SOIL_EC`), and the
official PDF confirms three calibrated variants never documented here before: `39e1fa0c` (Ea),
`39e1fa0d` (Ecb), `39e1fa0e` (Ec porous), all float32 LE like fa09/0a/0b. That said,
`CHARACTERISTICS_LIVE_SERVICE` in `HawaiiUUID.java` (decompilation of the official **Parrot
Pot** app, see `PARROT_BLE_DEEP_DIVE.md` section 3) is an exhaustive list that only contains
`LIVE_MEASURE_PERIOD`/`LIVE_VMC_VALUE`/`LIVE_TEMPERATURE_VALUE`/`LIVE_LIGHT_VALUE` — **the
official app itself never reads EC**, neither raw nor calibrated, on the Parrot Pot. The actual
firmware behavior on these characteristics is therefore not guaranteed (calibration potentially
designed for the Flower Power, never exercised on the Pot).

**Decision (2026-07-28)**: read `39e1fa0d` (Ecb) and `39e1fa0e` (Ec porous) anyway — not
`39e1fa0c` (Ea, no candidate CSV match identified — not read) — best-effort (a failure never
invalidates the rest of the reading), both stored in `readings` without being
used by the Health Engine for now. The official PDF itself doesn't settle which one
corresponds to "Soil conductivity" in the WatchFlower CSV ("probably Ecb... but to be confirmed") —
**mapping to be determined empirically** (comparing real values observed on a real device
to the `Soil conductivity MIN/MAX` ranges of the CSV for the assigned species) before wiring
either one into `scoring.ts`.

**No conversion formula is needed** — directly reading a float32 LE on these three characteristics gives the final physical value. Do not use characteristics `39e1fa01-05` nor WatchFlower's approximate formulas for the Parrot Pot: this path is more reliable, confirmed by the official source code.

**⚠️ Mandatory activation prerequisite, confirmed empirically on a real device (otherwise readings freeze silently)**: before reading/subscribing to `39e1fa09/0a/0b`, **write `1` (uint8) to `39e1fa06` (`UUID_LIVE_MEASURE_PERIOD`)** to activate the firmware's active sampling. Without this write, the firmware doesn't continuously refresh its values — a `read()` returns the last value in memory, potentially frozen for a very long time (observed: 20+ minutes with no change whatsoever, with no associated error — a classic silent bug if this detail is missed). **Write `0` on the same characteristic at the end of the session/disconnection** (stop live), likely to save battery when no client is listening. Nuance: the firmware samples at its own internal rate (on the order of a few seconds) — two reads close together may legitimately return the same raw sample, that's not a bug.

**Points confirmed with a high confidence level (direct code reading, not deduction)**:

| Point                         | Confirmation                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manual watering trigger       | Service `39e1F900`, characteristic `39e1F906` (`UUID_WATERING_CMD`), payload `[0x08, 0x00]` = little-endian uint16 worth `8`                                                                                                          |
| Write type                    | `WRITE_TYPE_DEFAULT` — **write with response** (settles the previous ambiguity)                                                                                                                                                       |
| Watering mode (`39e1F90D`)    | Write uint8 — `0 = off`, `1 = auto`                                                                                                                                                                                                   |
| Algorithm status (`39e1F912`) | Write uint8 — enables/disables the auto-irrigation algorithm (not to be confused with a simple "status" — it's a functional toggle)                                                                                                   |
| Device identification         | A Parrot Pot advertises the `HAWAII_WATER_DEVICE` service (`39e1F900`) in BLE advertisements; a plain Flower Power sensor advertises `HAWAII_SENSOR` (`39e1FA00`) — use this filter to distinguish the two device types when scanning |

**Discovered services, up-to-date status**:

- **History service (`39e1FC00`) + Upload (`39e1FB00`)**: **investigated and definitively dropped** — see section 7.10 for the final decision (fallback to live polling). Do not re-explore this path. The official bit-widths of the context characteristics (fc01-fc06, U16/U32 LE) are now documented in `docs/PARROT_OFFICIAL_BLE_SPEC.md` for future reference, but this doesn't change the decision — no code to write for this.
- **Plant Dr service (`39e1FD80`)**: advanced calibration algorithm ("dry"/"wet" points) for auto-irrigation — **kept**, as a complement to the Health Engine (see section 7.11, Batch 6).
- **Clock service (`39e1FD00`)**: UTC synchronization — its only identified use (consistency of internal history timestamps) is no longer relevant since the History service is dropped. No confirmed need elsewhere for now (Plant Dr doesn't depend on it per current analysis) — **deprioritized, to be implemented only if a concrete need emerges along the way**, not preemptively.
- **Device Config service (`39e1FE00`)**: device renaming, configurable reservoir capacity, "available" flag — utility, not tied to a specific batch, to be considered a bonus if time allows.

**Historical LED mechanism (fallback, not confirmed by decompilation)**: raw handle `0xaa` — potentially obsolete or specific to a different firmware version. The decompilation report mentions `39e1fa07` (`UUID_LIVE_LED_STATE`) with only a "probable" confidence level — test this one first rather than the raw handle.

- Battery: `00002a19-0000-1000-8000-00805f9b34fb`
- Device name (standard service): `00002a00-0000-1000-8000-00805f9b34fb`
- Device Information Service (`0x180A`, detailed in `docs/PARROT_OFFICIAL_BLE_SPEC.md`): System ID
  `0x2A23` (8 bytes), Serial Number `0x2A25` (UTF8), Firmware revision `0x2A26` (UTF8), Hardware
  revision `0x2A27` (UTF8) — not read by any current code, kept here for reference if a
  concrete need emerges (diagnostics, firmware version display...).

**Critical timing constraint (documented in the Parrot protocol)**: the pot may drop the BLE connection after about 1 second with no incoming request. Any write operation must be measured in elapsed time since connection, and ideally performed as early as possible after connecting.

**Limit to keep in mind**: this analysis is **static** (decompilation, no real BLE capture) — the confidence level applies to what the official app does, not to what the firmware actually accepts for values different from those used by the app. Empirical validation on the real device (via the `parrotpot-poc/` PoC) remains necessary before production integration, especially for any payload value different from the one observed in the code.

**Mechanical note (unrelated to BLE, useful context)**: on a Parrot Pot whose hydraulic circuit has stayed dry (new or second-hand), the centrifugal pump cannot self-prime — the tube (siphon type) needs to be manually primed once. This is not a software bug nor a BLE issue, it's a well-known phenomenon of non-self-priming pumps. Don't re-debug this path if a user reports watering that does nothing after a long period without water — redirect to checking the priming before digging into the BLE protocol.

## 9. Reference sources — to be consulted systematically

**`docs/PARROT_OFFICIAL_BLE_SPEC.md` is the absolute #1 source for everything it covers** —
it's the original Parrot engineering documentation ("Bluetooth Low Energy Interface
Specification", official PDF still available on developer.parrot.com), ranking above any
third-party decompilation or reconstruction in case of divergence. It targets the base Flower Power
(the Parrot Pot shares this foundation and adds the Watering/Plant Dr services on top). For anything
this document doesn't cover (Parrot Pot-specific: Watering, Plant Dr, `STATUS_FLAGS`) or for
the real behavior of the official app (as opposed to what the protocol allows),
`PARROT_BLE_REVERSE_ENGINEERING.md` and `PARROT_BLE_DEEP_DIVE.md` (direct decompilation of the
official Parrot code) remain source #2, more reliable than the third-party repos below in case of
divergence.

**These three repos remain the project's secondary source of truth (useful for everything else: other devices, implementation structure, code patterns). Always consult them (clone locally if needed) before guessing a behavior, a payload format, or a missing UUID:**

- `https://github.com/emericg/WatchFlower` — the most complete C++/Qt implementation; Parrot Pot driver in `src/devices/device_parrotpot.cpp`, BLE doc in `docs/parrotpot-ble-api.md`, plant database in `assets/plants/watchflower_plantdb.csv`. **GPLv3 license**: fine for private self-hosted use, but attribution required if the project is ever made public.
- `https://github.com/mbrentini/homeassistant_parrotflowerpower` — Python implementation (reading Flower Power sensors via raw ATT handles, no watering)
- `https://github.com/MarkoMarjamaa/homeassistant-flowerpower` — Python implementation via `bluepy` (reading Flower Power sensors via UUID, no watering)

**PoC already done, reusable as a base**: a Node.js/TypeScript CLI (`parrotpot-poc/`) using `@abandonware/noble` has already been specified/developed to unit-test the Parrot Pot from macOS (scan, sensor reading, LED, watering trigger with exhaustive logging). Its code is the natural base for the `noble-bridge` provider (section 6).

## 10. Collaboration rules

- **When in doubt about a technical point or an ambiguous implementation choice, ask DestCom directly rather than choosing arbitrarily and moving on.** He'd rather be interrupted to clarify than later discover a wrong assumption silently baked into the code.
- Before Batch 0, explicitly ask whether he wants to work directly over SSH on the production server for this batch (see section 6, last point) — do not assume.
- Imposed stack: TypeScript/JavaScript everywhere, no Python, consistency with DestCom's existing ecosystem (Next.js usual for other projects, Prisma, shadcn/ui, BetterAuth, Docker/Coolify/Hetzner/Cloudflare).
- **Package manager: `pnpm` exclusively, never `npm` or `yarn`** — whether for the backend, the frontend, or any auxiliary script/tool of the project (including Dockerfiles: use `pnpm install`, not `npm install`).
- DestCom is a fullstack freelancer, ~3.5 years of experience, technically comfortable but not a BLE/low-level hardware expert — explain non-trivial choices rather than applying them without context.

## 11. Breakdown into batches (roadmap)

| Batch        | Content                                                                                                                                                                                                                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Batch 0**  | Working Docker + Bluetooth setup on the production server (TP-Link UB500 Plus dongle). **Ask first whether working directly over SSH is wanted (section 6).**                                                                                                                    |
| **Batch 1**  | Xiaomi scanner (passive) + Parrot Pot driver (GATT), with the 3 interchangeable BLE providers (`mock`, `noble-bridge`, `node-ble`) + SQLite/Prisma + minimal API — includes the `39e1fa06` activation prerequisite (section 8) and the retry/reconnection pattern (section 7.1)   |
| **Batch 2**  | Auth (BetterAuth, credentials only, OIDC hooks ready)                                                                                                                                                                                                                             |
| **Batch 3**  | Frontend Vite + React + TanStack Query/Router + Tailwind + shadcn/ui (protected by Batch 2's auth)                                                                                                                                                                                |
| **Batch 4**  | Plant DB CSV import + Health Engine (scoring, profiles, trends)                                                                                                                                                                                                                   |
| **Batch 5**  | ✅ Auto-watering scheduler (wired to the Health Engine) — see section 7.4                                                                                                                                                                                                         |
| **Batch 6**  | ✅ Plant Dr integration (device-side dry/wet calibration + STATUS_FLAGS), complement to the Health Engine, see section 7.11. `ALGORITHM_STATUS` real-hardware test still pending (follow-up)                                                                                      |
| **Batch 7**  | ✅ MQTT client + Home Assistant auto-discovery, see section 7.7. No production Mosquitto/HA instance to validate against yet (follow-up)                                                                                                                                          |
| **Batch 8**  | ✅ MCP server (tools listed in 7.8), protected by auth. Not yet validated against a real MCP client (follow-up)                                                                                                                                                                  |
| **Batch 9**  | Create the Docker evironnement, dockerfile, dockercompose prod, dockercompose test, GitHub action to build image on GHCR, and all the other necessay things                                                                                                                       |
| **Batch 10** | Extension to other devices (Flower Power, Flower Care). Also includes an optional empirical exploration: testing raw EC reading on the Parrot Pot (`39e1fa02`) on the real device via the production server, with no guarantee of a usable result — the official app doesn't use it (section 8) |

_(The old historical "Batch 2" removed: final decision in section 7.10 — fallback to live polling only, already covered by Batch 1, no dedicated development needed.)_

Each batch must be validated before moving to the next. Do not chain several batches without explicit confirmation from DestCom that the previous one works as expected.

## 12. Why not Next.js / not TanStack Start (context for these decisions, to avoid revisiting them)

- **Next.js dropped**: no need for SSR/SEO (internal dashboard, no anonymous visitors), the backend already exists separately so Next's API routes would be redundant, and a persistent SSR process is an unnecessary burden compared to a simple static Vite build.
- **TanStack Start (the fullstack framework) dropped for the same reason as Next** — despite using TanStack Query and TanStack Router, which are independent libs from Start and imply no obligation to adopt it. Start is currently a Release Candidate (not yet stable 1.0 at the time of writing), adding unnecessary maturity risk for a homelab tool that must stay stable and low-maintenance.
- **React Router dropped in favor of TanStack Router**: ecosystem consistency with Query, built-in loaders, full route typing — without implying Start (see above).

## 13. Portability limits never to be presented as solved

- The project will work on **any Linux host with native Docker Engine** and, very likely, **any Bluetooth dongle recognized by the Linux kernel** (not just the recommended TP-Link UB500 Plus) — BlueZ absorbs chipset differences.
- The project **will not work** on Docker Desktop macOS/Windows (confirmed and lasting limitation, not a detail to be fixed).
- The project only supports **device types for which a driver has been written** — this is not a generic "any BLE sensor" system.
- Never present the project as "universal" or "ready to use on any device" in user documentation — be explicit about these limits in the README.

## 14. Hosting & reverse proxy

DestCom already runs an nginx-based reverse proxy on his production server for other services. Goal: **a single container, a single domain name, a single deploy** — not two separate front/back containers, not two subdomains.

- The Node backend (Express/Fastify) serves **everything** from a single process/port:
  - `/api/*` → the tRPC router (`/api/trpc`, both HTTP procedure calls and the WS upgrade for the
    `readings.onReading` subscription — no separate WS path) + the BetterAuth handler (`/api/auth/*`)
  - everything else → static files from the Vite build (`dist/`), with a **mandatory SPA fallback**: any route that is neither `/api/*` nor an existing static asset must return `index.html`, so that TanStack Router handles client-side routing without a 404 on refresh for a route like `/devices/123`.
- On the reverse-proxy side: a single subdomain, a single `proxy_pass` to `container:port` — no `/api` routing rule to manage at the nginx level, all dispatch logic stays in the Node code.
- **Point of caution**: explicitly verify that the reverse-proxy config generated for this site properly forwards the WebSocket upgrade headers (`Connection: upgrade`, `Upgrade: websocket`) — without this, the WS appears to connect and then silently drops. Do not assume this is the case by default, check the actually-used config file.
- A single `docker-compose` service for the whole app (the multi-stage Dockerfile from section 7.9 produces a single front+back image).
