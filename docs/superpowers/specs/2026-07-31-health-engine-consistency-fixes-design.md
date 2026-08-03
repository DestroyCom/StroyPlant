# Health Engine consistency fixes — design spec

Date: 2026-07-31 (Part H added 2026-08-03, Part I added 2026-08-03)
Status: approved by DestCom, ready for implementation planning

## Purpose

An independent audit of the Health Engine (`backend/src/health/`), run deliberately without reading
any project documentation (code + real `dev.db` data + the decompiled official Parrot app only, per
DestCom's explicit request), surfaced 5 findings:

1. Luminosity comparison is structurally wrong for indoor Parrot Pots — the one real production
   reading (`PARROT-A073`, `dev.db`) is `0.1 mol/m²/day`, while `PlantProfile.lightMinMmol` values
   (WatchFlower CSV, garden/outdoor-oriented) sampled from the same DB run `2000–7500 mmol/m²/day`
   (2–7.5 mol/day). A real indoor device will structurally read `too_low` forever, regardless of
   actual plant health — permanent noise, not a variable signal. `Device.environment` (indoor/
   outdoor) already exists on the schema but is read nowhere in `health/scoring.ts`.
2. `computeDeviceHealth`'s own docstring (`scoring.ts:97-101`) claims to combine "the species
   profile's generic ranges (coarse guardrail) and a device-specific rolling baseline" — but no such
   baseline exists in the comparison logic. `HealthSettings.baselineWindowDays` only bounds how far
   back the caller's Prisma query goes (`scheduler.ts:56`, `api/trpc/routers/health.ts:51`,
   `mqtt/publisher.ts:30`) — it never feeds a statistical comparison inside `computeDeviceHealth`
   itself. Every device of the same species is judged against identical absolute thresholds, with no
   account for its own individual history.
3. `soilConductivityCalibration.ts`'s `getCalibration()` (`:24-48`) derives `rawMin`/`rawMax` from
   the device's all-time raw min/max, recomputed fresh on every call, no expiry, no outlier
   rejection. Because `decodeSoilConductivityRaw()` always stretches `[rawMin, rawMax]` to fill the
   full `[0, 1000]` output scale, and `resolveConductivityValue()` (`:56-59`) re-derives *every*
   historical reading against the *current* bounds on every query, a single spurious raw reading
   (electrical glitch, bad contact) permanently redefines the calibration and silently reshapes the
   entire historical chart — not a crash, but a real trust/correctness problem for anyone reading
   trend data.
4. The conductivity gauge can render a `warning` (orange) tone via `toneFor()`
   (`devices.$deviceId.tsx:27-28`) at the same time the device-level badge says everything is fine —
   `soilConductivityUsCm` is deliberately excluded from `hasOutOfRange` (`scoring.ts:157`, a
   previously confirmed, documented decision) but the frontend gauge doesn't know that and paints an
   alert color anyway. Contradictory signal shown simultaneously on the same screen.
5. `healthHeadline()` (`format.ts:48-58`) picks the *first* `too_low`/`too_high` entry from
   `Object.entries(health.parameters)` with no explicit filter — it only avoids reporting
   conductivity as the cause of a warning today because `soilConductivityUsCm` happens to be last in
   `PARAMETERS_BY_KIND.PARROT_POT` (`scoring.ts:37`). Nothing enforces that order; a future reorder
   or new excluded parameter would silently break this.

This spec addresses all 5. Full audit detail (real query results, web research on DLI ranges) lives
in the conversation history that produced it, not duplicated here.

