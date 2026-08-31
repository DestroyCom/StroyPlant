# Device-side autonomous watering (push species thresholds to the pot) — design

**Date**: 2026-08-30
**Status**: approved by DestCom, pending spec review
**Depends on findings from**: `docs/superpowers/specs/2026-08-29-parrot-official-app-ble-sniffing-findings.md`
(findings #2 and #4, action items #3 and #4)

## Motivation

DestCom's stated goal: StroyPlant should replace the official Flower Power app entirely,
including behavioral parity. The BLE sniffing investigation found that the official app doesn't
just read the pot's sensors and decide watering server-side — at species assignment, it pushes
threshold/config values to the pot's own `f900` "watering config" GATT service and enables an
on-device closed-loop algorithm (`f908=1`). This is how "Plant Sitter" mode gets weeks of
autonomy with no phone/app connection: **the pot decides and waters itself**, not the app.

StroyPlant, by contrast, has UUID constants for this entire service (populated by the Parrot
plant-database import) but has only ever *read* them for the debug `RawSensorLog` table — never
written them. This design delegates the watering decision to the pot itself, matching the
official app's real architecture, while keeping StroyPlant's existing backend scheduler
(Batch 5) alive as a degraded safety net rather than removing it.

## Decisions confirmed with DestCom before this document

1. **Full delegation, not display-only parity.** The pot's on-device algorithm becomes the
   primary decision-maker for these devices (`f908=1`), not just a cosmetic threshold sync. The
   backend scheduler stops being the primary decision path for any device this applies to.
2. **The backend scheduler is not removed** — it becomes a degraded, long-cooldown, huge-delta
   safety net for the case where the pot's own algorithm silently fails (unconfirmed on-device
   behavior, this is new/unvalidated territory). Exact condition: DestCom's own words — "cooldown
   très long et [...] humidité cible à 40% et la plante est à 15% uniquement" (target 40%, actual
   only 15% — a huge gap, not a marginal one).

## Scope: which characteristics get written, and why not the others

The sniffing findings table graded each `f900` field by evidence strength. Only 4 fields have
strong, repeated, exact-match evidence — everything else stayed constant/zero across every real
capture (including across different mode switches), meaning **even the official app doesn't vary
them per species**. Writing them would be speculation, not parity, so this design deliberately
does not touch them.

