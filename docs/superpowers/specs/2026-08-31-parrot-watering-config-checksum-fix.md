# Parrot watering config CONFIG_ID checksum — root cause and fix (2026-08-31)

Resolves the `f900` "watering config" write-persistence mystery tracked in
`[[project_autonomous_watering_f903_f904_revert]]`. Not committed yet — pending DestCom's review.

## Root cause

`f901` (`UUID_WATERING_CONFIG_ID`) is not a plain configuration field — it's an **XOR-16
validation checksum** over the other 12 characteristics of the `39e1f900` "Watering" GATT service.
The firmware only commits a config batch once it can recompute this checksum from the 12 fields it
just received and it matches what was written to `f901`. `backend/src/ble/parrot/wateringConfig.ts`
never wrote a correct (or any) `f901`, and only ever wrote 4 of the 13 characteristics — the other
9 were never even read, let alone preserved — so every write this project ever made to this service
was checksum-inconsistent by construction and silently rejected by the device.

This was already fully documented in `docs/PARROT_BLE_DEEP_DIVE.md` section 2 (from the decompiled
official app, `PlantConfig.getWateringConfigId()`), including the exact formula and write order —
it just hadn't been connected to this specific bug before now. The sibling `fd80` "Plant Dr"
service already uses the identical pattern (`plantDr.ts`'s `computePlantDrConfigId()`), already
implemented and hardware-validated since Batch 6 — this project had, in effect, already solved this
exact class of problem once before without realizing the `f900` service needed the same treatment.

## How this was found

DestCom asked 3 AI assistants in parallel (this Claude session continuing its own earlier
packet-capture re-analysis, a second independent Claude Code instance, and ChatGPT) to dig into the
same `.pklg` captures with the same open questions. Reports in
`docs/debug_analyse/31082026_WOrkingLikeTheRealApp/`. All 3 converged on the checksum hypothesis
independently; the second Claude instance found and verified the exact formula against 6 real
capture vectors (perfect_drop/plant_sitter/manuel/custom/live/workout), and — critically — pointed
back at `docs/PARROT_BLE_DEEP_DIVE.md` section 2, which turned out to already have the complete,
authoritative answer from the decompiled official app. This session independently re-derived the
formula from scratch and re-verified all 6 of those vectors plus 3 more of its own (from a
different capture file), 9/9 exact matches — see `wateringConfig.test.ts`.

## The formula

```
watering_config_id (uint16) =
    (int16) plant_id                                    // f902
  ^ (int16) round(vwc_irr * 10)                          // f903
  ^ (int16) round(vwc_cmd * 10)                          // f904
  ^ (int16) n_irr                                        // f905
  ^ (int16) round(vwc_irr_eco * 10)                      // f90a
  ^ (int16) round(vwc_cmd_eco * 10)                      // f90b
  ^ (int16) n_irr_eco                                    // f90c
  ^ (int16) watering_time_slot_start                     // f90e
  ^ (int16) watering_time_slot_duration                  // f90f
  ^ (int16) (watering_vacation_start & 0xFFFF)            // f910, low half of the uint32
  ^ (int16) (watering_vacation_start >>> 16)              // f910, high half
  ^ (int16) (watering_vacation_end   & 0xFFFF)            // f911, low half
  ^ (int16) (watering_vacation_end   >>> 16)              // f911, high half
  ^ (int16) watering_mode                                 // f90d
```

Write order (`WriteWateringConfig.java:82-94`, `docs/PARROT_BLE_DEEP_DIVE.md` section 2):
`PLANT_ID → VWC_IRR → VWC_CMD → N_IRR → VWC_IRR_ECO → VWC_CMD_ECO → N_IRR_ECO → TIME_SLOT_START →
TIME_SLOT_DURATION → VACATION_START → VACATION_END → MODE → CONFIG_ID (last)`. The official app
always **reads the device's current config first**, only changes the fields a given user action
actually concerns, then rewrites all 13 — a read-modify-write pattern, not write-only.

## What changed

- **`backend/src/ble/parrot/wateringConfig.ts`** — new `WateringConfigFields` (all 12 non-checksum
  characteristics), `computeWateringConfigId()`, `mergeWateringConfigOverrides()` (the
  read-modify-write merge), `buildWateringConfigWriteValues()` (attaches the computed checksum).
  `WateringConfigRaw` now carries all 13 fields on a read, not just 3 plus a wrong `algorithmEnabled`
  flag. The file's own header comment previously claimed no checksum/commit field existed in this
  service — corrected.
- **`backend/src/ble/parrot/uuids.ts`** — added the 2 missing UUIDs this fix needed:
  `watering.configId` (`f901`) and `watering.plantId` (`f902`), neither previously mapped at all.
- **`backend/src/providers/node-ble/index.ts`** — `readWateringConfig` now reads all 13
  characteristics (was 4); `writeWateringConfig` now takes a fully-resolved
  `WateringConfigWriteValues` (computed by the caller) and writes all 13 in the documented order,
  CONFIG_ID last — replacing the old logic that wrote only `vwcIrr`/`vwcCmd`/`nIrr` plus `f908`
  (`pumpDutyCycle`) as a wrong stand-in "enable" flag (the real enable/mode field is `f90d`,
  already flagged as a separate, real bug by the earlier sniffing-findings doc).
- **`backend/src/wateringConfigPush.ts`** — both the enable and disable paths now read the
  device's current config first, merge in only the fields they actually want to change
  (`vwcIrrRaw`/`vwcCmdRaw`/`nIrr`/`mode=1` for enable; just `mode=0` for disable, preserving
  thresholds as advisory values exactly like the real app's own Manuel-mode behavior), then let
  `wateringConfig.ts` compute the checksum — never duplicating that math here, matching this
  project's established "providers/orchestration stay dumb, checksum logic lives in one file"
  convention from Plant Dr.
- **`backend/src/providers/mock/index.ts`** — the mock provider now actually enforces the checksum
  gate (rejects a write whose `configId` doesn't match what it computes from the other 12 fields),
  so a future regression of this exact bug would be caught by the existing mock-based dev/test
  flow, not only by real hardware.
- **`backend/src/providers/noble-bridge/index.ts`** — signature updated to match, still throws
  "not implemented" (unchanged scope, matches this provider's existing Plant Dr precedent).
- **`backend/src/ble/parrot/wateringConfig.test.ts`** — 9 real-vector tests (see above) plus unit
  tests for the uint32 vacation-field folding and the existing threshold-encoding helper.

## Verification

- `tsc --noEmit` clean, `pnpm test` 156/156 passing (was 147 before this branch), `biome check`
  clean on every touched file.
- **Confirmed live on real hardware**, pot 8733 (`A0:14:3D:CD:87:33`), via a disposable
  `node:22-bookworm-slim` container on the production server (`stroyplant` stopped for the
  duration, standard practice for this kind of manual BLE test in this project's history):
  read the device's real current config (`plantId=1071 vwcIrrRaw=260 vwcCmdRaw=320 nIrr=384
  mode=0`, `configId=75` — self-consistent, matches `computeWateringConfigId` exactly), wrote a
  distinguishable new config (`vwcIrrRaw=297 vwcCmdRaw=361`, correct new `configId=79`),
  disconnected, waited 5s, reconnected fresh, read back — **the new values were there, not
  reverted**. Scripts: `backend/scripts/hwtest-watering-config-checksum.ts` (the persistence test)
  and `backend/scripts/hwtest-restore-8733.ts` (restores the pot to its original values — not yet
  successfully re-run, see below).

## Known loose end

The restore-to-original write (same session, right after the successful persistence test) failed
3/3 attempts with `le-connection-abort-by-local`, a transient BLE connectivity issue this project
has hit and self-healed from before (see the "Second production incident round" and earlier
entries in `CLAUDE.md`'s Project status) — not related to the checksum fix itself (the read and the
first write both succeeded cleanly in the same session). Pot 8733 currently holds the test values
(29.7%/36.1%) instead of its original (26.0%/32.0%). No real consequence — no species assigned, no
real plant, dedicated test pot — but should be restored next time the pot is reachable via
`hwtest-restore-8733.ts`, or simply left alone if not worth the trip.

## Not done yet

- Not committed — the diff is real, tested, and hardware-confirmed, but sitting in the working
  tree pending DestCom's review.
- Pot 8733 not yet restored to its original config (see above).
- `CLAUDE.md` needs a Project status entry for the whole device-side-autonomous-watering feature —
  it currently has none at all, a pre-existing gap this fix doesn't close by itself (the feature
  still needs its own end-to-end write-up once merged).
- `plantId` (`f902`)'s real meaning is still unconfirmed — this fix treats it as an opaque
  read-preserve-write field (matching the read-modify-write pattern for every field this project
  doesn't independently need to set), so this is not a blocker, just an open curiosity. One AI
  report speculated it might be `PlantProfile.parrotSpeciesId` (Parrot's own catalog ID for the
  assigned species) — plausible given the decompiled name `watering_plant_id`, not verified.
- Real-hardware confirmation only covers the "enable" path (writing thresholds + mode=1). The
  "disable" path (mode=0, thresholds preserved) uses the identical mechanism and is covered by
  the same unit tests, but wasn't separately hardware-tested this session.
