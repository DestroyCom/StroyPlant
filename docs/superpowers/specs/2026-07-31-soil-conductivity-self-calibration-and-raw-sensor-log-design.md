# Soil conductivity self-calibration + full raw sensor log — design spec

Date: 2026-07-31
Status: approved by DestCom, ready for implementation planning

## Purpose

`ble/parrot/soilConductivity.ts` decodes the raw `39e1fa02` characteristic using WatchFlower's
hardcoded calibration constants (`RAW_MIN=1500`/`RAW_MAX=2036`). Empirically confirmed on both real
Parrot Pots (2026-07-31, SSH to production, disposable `node-ble` container, `stroyplant` briefly
stopped): raw readings of 775 and 983 fall below `RAW_MIN`, permanently clamping the decoded
"Fertilité du sol" value to 1000/1000 (max) on both real pots — a live wrong-data problem, not
cosmetic.

Investigated 16 community Parrot/Flower-Power repos plus the 3 official `Parrot-Developers` org
repos: no formula found anywhere is a validated fix — most either leave the raw value unconverted
(`// TODO: convert raw (0 - 1771) to 0 to 10 (mS/cm)`, present verbatim in two independent repos,
never resolved) or apply no clamp/remap at all, with no ground-truth validation either way. A naive
"pass the raw value through as µS/cm" idea was also rejected: it would invert the fertility
direction (the current formula's `RAW_MAX - raw` inversion is physically necessary — a *higher* raw
ADC reading means *less* conductive soil) and doesn't resolve the real open question, which is that
even WatchFlower's own app compares its sensor's `[0,1000]`-clamped output directly against its own
CSV's real µS/cm thresholds (confirmed via `DeviceWidget.qml:685-687`, `UtilsNumber.normalize(...)`)
with no unit conversion — an apparent scale question baked into the reference implementation itself,
not something this project introduced or can silently fix by picking a different formula.

Conclusion: no formula swap is defensible without real per-device data. This spec instead builds a
per-device, self-improving calibration derived from actual accumulated readings, replacing
WatchFlower's fixed global constants — plus, at DestCom's request, a comprehensive raw-sensor debug
log covering every known Parrot Pot / Xiaomi characteristic, not just conductivity.

## Scope

In scope:
- Move soil-conductivity interpretation from write-time (BLE provider, at poll time) to read-time
  (Health Engine / frontend), so a device's whole reading history is never "frozen" against
  calibration bounds that later improve.
- A new `RawSensorLog` table capturing literally everything we know how to read from a Parrot Pot
  or Xiaomi device on every normal poll, decoded value or not, used or not — a debug/audit trail,
  not a UI-facing feature.
- Per-device conductivity calibration derived from `RawSensorLog` history, with an explicit
  confidence gate (not enough data yet → "calibrating", never a misleading number).
- Every regular Parrot Pot poll now also reads the Watering config service, the remaining Plant Dr
  fields, and the Calibration service — previously only touched by dedicated on-demand tRPC calls
  (`plantDr.getCalibration`) or not read at all during normal operation.

Out of scope (explicitly deferred):
- Actually decoding `39e1fe01`'s calibration blob semantics, or the `fa0c`/`fa0d`/`fa0e` dead-end
  characteristics — logged as raw bytes/absent, not interpreted.
- Any retention/pruning policy for `RawSensorLog` (same open-ended stance already taken for
  `SyncEvent` — revisit once real production volume exists).
- Promoting the calibration confidence-gate thresholds (see below) to a `Settings` page control —
  simple exported constants for now, YAGNI.
