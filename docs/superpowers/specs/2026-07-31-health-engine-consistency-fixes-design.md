# Health Engine consistency fixes — design spec

Date: 2026-07-31
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

## Scope

In scope: the 6 components below (A–F), all confined to `backend/src/health/`,
`backend/src/ble/parrot/soilConductivity.ts`, and their 2 frontend consumers
(`frontend/src/lib/format.ts`, `frontend/src/routes/_authenticated/devices.$deviceId.tsx`) plus
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

## Frontend type mirroring

`frontend/src/lib/types.ts`'s `ParameterHealth`/`DeviceHealth` interfaces are hand-mirrored copies
of the backend's tRPC output shape (existing pattern, no shared package — see CLAUDE.md's frontend
tRPC section). Both gain the same 2 new fields as the backend (`personalDeviation` on
`ParameterHealth`, `warningParameters` on `DeviceHealth`) to stay in sync.

## Migration/rollout

- No new Prisma migration — all 6 parts are pure computation changes over existing tables/columns
  (`RawSensorLog`, `Reading`, `PlantProfile`, `Device.environment`), no new persisted fields.
- No config/env changes.
- `mock` provider: no change needed for parts B/C/D/E/F (they're pure `scoring.ts`/frontend logic,
  not BLE-provider-specific) — verify against the mock provider's existing simulated data covers
  enough variation for personal-baseline (`unusual_low`/`unusual_high`/`normal`, all 3 reachable) and
  indoor-luminosity (`too_low` reachable for a device with `environment = 'INDOOR'`) to be testable
  without needing new mock-provider code.
- Existing devices with `environment = null` (the current state of every real device — location/
  environment is optional, set via the device detail page's edit dialog) are entirely unaffected by
  Part B until DestCom explicitly sets `INDOOR` on a device.