A second, independent review (external, not by DestCom or this assistant) of the wider BLE/health
codebase was cross-checked against the real code afterward. Most of it restated already-known,
already-correct behavior or was itself mistaken (e.g. a claimed "duplicate poll" bug in
`namedDevicePoller.ts` that doesn't exist — `lastPolled` is set *before* `connectionQueue.run()`
specifically to prevent that class of duplication, not cause it). One genuine, minor finding
survived verification and is folded into this spec as Part G below: `lastPolled`/
`consecutiveFailures` (`namedDevicePoller.ts:27-31`) are never pruned when a device is deleted from
the database — an unbounded (if practically negligible at this project's scale) memory leak.

**2026-08-03 addition (Part H) — a 6th finding, discovered empirically, not by static audit**: SSH'd
into the production server and pulled 5 days of real `Reading` rows for both real Parrot Pots
(`dev.db`'s successor, `prod.db`) to validate this spec's still-unimplemented Part B before building
it, prompted by DestCom noticing the dashboard calling out "not enough light" at times when a plant
obviously couldn't be receiving any (nighttime). The real data confirmed something worse than a
nighttime edge case: `39e1fa0b`, despite being confirmed-and-documented as mol/m²/day (DLI), behaves
as an **instantaneous** light-derived reading, not a true accumulated daily total — flat ~0.1 mol/day
floor overnight, a sharp solar-noon peak (~70 mol/day observed on the window-side pot), back to floor
by evening. `computeDeviceHealth`'s `recentValue` (a 1-hour rolling average, `scoring.ts:26,138-140`)
compares this instantaneous signal directly against the species' absolute full-day DLI thresholds —
structurally invalid for the *entire* comparison, at any time of day, not just at night: the
window-side pot reads `too_low` most of the day and `too_high` for the hour around solar noon,
essentially never `ok`. Part B (below) does not fix this — it only changes which threshold indoor
pots are compared against, still feeding it the same instantaneous 1-hour-average input. Part H
fixes the actual input: a real trapezoidal daily integral over each calendar day, replacing
`recentValue` for the `luminosity` parameter across all environments (not just indoor).

## Scope

In scope: the 9 components below (A–I), confined to `backend/src/health/` (Part H adds
`health/dailyLightIntegral.ts` and touches `health/settings.ts`),
`backend/src/ble/parrot/soilConductivity.ts`, `backend/src/ble/namedDevicePoller.ts` (Part G only),
`backend/src/api/trpc/routers/plantDr.ts` (Part I only — unrelated to the Health Engine itself, see
Part I's own note), `backend/prisma/schema.prisma` (Part H only — new `HealthSettings.timezone`
field), and 3 frontend consumers (`frontend/src/lib/format.ts`,
`frontend/src/routes/_authenticated/devices.$deviceId.tsx`,
`frontend/src/components/health-engine-settings-section.tsx` — Part H's timezone field) plus
`frontend/src/lib/types.ts`'s mirrored type definitions.

Out of scope (explicitly deferred, confirmed with DestCom):
- Any change to when auto-watering triggers (`health/scheduler.ts`'s `soilMoisturePercent ===
  'too_low'` check) — the new personal-baseline signal (part C) is additive/display-only and never
  feeds the scheduler. Zero behavior change to physical watering triggers from this spec.
- A real per-species indoor light dataset — no such data exists anywhere (WatchFlower CSV, the
  official Parrot app, or the other Flower Power repos), so part B uses published general
  low/medium/high-light houseplant categories as an explicitly approximate stand-in, not a
  per-species indoor value.
- Any UI for tuning the new 2σ personal-baseline threshold or the percentile calibration bounds —
  same YAGNI stance the project already takes for `MIN_CALIBRATION_DAYS`/`MIN_CALIBRATION_RAW_RANGE`
  (plain exported constants, not `HealthSettings` fields, until a real reason to tune them appears).

## Part A — Species-range comparison: unchanged for outdoor/unknown environment

No behavior change to the existing `speciesRangeFor()`/`too_low`/`too_high`/`ok` logic
(`scoring.ts:62-75, 142-158`) when `Device.environment` is `'OUTDOOR'` or `null`. This is the
baseline every other part below is layered onto or exempted from.

## Part B — Indoor luminosity: published light-category floor comparison

New logic in `scoring.ts`, applied only when `key === 'luminosity'` AND the device's
`environment === 'INDOOR'`:

1. Classify the *species* into a light category using its own existing `lightMinMmol` (already
   imported from the WatchFlower CSV, no new import/schema work):
   - `lightMinMmol / 1000 <= 5` (species tolerates ≤5 mol/day outdoors, i.e. a shade-tolerant
     species) → **low** category
   - `5 < lightMinMmol / 1000 <= 15` → **medium** category
   - `lightMinMmol / 1000 > 15` (a sun-loving/garden species) → **high** category
2. Compare the device's recent luminosity value (already in mol/day pre-conversion, see
   `UNIT_CONVERSION`, `scoring.ts:46-48`) against a **floor only** for that category — published
   general houseplant DLI categories (cited in-code as approximate, not device-validated):
   `low → 2 mol/day`, `medium → 5 mol/day`, `high → 10 mol/day`.
3. `too_low` if below the floor, otherwise `ok`. **Never `too_high`** for indoor luminosity — ambient
   window light with no supplemental grow lighting is out of this project's scope to ever flag as
   "too much," and no credible floor-only-vs-ceiling asymmetry data exists to justify one.
4. Unlike conductivity, this indoor-adapted status **still counts toward `hasOutOfRange`** — the
   whole point of building real categories (vs. the simpler "exclude from badge" alternative
   considered and rejected) is to keep the signal meaningful, not silence it.
5. `speciesRange` reported on `ParameterHealth` for this case is `[floorValue,
   Number.POSITIVE_INFINITY]`, keeping the existing `[number, number]` tuple contract
   `rangeHint`/`referenceLinesFor` (`devices.$deviceId.tsx:33-48`) already assume. Both helpers gain
   a small branch: when `max` is `Number.POSITIVE_INFINITY`, `rangeHint` renders "≥ Xmol/j attendu"
   instead of "X–Ymol/j attendu", and `referenceLinesFor` emits only the min reference line (an
   infinite max reference line on the chart is meaningless and must not be drawn).

## Part C — Personal baseline: additive signal, never the scheduler

New field on `ParameterHealth` (`scoring.ts`, mirrored in `frontend/src/lib/types.ts`):

```ts
personalDeviation: 'unusual_low' | 'unusual_high' | 'normal'
```

Computed identically for **every** parameter of every device kind (Parrot Pot and Xiaomi alike —
the whole point of this fix is cross-sensor consistency):

- Uses the same `readings` set already passed into `computeDeviceHealth` (bounded by
  `baselineWindowDays` upstream, same convention `scoring.ts` already follows elsewhere).
- Mean and stddev (reusing the existing `average()`/`stdDev()` helpers, `scoring.ts:77-86`) computed
  over that window, **excluding** the same `RECENT_WINDOW_MS` slice used for the live comparison
  value (`recentSource`, `scoring.ts:122-125`) — comparing a value against a baseline that includes
  itself would understate any real deviation.
- `personalDeviation = 'unusual_low'` if `recentValue < personalMean - 2*personalStdDev`,
  `'unusual_high'` if `> personalMean + 2*personalStdDev`, else `'normal'`. 2σ is a standard
  statistical convention, not an invented domain constant.
- `'normal'` (not computed) while the device is still `warming_up` (reuses the existing
  `warmingUp` flag, `scoring.ts:120` — no new gate to invent) or when there are fewer than 2 history
  points to derive a stddev from (`stdDev()` already returns `0` below 2 points, which combined with
  a mean-only baseline would make every value trivially "unusual" — must be explicitly guarded, not
  left to fall out of the math).
- **Never influences `status`, `hasOutOfRange`, or the device-level `DeviceHealthStatus`.** Computed
  and reported purely for display. `health/scheduler.ts` is untouched by this part — confirmed
  explicitly with DestCom given the real-world consequence of loosening the auto-watering trigger
  condition.

## Part D — Conductivity calibration: percentile bounds instead of absolute min/max

`soilConductivityCalibration.ts`'s `getCalibration()` changes from `prisma.rawSensorLog.aggregate()`
(`_min`/`_max`) to fetching all non-null `soilConductivityRaw` values for the device (scoped to
`source: 'POLL'`, unchanged) via `findMany`, sorting them, and computing the 5th and 95th percentile
(nearest-rank or linear interpolation — implementation detail, not user-facing) as the new
`rawMin`/`rawMax` bounds passed into `decodeSoilConductivityRaw()`. `MIN_CALIBRATION_RAW_RANGE`'s
comparison changes from `(max - min)` to `(p95 - p5)`, same threshold value (`50`), same meaning
("has this device shown enough real spread yet").

Practical effect: an isolated outlier reading no longer redefines the whole 0–1000 scale — it simply
clamps to `0` or `1000` at the extreme end (via `decodeSoilConductivityRaw`'s existing `clamp()`,
`soilConductivity.ts:28-30, 43`) instead of stretching every other historical value's derived
percentage. The "no expiry, ever" design decision (all-time history, not a rolling window) is
unchanged — this only changes *which statistic* is derived from that same all-time history.

Cost note: `findMany` over a device's full `RawSensorLog` history is more work than the previous
single `aggregate()` call, but at this project's personal-scale data volumes (a handful of devices,
polled every few minutes) this is not expected to be a real performance concern — no caching/
pagination added preemptively (YAGNI, matches the project's general stance).

## Part E — Gauge/badge visual consistency

New `SensorGauge` tone: `notice` (`sensor-gauge.tsx`'s `TONE_VARS`) — a distinct, visually muted
color from `warning`'s orange (e.g. a neutral slate/gray), signaling "informational, not an active
alert." `toneFor()` (`devices.$deviceId.tsx:27-28`) gains a parameter or a second helper so
call sites that render parameters excluded from `hasOutOfRange` (conductivity today; indoor
luminosity is NOT excluded per Part B, so it keeps using `warning`) pass `notice` instead of
`warning` for a `too_low`/`too_high` status. The gauge's existing `hint` prop (already rendered
below the label, `sensor-gauge.tsx:44`) carries a short clarifying string, e.g. "n'affecte pas le
statut global," for any parameter shown in `notice` tone.

The new Part C `personalDeviation` signal reuses this same `notice` tone (not a second new visual
language) when `'unusual_low'`/`'unusual_high'` — e.g. a small badge/icon on the gauge, distinct
from the hint text used for the conductivity case above but sharing the same "informational, not an
alert" visual register.

## Part F — Structural fix for `healthHeadline`'s ordering fragility

`DeviceHealth` (`scoring.ts`) gains a new field:

```ts
warningParameters: ParameterKey[]
```

Populated inside `computeDeviceHealth`'s existing per-parameter loop (`scoring.ts:130-161`) — every
key that actually sets `hasOutOfRange = true` (i.e. `too_low`/`too_high` AND not excluded, matching
the exact condition at `scoring.ts:157` today, extended for Part B's indoor-luminosity case which
DOES count) is pushed onto this array. `format.ts`'s `healthHeadline()` (`:48-58`) reads
`health.warningParameters[0]` directly instead of re-deriving the same filter via
`Object.entries(...).find(...)`. This removes the array-order dependency at its root — the frontend
no longer needs to know or re-implement which parameters are excluded from the badge; it only
consumes the backend's own authoritative list, which stays correct automatically if a future
parameter is added to either PARROT_POT/XIAOMI or to the excluded set.

## Part G — Prune stale poller Map entries on device deletion

Unrelated to the Health Engine itself, but folded into this same implementation pass (DestCom's
explicit request after cross-checking an external review): `namedDevicePoller.ts`'s `lastPolled` and
`consecutiveFailures` module-level `Map`s (`:27-31`) are keyed by `deviceId` and never cleaned up
when a `Device` row is deleted — entries accumulate forever for devices that no longer exist.
Negligible at this project's real scale (a handful of devices, ever), but a one-line-cost fix: at the
start of each tick in `startNamedDevicePoller`'s `setInterval` callback (`:64-88`), after fetching
`devices`, build a `Set` of current device ids and delete any `lastPolled`/`consecutiveFailures` map
key not present in it, before the existing per-device polling loop.

## Part H — Real daily light integral, replacing the instantaneous luminosity comparison

Discovered and confirmed empirically 2026-08-03 (see the addition to "Purpose" above) — not part of
the original 2026-07-31 audit. Fixes the actual input Part B's category floors (and the unmodified
Part A raw species range, for outdoor/unknown environment) are compared against, for the
`luminosity` parameter, across **all** environments (not just indoor — the instantaneous-vs-daily-
threshold mismatch is not an indoor-only problem).

1. **New file `backend/src/health/dailyLightIntegral.ts`**, structurally parallel to
   `soilConductivityCalibration.ts`: `computeDailyTotals(readings, timezone): DailyLightTotal[]`.
   Groups a device's `luminosity` readings (raw, mol/m²/day units, same source as today —
   `source: 'POLL'` only, matching every other Health Engine baseline calculation so a live session
   can never skew this) into calendar days in the given IANA `timezone`, most recent day first.
2. **Trapezoidal integration**: each raw reading is already an instantaneous rate expressed in
   "mol/m²/day-equivalent" units (confirmed by the observed real-hardware pattern: flat ~0.1 floor
   overnight, sharp peak at solar noon, not a monotonically-accumulating counter). For two
   consecutive readings within the same calendar day, the light received during that interval is
   `((value1 + value2) / 2) * (elapsedMs / 86_400_000)` (average rate × elapsed fraction of a day) —
   summed across all consecutive pairs in the day gives that day's true total mol/m² received. The
   partial interval before the day's first reading and after its last reading is not counted (edge
   trapezoids dropped) — negligible error since both edges sit in the flat overnight floor in
   practice.
3. **Day completeness gate**: a calendar day is "complete and usable" only if no gap between two
   consecutive readings within it exceeds **2 hours** (a constant, `MAX_GAP_MS`, exported next to
   `computeDailyTotals` — same YAGNI stance as `MIN_CALIBRATION_DAYS`/`MIN_CALIBRATION_RAW_RANGE`,
   not a `HealthSettings` field). A day that fails this gate is dropped entirely from the returned
   list — neither counted as good nor bad, treated like missing data, consistent with how the rest
   of the Health Engine already treats gaps (no interpolation across missing readings anywhere
   else).
4. **`HealthSettings` gains a `timezone` field** (`String`, default `"UTC"`, migration required —
   this is the one part of this spec that DOES need a Prisma migration, unlike A–G). Editable in the
   existing "Moteur de santé" Settings card (`health-engine-settings-section.tsx`) alongside
   `baselineWindowDays`/`warmupMinDays`, via the existing `health.getSettings`/`upsertSettings`
   procedures (extend their zod schema/return shape, no new procedure). Used only by
   `computeDailyTotals`'s day-boundary grouping — no other part of the codebase gains timezone
   awareness. DestCom's explicit choice over hardcoding UTC: a France-based user's "today" should
   mean their calendar day, not the server's.
5. **`scoring.ts` integration, `luminosity` key only**:
   - `recentValue` for `luminosity` is no longer the 1-hour rolling average — it becomes the total
     from the most recent **complete** day returned by `computeDailyTotals` (first element of the
     list, since it's most-recent-first). This value feeds the exact same downstream comparison
     Parts A/B already define (raw species range for outdoor/unknown, category floor for indoor) —
     no change to `speciesRangeFor`/Part B's category logic itself, only to what value reaches it.
   - **Warm-up gate**: if `computeDailyTotals` returns zero complete days (brand-new device, or
     every day so far failed the 2h-gap gate), `luminosity`'s `status` is `'calibrating'` (reusing
     the existing `ParameterStatus` value from Part D, not a new enum member) with `value: null` —
     mirrors the conductivity gate's shape exactly, but with its own threshold (1 complete day, not
     14 — a daily total is a complete, independent measurement the moment a day finishes, unlike a
     calibration range that needs many samples to stabilize) and its own frontend hint copy ("Historique
     de lumière insuffisant" rather than conductivity's "Calibration en cours" — Part E's `notice`
     tone gauge already supports a per-case hint string, no new tone needed).
   - The gauge still shows the **live instantaneous raw value** (already read every poll) as
     informational text alongside the daily-total-based status/value — e.g. "Aujourd'hui : X mol/j
     (en cours)" under the main gauge value — never contributing to `status`. Purely so the dashboard
     doesn't look "frozen" between two day boundaries.
6. **Move-the-plant advisory**: if the 3 most recent *complete* days (from `computeDailyTotals`) are
   all `too_low` against the applicable threshold (species range or indoor category floor, same
   comparison as step 5), the frontend shows a short advisory line under the luminosity gauge:
   *"Lumière insuffisante depuis 3 jours — envisagez de rapprocher la plante d'une fenêtre."* A
   single isolated `too_low` day (e.g. one overcast day) does not trigger this — computed on the
   frontend from a new `DeviceHealth` field, `luminosityRecentDaysTooLow: boolean` (backend, set in
   `scoring.ts` from the same 3-day window), not re-derived client-side from raw readings.
7. **No historical backfill**: `computeDailyTotals` operates on whatever raw `Reading.luminosity`
   rows already exist — a device with a year of history immediately benefits (its past days are
   simply recomputed as real integrals the first time this ships), no migration script needed.

## Part I — Plausibility upper bound on `calibrateWet`'s captured wet-point value

Discovered and confirmed empirically 2026-08-03, same production data pull as Part H, but an
unrelated subsystem (Batch 6's Plant Dr device-side calibration, not the Health Engine) — folded
into this same spec/plan at DestCom's explicit request rather than a separate document, since it
was found in the same session.

**Finding**: `plantDr.ts`'s `calibrateWet` mutation (`backend/src/api/trpc/routers/plantDr.ts:43-57`)
takes a **live** soil-moisture reading from the device at the exact moment the button is pressed and
writes it as `WET_VWC`, checked only against a lower bound (`wetVwcPercent <= dryVwcPercent` →
reject). No upper sanity bound exists. On the real `A0:14:3D:CD:A3:D3` pot, this captured `72.6%`
VWC — physically implausible for real potting substrate (typical mixes saturate well below that,
long before free water starts draining out) — almost certainly because the button was pressed while
water was still actively draining through the soil immediately after pouring, not once the reading
had settled a few minutes later. The resulting device-side calibration span (`15.0%`–`72.6%`) is
unrealistically wide.

**Fix**: add an upper plausibility bound, same hard-reject pattern as the existing lower-bound
check (a `TRPCError({code: 'BAD_REQUEST', ...})`, no override) — `calibrateWet` throws if
`wetVwcPercent` exceeds `MAX_PLAUSIBLE_WET_VWC_PERCENT = 55` (a plain exported constant next to the
mutation, not a `HealthSettings`/species field — same YAGNI stance as this spec's other gate
constants: a general ceiling for realistic potting-mix saturation, not a per-species value, matching
how Part B's indoor-light categories are already explicitly "published general figures, not
per-species data"). Error message tells the user what happened and what to do:
`"Reading (${value}%) is implausibly high for soil saturation — wait a few minutes after watering
for the reading to settle, then retry."` No change to the existing lower-bound check or to
`buildPlantDrWriteValues`/the device write path itself — this only adds one more guard before that
write happens.

**Out of scope**: retroactively fixing the already-written `72.6%` calibration on the real pot —
DestCom will re-run `calibrateWet` manually once this ships, no backend correction script needed
(the device is always re-read live on every future calibration, so a stale bad value self-heals the
next time the feature is used correctly).

## Frontend type mirroring

`frontend/src/lib/types.ts`'s `ParameterHealth`/`DeviceHealth` interfaces are hand-mirrored copies
of the backend's tRPC output shape (existing pattern, no shared package — see CLAUDE.md's frontend
tRPC section). Both gain the same fields as the backend to stay in sync: `personalDeviation` (Part
C) and `liveValue: number | null` (Part H, step 5 — the informational instantaneous reading; always
`null` except for `luminosity`) on `ParameterHealth`; `warningParameters` (Part F) and
`luminosityRecentDaysTooLow: boolean` (Part H, step 6) on `DeviceHealth`.

## Migration/rollout

- Parts A–G need no new Prisma migration — pure computation changes over existing tables/columns
  (`RawSensorLog`, `Reading`, `PlantProfile`, `Device.environment`), no new persisted fields. **Part
  H is the one exception**: `HealthSettings` gains a `timezone` column (migration required, default
  `"UTC"` so existing single-row settings resolve with no manual step).
- No config/env changes.
- `mock` provider: no change needed for parts B/C/D/E/F/G (they're pure `scoring.ts`/frontend/poller
  logic, not BLE-provider-specific) — verify against the mock provider's existing simulated data
  covers enough variation for personal-baseline (`unusual_low`/`unusual_high`/`normal`, all 3
  reachable) and indoor-luminosity (`too_low` reachable for a device with `environment = 'INDOOR'`)
  to be testable without needing new mock-provider code. Part G is testable directly (delete a mock
  device row, confirm its Map entries are pruned on the next tick). **Part H** needs the mock
  provider's simulated luminosity to cover enough of a real day/night cycle for `computeDailyTotals`
  to produce at least one complete day and exercise the 2h-gap exclusion and the 3-consecutive-day
  advisory — check `providers/mock/index.ts`'s existing luminosity simulation covers this before
  writing new mock logic, only add what's missing.
- Existing devices with `environment = null` (the current state of every real device — location/
  environment is optional, set via the device detail page's edit dialog) are entirely unaffected by
  Part B until DestCom explicitly sets `INDOOR` on a device. Part H applies regardless of
  `environment` (see Part H's intro) — every Parrot Pot's luminosity comparison switches to the
  daily-integral input the moment this ships, whether `environment` is set or not.