| Field | Written? | Role (evidence) | Source |
|---|---|---|---|
| `f903` (`vwcIrr`) | **Yes** | Trigger threshold, `%×10` — matched app's displayed number exactly 3/3 tests | `PlantProfile.soilMoistureIrrigatePercent` |
| `f904` (`vwcCmd`) | **Yes** | Target/consigne, `%×10` — matched exactly 3/3 tests | `PlantProfile.soilMoistureCommandPercent` |
| `f905` (`nIrr`) | **Yes** | Anti-repeat delay, 15-minute units (48×15min=12h matched a real user-set delay) | `PlantProfile.irrigateCalibrationSampleCount` (misnamed at import time — this is the delay preset, not a sample count, see finding #4) |
| `f908` (`pumpDutyCycle` in code, mislabeled) | **Yes** | Algorithm enable flag, uint8 — pinned to exactly 0 or 1 across every capture, never a duty-cycle-looking value | Derived: `1` iff the 3 fields above are all non-null and the device is eligible (see gating below), else `0` |
| `f90a`/`f90b` (eco variants) | No | Stayed constant/zero in every real capture | — |
| `f90d` (`mode`) | No | Stayed constant/zero across every mode switch tested — its "mode" label is unconfirmed, possibly mislabeled at import | — |
| `f901`, `f902`, `f90e`-`f912` (except `f908`) | No | Unconfirmed roles, or explicitly flagged in earlier project history as "do not write without empirical validation" (`f912`) | — |

This is intentionally the minimum set with strong evidence — not an attempt to replicate the
app's full mode-switching UI (Perfect Drop / Plant Sitter / Manuel / Custom). StroyPlant exposes
one binary concept — **autonomous on-device watering: on or off** — not a 4-mode picker.

Batch 6's Plant Dr service (`fd8x`, dry/wet calibration) is untouched by this work — it's a
separate GATT service with its own independent purpose (device-side dry threshold as a safety net
when the backend is unreachable at all) and keeps operating exactly as it does today, stacked
alongside this feature.

## Gating: who becomes eligible, and when

Reuses the existing `Schedule`/`resolveEffectiveSchedule` machinery (Batch 5) rather than
introducing new eligibility rules — a device is a push candidate exactly when the backend
scheduler already considers it a watering candidate:

- `resolveEffectiveSchedule(device, schedule).active` is `true` (species assigned, and no
  explicit schedule override disabling it), **and**
- the assigned `PlantProfile` has non-null `soilMoistureIrrigatePercent` AND
  `soilMoistureCommandPercent` (the ~9120 Parrot-sourced species; the ~3400 WatchFlower-only
  species have neither field and are silently ineligible — the existing 100%-backend-decided
  behavior continues unchanged for them, no error surfaced to the user for this case since it's
  an expected, common condition, not a fault).

When both hold: push `f903`/`f904`/`f905` (from the profile) and `f908=1`. When either stops
holding (species unassigned, schedule explicitly deactivated, or a re-push finds the newly
assigned species lacks Parrot data): push `f908=0` only, disabling the pot's own algorithm — never
leave a device autonomously watering per stale thresholds after the user turned off auto-watering
in the StroyPlant UI.

### Trigger points for a push

To avoid a needless BLE write on every unrelated save, a push (enable or disable) only fires when
it can actually change something — never unconditionally on every call to these mutations:

1. `health.assignPlantProfile` — always recomputes eligibility after the DB update (species
   assignment is already a deliberate, infrequent action, not a high-frequency one) and pushes
   enable or disable accordingly. Exception: if the new eligibility is "ineligible" and
   `Device.autonomousWateringActive` is already `false`, skip the push entirely — there is nothing
   to disable on the device.
2. `schedule.upsert` — recomputes `resolveEffectiveSchedule(...).active` before and after the
   update; pushes only if that `active` boolean actually flipped. Saving unrelated fields (e.g.
   adjusting `cooldownHours` or the allowed-hours window while already active) never triggers a
   push.
3. A new manual "Repousser maintenant" button (frontend), for re-syncing on demand — e.g. after
   the Parrot plant-database itself gets re-imported/updated, or to retry after a prior push
   failure. Unlike the two automatic call sites, this one always pushes (enable if currently
   eligible, disable otherwise) regardless of whether anything appears to have changed — it exists
   specifically to force a re-sync when the automatic paths might have missed something.

No periodic re-push (e.g. from the scheduler tick or the poller) — the official app itself only
pushes at species (re-)assignment, not continuously, so this matches its real behavior.

## Data model changes

```prisma
model Device {
  // ...existing fields...
  autonomousWateringActive    Boolean   @default(false)
  autonomousWateringUpdatedAt DateTime?
}

enum SyncSource {
  POLL
  MANUAL
  CONFIG_PUSH // new — device-side autonomous watering config push failures (this feature)
}
```

`autonomousWateringActive` is the scheduler's gate for the degraded-safety-net behavior (below) —
deliberately a cached DB flag, not a live GATT read on every scheduler tick, since a live read
would cost a full `connectionQueue`-serialized connection per device per tick. It's set to `true`
**only** after a confirmed-successful enable push, and `false` on any disable push, any failed
push, or if it was never pushed — the flag never gets set optimistically ahead of confirmation
(same "never silently trust an unconfirmed BLE outcome" principle as every other write path in
this codebase, spec section 7.1). `autonomousWateringUpdatedAt` is display-only (frontend "dernière
config poussée le...").

**CORRECTED, real-hardware finding (2026-08-30, same day)** — "false on any disable push, any
failed push" above turned out to be the wrong policy for a *failed* disable specifically: a real
hardware test hit 4 consecutive disable attempts failing with connection errors (not a value
mismatch), and forcing `false` in that case wrongly told the scheduler the device was no longer
autonomous when its real on-device state was genuinely unknown (the write may have partially
applied, or the pot's own algorithm could still be running). `backend/src/wateringConfigPush.ts`
now only forces `false` after a confirmed-failed **enable** attempt (or a pre-flight failure before
either branch was reached) — a failed disable leaves the flag untouched until a disable actually
confirms. See CLAUDE.md's "First real production incident" / device-side-autonomous-watering
entries for the full history.

No new table for the pushed values themselves — like Plant Dr's `getCalibration`, the device
itself is the source of truth; a live read (`wateringConfig.getConfig`, below) fetches current
values on demand for display, nothing is cached in SQL beyond the one boolean+timestamp needed for
the scheduler decision.

## BLE / provider layer

New file `backend/src/ble/parrot/wateringConfig.ts` (mirrors `plantDr.ts`'s shape, no checksum
needed here — unlike Plant Dr's `fd81` `CONFIG_ID`, nothing in the sniffing captures suggested the
`f900` service validates a composite checksum, each characteristic write is independent):

**CORRECTED 2026-08-31 — this assumption was wrong and was the root cause of the config-persistence
bug tracked as a follow-up to this feature.** `f901`/`CONFIG_ID` in this same service turned out to
be exactly the same kind of XOR-16 validation checksum as Plant Dr's `fd81`, just missed by the
original sniffing analysis — see `docs/superpowers/specs/2026-08-31-parrot-watering-config-checksum-fix.md`
for the full root cause and fix. The read-modify-write-then-checksum contract this design doc
originally waved off as unnecessary is exactly what `wateringConfig.ts` implements today.

```typescript
export interface WateringConfigEnableValues {
  vwcIrrRaw: number; // already *10, e.g. 32.0% -> 320
  vwcCmdRaw: number;
  nIrr: number; // raw 15-minute units, written as-is
}

export type WateringConfigWrite =
  | { mode: 'enable'; values: WateringConfigEnableValues }
  | { mode: 'disable' };
```

`DeviceProvider` gains two methods (mirroring `readPlantDrCalibration`/`writePlantDrCalibration`):

```typescript
readWateringConfig(deviceId: string): Promise<{ vwcIrrRaw: number | null; vwcCmdRaw: number | null; nIrr: number | null; algorithmEnabled: boolean | null }>;
writeWateringConfig(deviceId: string, write: WateringConfigWrite): Promise<void>;
```

Write order for `enable`: `vwcIrr` (`f903`) → `vwcCmd` (`f904`) → `nIrr` (`f905`) → `f908=1` last —
same "enable flag written last" convention Plant Dr already established, so a failure partway
through never leaves the algorithm turned on with a half-applied config. For `disable`: write only
`f908=0`, leave `f903`/`f904`/`f905` untouched (irrelevant while the algorithm is off).

Implemented in `mock` (full in-memory simulation, matching the existing per-device state pattern
`mock/index.ts` already uses for Plant Dr) and `node-ble` (production). **`noble-bridge` is out of
scope**, same cut already made for Plant Dr and the soil-conductivity work — it's a Mac dev tool,
not production, and this feature needs no Mac-side validation.

## Async write pattern (fire-and-poll)

Reuses the exact pattern `plantDrCalibrationSession.ts` established for `calibrateWet`, for the
same reason: a config push is 3-4 sequential `connectionQueue`-serialized BLE writes, each with
its own retry/backoff/adapter-restart policy, easily exceeding Cloudflare's ~100s origin timeout
if awaited inline (the exact bug already root-caused and fixed for `calibrateWet`, 2026-08-29 —
see the Gotchas section of `CLAUDE.md`).

New module `backend/src/wateringConfigPushSession.ts` — same shape as
`plantDrCalibrationSession.ts`: per-device run state (`idle`/`running`/`success`/`error`),
`setPushRunState`/`getPushRunState`/`isPushRunning`.

New tRPC router `wateringConfig` (mirrors `plantDr` router):

- `getConfig` — live read via `readWateringConfig` (query, like `plantDr.getCalibration`).
- `pushRunStatus` — polled status query (like `plantDr.calibrationRunStatus`).
- `push` — mutation, validates synchronously (device exists, is a Parrot Pot), then kicks off the
  background enable/disable sequence and returns `{status: 'started'}` immediately, same as
  `calibrateWet`. Used by both the automatic call sites (`assignPlantProfile`, `schedule.upsert`)
  and the manual "Repousser maintenant" button.

On success: update `Device.autonomousWateringActive`/`autonomousWateringUpdatedAt`. On failure:
leave/set `autonomousWateringActive = false`, log, and write a `SyncEvent{source: 'CONFIG_PUSH',
errorDetail}` row — surfaces automatically in the existing global History page, no new UI needed
for failure visibility (spec section 7.1: never silently swallow a BLE error).

## Backend scheduler: degraded safety net

`backend/src/health/scheduler.ts`'s `evaluateDevice` changes in two places:

**Cooldown**: when `device.autonomousWateringActive`, the effective cooldown becomes
`Math.max(effective.cooldownHours, DEGRADED_MIN_COOLDOWN_HOURS)` — a new constant,
`DEGRADED_MIN_COOLDOWN_HOURS = 72`. A user-configured cooldown already longer than 72h is
respected as-is; a shorter or default (24h) one is floored to 72h once the pot is autonomous.

**Trigger condition**: replaces the plain `status !== 'too_low' → skip` check. When
`autonomousWateringActive`:

```typescript
const soilMoisture = health.parameters.soilMoisturePercent;
const target = device.plantProfile?.soilMoistureCommandPercent;
if (soilMoisture?.value == null || target == null) return; // no signal to act on
if (soilMoisture.value >= target - LARGE_DELTA_THRESHOLD_POINTS) return; // gap not large enough
```

`LARGE_DELTA_THRESHOLD_POINTS = 20` (percentage points) — a new named constant, matching
DestCom's own example (target 40%, actual 15% → gap of 25, well past the 20-point floor). When
`autonomousWateringActive` is `false`, behavior is entirely unchanged from today (the existing
`status !== 'too_low'` check).

This reuses `target` (`soilMoistureCommandPercent`), the exact same value driving the device's own
`f904` — when the on-device algorithm and the backend safety net ever both need to act, they're
reasoning from the same number.

## Frontend

New component `AutonomousWateringSection.tsx`, placed on the device detail page next to the
existing `AutoWateringSection` (Batch 5's schedule config) — this is watering-behavior UI, not
sensor calibration, so it does not go on the separate `/calibration` route.

Shows: a status badge (**Actif** / **Inactif** / **Non éligible — espèce sans données Parrot**,
the last one when a species is assigned but lacks the required fields), the currently-pushed
values from a live `wateringConfig.getConfig` read (mirrors the Plant Dr calibration page's
"read live from the device" pattern), `autonomousWateringUpdatedAt` as "Dernière config poussée
le...", and a "Repousser maintenant" button (polls `pushRunStatus` while running, same UX as the
Plant Dr calibration page's "Calibration en cours…").

## Error handling summary (spec section 7.1 compliance)

- A profile lacking Parrot data → silent no-op, not an error (expected, common, not a fault).
- A BLE write failure at any point in the enable/disable sequence → `SyncEvent{CONFIG_PUSH}` row +
  log line + `autonomousWateringActive` set/kept `false`. Never silently dropped, never
  optimistically marked active before confirmed.
- A concurrent push attempt while one is already running for the same device → `CONFLICT` (same
  pattern `calibrateWet` already uses), not a silently overlapping second write sequence.

## Rollout on real hardware

**No backfill.** The 2-3 real production Parrot Pots that already have a species assigned today
do not get pushed automatically the moment this ships — a push only fires on a *new*
`assignPlantProfile` or `schedule.upsert` call, both of which require an explicit action DestCom
takes deliberately. This naturally staggers rollout: DestCom controls exactly which real pot gets
its first push and when, by choosing when to re-save its species/schedule (or press the new manual
button) after deploying this feature.

Validation on real hardware is **not** a quick BLE-sniff-and-confirm like the trigger
investigation — `f908`'s effect is a multi-day autonomous-behavior claim, not an instant
ATT-level acknowledgment. The real test: push the config to one real pot, then observe over
several days whether it waters itself in a way consistent with the pushed thresholds, with the
StroyPlant backend's own manual/scheduled triggers left alone during that window so any watering
event unambiguously came from the pot itself.

## Non-goals (explicit, so a future reader doesn't wonder if they were missed)

- No mode picker (Perfect Drop / Plant Sitter / Manuel / Custom) — StroyPlant exposes one binary
  autonomous on/off concept, not the app's 4-mode UI.
- `f90a`/`f90b` (eco thresholds), `f90d` (mode), `f901`, `f902`, `f90e`-`f912` except `f908` are
  never written by this feature — insufficient evidence, see the Scope table above.
- No interaction with the unresolved `f906`/`f90c` manual-trigger mystery — this feature only
  touches the periodic config service, not the one-shot manual trigger characteristic. The manual
  "Arroser maintenant" button's behavior is completely unchanged.
- No `noble-bridge` implementation (Mac dev tool, not production — same cut as Plant Dr).
- No backfill/automatic push onto already-assigned real devices at deploy time.
- No change to `PARROT_OFFICIAL_BLE_SPEC.md` or the `fa07`/`fa09` sensor swap — unrelated findings
  from the same investigation, already fixed separately.
- No live-session-connection-reuse for faster manual triggers (finding #1's other action item) —
  a separate, unrelated piece of future work.

## Testing plan

- **Mock provider**: extend with per-device in-memory watering-config state (mirrors its existing
  Plant Dr simulation). Unit/integration tests (Node's `node:test`, this project's established
  suite):
  - Assigning a Parrot-data-rich species → `push` succeeds → `autonomousWateringActive: true` →
    `getConfig` reflects the pushed raw values.
  - Assigning a WatchFlower-only species (no Parrot fields) → no push attempted, flag stays
    `false`, no `SyncEvent` written (this is the expected no-op path, not a failure).
  - Unassigning a species, or deactivating the schedule → disable push → `f908=0` written,
    `autonomousWateringActive: false`.
  - A simulated write failure mid-sequence → `SyncEvent{CONFIG_PUSH}` row written,
    `autonomousWateringActive` stays `false`, `pushRunStatus` reflects `error`.
  - A concurrent second `push` call while one is running → `CONFLICT`.
  - Scheduler: `autonomousWateringActive: true` + small delta (e.g. target 30%, actual 25%) → no
    trigger. Same device + huge delta (target 40%, actual 15%) + cooldown elapsed → triggers. Same
    huge delta but within the 72h degraded cooldown → no trigger.
- **`tsc --noEmit`/`biome check`** on all touched files, matching this project's standard bar.
- **Real hardware**: staged, DestCom-driven, over multiple real days — see Rollout section above,
  not part of the automated test suite.