- Any change to `noble-bridge`'s priority/testing status — updated best-effort for interface
  consistency, not validated against real hardware (matches its existing "Mac dev tool, not
  production" status).

## Part 1 — Architecture: raw at write-time, interpretation at read-time

Today, `readSensors()` (all 3 providers) calls `decodeSoilConductivityRaw()` immediately and
persists only the decoded `Reading.soilConductivityUsCm`. This can't support a calibration that
improves over time — recomputing every historical row every time new extremes are observed isn't
practical.

New flow: providers persist the **raw** `fa02` uint16 only (via `RawSensorLog`, see Part 2).
`Reading.soilConductivityUsCm` is no longer written by providers going forward (existing historical
values, all effectively frozen at the old formula's output, are left as-is — no backfill, no
migration of old rows). Whenever a "fertility" value is needed (Health Engine scoring, frontend
gauge, history chart), it's derived on the fly from `RawSensorLog.soilConductivityRaw` using the
device's *current* calibration bounds (Part 3) — always the best available interpretation, never
stale. Concretely, `api/trpc/routers/devices.ts`'s `history` procedure must also change: today it
returns `Reading.soilConductivityUsCm` directly; going forward it needs to join each returned
`Reading` to its `RawSensorLog.soilConductivityRaw` and apply `decodeSoilConductivityRaw()` with the
device's current calibration bounds at query time — otherwise the history chart would show `null`
for every conductivity point from the moment this ships. Historical rows that predate
`RawSensorLog` (no raw value ever captured) keep showing their old frozen
`Reading.soilConductivityUsCm` value as a fallback, so the chart's past doesn't go blank — only its
future stops relying on the frozen column.

## Part 2 — `RawSensorLog` (new Prisma model)

One row per successful `Reading`, linked 1:1 via `readingId` (unique FK). Every field nullable —
absent/unreadable on a given poll (e.g. `fa0c`/`fa0d`/`fa0e`, confirmed unavailable on real Pot
firmware) is recorded as `null`, not omitted, so a `null` here is itself informative ("still absent
as of this poll") rather than ambiguous with "we didn't try."

**Parrot Pot — Live service (`39e1fa00`)**: `lightRaw` (fa01), `soilConductivityRaw` (fa02),
`soilTempRaw` (fa03), `airTempRaw` (fa04), `soilMoistureRaw` (fa05), `soilMoistureCalibrated` (fa09,
duplicated from `Reading.soilMoisturePercent` for this table's self-containment), `airTempCalibrated`
(fa0a, duplicated from `Reading.temperatureC`), `luminosityCalibrated` (fa0b, duplicated from
`Reading.luminosity`), `eaRaw`/`ecbRaw`/`ecPorousRaw` (fa0c/0d/0e — expected to stay `null`).

**Watering service (`39e1f900`)**: `waterTankLevelPercent` (f907, duplicated from
`Reading.waterTankLevelPercent`), `watVwcIrr` (f903), `watVwcCmd` (f904), `watNIrr` (f905),
`watPumpDutyCycle` (f908), `watVwcIrrEco` (f90a), `watVwcCmdEco` (f90b), `watNIrrEco` (f90c),
`watMode` (f90d), `watTimeSlotStart` (f90e), `watTimeSlotDurr` (f90f), `watVacationStart` (f910),
`watVacationEnd` (f911), `algorithmStatus` (f912).

**Plant Dr service (`39e1fd80`)**: `plantDrStatusFlagsRaw` (fd86, the raw byte — in addition to the
already-decoded booleans on `Reading`, kept here in case the bit-mapping is ever found wrong),
`plantDrDryN`/`plantDrDryVwcRaw`/`plantDrWetN`/`plantDrWetVwcRaw`/`plantDrConfigId` (fd82-fd85/fd81
— previously only read on-demand via `plantDr.getCalibration`, now also read every regular poll),
`plantDrNextWateringDate` (fd87), `plantDrNextEmptyTankDate` (fd88), `plantDrFullTankAutonomy`
(fd89).

**Calibration service (`39e1fe00`)**: `calibrationDataBlobHex` (fe01, 28 raw bytes as hex — no known
decode), `colorRaw` (fe04).

**Xiaomi LYWSD03MMC**: `tempRaw` (int16), `humidityRaw` (uint8), `voltageRawMv` (int16) — decomposed
per-sensor rather than one opaque payload hex, matching the Parrot Pot's level of detail.

Every field is read best-effort and individually caught (same pattern already used for
`soilConductivityRaw`/`STATUS_FLAGS` in `node-ble/index.ts` today) — one missing/errored
characteristic never fails the rest of the poll. `providers/types.ts`'s `SensorReading.data` gains
all these fields as optional; `readings.ts`'s `persistReading()` writes the new `RawSensorLog` row
alongside the existing `Reading` row whenever any raw field is present.

**Practical consequence**: a normal Parrot Pot poll now opens 4 GATT services (Live, Watering, Plant
Dr, Calibration) instead of 3 (Live; Watering for tank level only; Plant Dr for status flags only) —
the Calibration service is newly touched during regular polling. The extra characteristic reads
happen within the same already-open GATT session (no additional connect/disconnect overhead, which
is the expensive part of a poll), so the marginal cost per extra characteristic is small — but the
overall poll does more work and has more individual read steps that can (harmlessly, per the
best-effort pattern) fail.

## Part 3 — Conductivity calibration module

New `backend/src/health/soilConductivityCalibration.ts`:

- `getCalibration(deviceId): Promise<{ rawMin: number; rawMax: number; readingCount: number;
  daysCovered: number; calibrated: boolean } | null>` — one aggregate query over `RawSensorLog`
  joined to `Reading` (`MIN`/`MAX(soilConductivityRaw)`, `COUNT`, oldest `Reading.timestamp`),
  filtered to `Reading.source = 'POLL'` (same convention as the rest of the Health Engine — a live
  session must never pollute this any more than it pollutes the baseline/trend calculations).
- **Confidence gate** (exported constants, not a Settings field): `MIN_CALIBRATION_DAYS = 14` and
  `MIN_CALIBRATION_RAW_RANGE = 50` (on the ~0-2047 raw ADC scale). `calibrated` is `true` only once
  both are satisfied — otherwise the device simply hasn't shown enough real variation yet to trust
  derived bounds, regardless of how many readings have piled up in that time.
- **No expiry, ever** (DestCom's explicit choice over a rolling window): once the min/max bounds
  are established from history, an old extreme (e.g. a fertilizer event from months ago) remains
  part of the calibration forever — a calibration should reflect the widest real range this specific
  device has ever shown, not "recent" behavior.
- `ble/parrot/soilConductivity.ts`'s `decodeSoilConductivityRaw()` is refactored to take
  `{ rawMin, rawMax }` as parameters instead of the hardcoded WatchFlower constants — same
  clamp+inverted-map formula, now per-device. Called from the Health Engine/frontend read path
  (Part 1), not from the BLE provider.

## Part 4 — Health Engine integration

- `ParameterStatus` (`health/scoring.ts`) gains a new value: `'calibrating'`.
- `computeDeviceHealth()`'s `soilConductivityUsCm` handling: calls `getCalibration()` first; if not
  `calibrated`, the parameter reports `{ status: 'calibrating', value: null, speciesRange: null }`.
  This is scoped to *this one parameter* — it does **not** push the whole device into
  `warming_up` (that status already means "not enough baseline for anything," a different, coarser
  concept than "this one sensor's calibration specifically isn't ready"). `'calibrating'` is treated
  like `'n/a'` for the purposes of `hasOutOfRange` (never counted as an out-of-range condition).

## Part 5 — Frontend

The fertility gauge shows a "Calibration en cours" message (in place of a numeric value/color) when
its status is `'calibrating'` — same visual slot as the current n/a handling, just a distinct label
so it reads as "not ready yet" rather than "not applicable to this plant."

## Migration/rollout

- New additive Prisma migration: `RawSensorLog` table + 1:1 relation to `Reading`.
- `Reading.soilConductivityUsCm` column is left in place (existing historical rows keep whatever the
  old formula produced) but is no longer written by any provider going forward.
- All 3 providers updated: `node-ble` (priority — real production hardware), `mock` (must simulate
  plausible raw values across all the new fields for dev/testing, including enough variation over
  simulated time for the calibration gate to eventually flip to `calibrated` in tests), `noble-bridge`
  (best-effort, matches its existing lower-priority/Mac-dev-tool status).
- No backfill of historical raw data (didn't exist before this change) — `RawSensorLog` starts empty
  at deploy time and only fills going forward; the conductivity calibration gate will show
  "calibrating" for every real device again for at least 14 days post-deploy, restarting the clock
  even for `PARROT-A073`/`PARROT-A0-73`-equivalent devices that already had history under the old
  formula.
