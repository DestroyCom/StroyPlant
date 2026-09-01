# fa07 root cause: LED state, not soil moisture (2026-09-02)

## Starting point

Round 4 (`docs/superpowers/specs/2026-09-01-parrot-fa07-independent-decode-fix.md`) contained the
blast radius of `fa07` returning a truncated 1-byte buffer on all 3 real Parrot Pots, but never
explained *why*. DestCom pushed back on the implicit "device firmware is broken" framing: the
official app works perfectly for every feature, and `fa07` had previously been confirmed as real
soil moisture via a controlled heat-stimulus test (2026-08-29). Both of those observations are
real — the resolution is that the 2026-08-29 mapping itself was wrong.

## The actual mapping, per the decompiled source

`docs/PARROT_BLE_REVERSE_ENGINEERING.md`'s Live-service table (built from `BleTaskHandler.java`,
"Certain" confidence for most rows) names:

| UUID | Constant | Real role |
|---|---|---|
| `fa05` | `UUID_LIVE_SOIL_PERCENT_VWC` | **Soil moisture %** |
| `fa07` | `UUID_LIVE_LED_STATE` | LED indicator state — not a sensor |
| `fa09` | `UUID_LIVE_VMC_VALUE` | Moisture-adjacent, different scale than fa05 |
| `fa0a` | `UUID_LIVE_TEMPERATURE_VALUE` | **Temperature** |
| `fa0b` | `UUID_LIVE_LIGHT_VALUE` | Luminosity (already correct in this codebase) |

This codebase had `soilMoisturePercent → fa07` and `temperatureC → fa09` — both wrong, in a
different way than the already-corrected 2026-08-29 "swap" (which concluded fa07/fa09 the other
way around, also wrong).

## Confirmation, in order

1. **`docs/ble-captures/16_test_2SEPT.pklg`** (PacketLogger, real iOS app running natively on
   DestCom's Apple Silicon Mac, connected to pot `87:33`) — `tshark`-analyzed. `fa07`'s real GATT
   declaration: Read+Write, **no Notify property**. The app never reads, writes, or subscribes to
   `fa07` anywhere in the capture, despite the user touching the moisture sensor 5 times and
   blowing on the temperature sensor. `fa0b` (luminosity) stayed a stable `cdcccc3d` (0.1),
   confirming that mapping is fine and giving confidence in the analysis method.
2. **Direct reproduction via `noble`/CoreBluetooth on the Mac** (pot `87:33`, 5 consecutive cold
   reads): `fa07` returned `00` (1 byte) every time, identical to the production server's BlueZ
   logs — ruling out anything BlueZ- or Linux-specific. `fa0a` read `0` (suspicious, in-air probe)
   and `fa0b` read `0.1` (consistent). Properties confirmed via `noble`: `fa07` = `['read',
   'write']`, `fa09`/`fa0b` = `['read', 'notify']`.
3. **`docs/ble-captures/17_test_2SEPT.pklg`** (2 real planted pots, `A3:D3` and `A0:73`, DestCom
   triggered a real watering on each via the official app) — on `A3:D3`, right after the watering
   trigger write (`0x0089`, value `0a00`) at t=5951.457s:
   - `fa09` (handle `0x0041`) rose from a stable ~46.6% to a peak of ~69.6% over ~15s, then settled
     — the textbook shape of a soil-moisture response to watering.
   - `f907` (a separate watering-service characteristic, already known from the 2026-08-29 doc to
     be the tank-level drain indicator) dropped from `0x57` (87) to `0x4d` (77) in the same window
     — independent corroboration that water was actually dispensed.
   - `fa07` was never touched, again.
4. **Live read on `A3:D3` via `noble`** (before attempting any new watering trigger, to avoid
   over-watering a real plant): `fa05` (`soilMoistureRaw`) = `304` raw → `30.4%` if interpreted as
   percent×10 (the same fixed-point convention already used by the watering service's
   `vwcIrrRaw`/`vwcCmdRaw`, both raw uint16 percent×10 values elsewhere in this codebase) — a very
   plausible real reading. `fa0a` = `21.739°C`, also plausible. `fa07` = `0` (uint8, consistent
   with an LED-state register, most likely "off").

## Why the 2026-08-29 test was itself wrong

That session's controlled test warmed the probe by hand for 15-20s and watched `fa09` rise
23.00°C→25.02°C, concluding `fa09` = temperature. The most likely explanation now: `fa09` (moisture-
adjacent, confirmed reactive to watering above) also reacts to a hand physically touching/holding
the probe — capacitive/volumetric moisture sensors are highly sensitive to what's in contact with
them, and a hand touching the sensor is itself a very different dielectric environment than air.
Meanwhile `fa0a` (real temperature) likely has enough thermal mass/lag that a brief 15-20s hold
didn't move it much, reading as "flat" — a false negative from a stimulus that was too brief for a
proper thermal response, not evidence that `fa0a` isn't a real temperature sensor.

## Fix applied

- `backend/src/ble/parrot/uuids.ts`, `noble-bridge/src/uuids.ts`: dropped `soilMoisturePercent`
  (fa07) and `temperatureC` (fa09) as directly-read UUIDs; added `temperatureValue` (fa0a).
- `backend/src/providers/node-ble/index.ts` (`readSensors` + `subscribeLive`),
  `noble-bridge/src/parrot.ts`: `temperatureC` now reads fa0a directly (float32, same decode as
  before). `soilMoisturePercent` is derived from `soilMoistureRaw` (fa05, already read for the raw
  sensor debug log) as `raw / 10`, not read as its own float32 characteristic. `fa07` is no longer
  read anywhere as a sensor.
- `subscribeLive()`'s Live Mode crash (Round 4's "Operation is not supported" — `startNotifications()`
  called on `fa07`, which has no Notify property) is fixed as a side effect: `fa05` and `fa0a` both
  genuinely support Notify (confirmed in both captures and via `noble`'s reported characteristic
  properties), unlike `fa07`. The soil-notify decode was changed from `readFloatLESafe` (float32)
  to a plain `uint16LE / 10`, matching fa05's real encoding.
- `ParrotPotReading.soilMoisturePercent`/`temperatureC` stay `number | undefined` from Round 4 —
  no interface change needed, only the source UUIDs and one decode formula.

## Live-fire safety note

DestCom asked for the watering-trigger confirmation test to target only `87:33` (no plant). A
first attempt (before this was clarified) accidentally targeted `A3:D3` (real plant) and hung
mid-write with no confirmation either way — killed immediately on DestCom's correction. A
read-only follow-up found `algorithm_status=1` ("Ready", not "2=Watering"), suggesting no full
pump cycle completed, but this isn't fully certain. No further live triggers were run against
either real planted pot for the rest of this investigation; final confirmation (point 3 above)
reused DestCom's own already-completed watering from `17_test_2SEPT.pklg` instead of triggering a
new one.

## Verification

`cd backend && pnpm exec tsc --noEmit && pnpm test` (197/197), `cd frontend && pnpm typecheck`,
and `cd noble-bridge && pnpm exec tsc --noEmit` all clean. **Not yet deployed** — next deploy
should confirm real, plausible `soilMoisturePercent` values (not null) start appearing for all 3
real pots, and that a real Live Mode session no longer ends abnormally within seconds of starting.

## Deliberately not done this pass

- `fa09` (`UUID_LIVE_VMC_VALUE`) isn't stored anywhere now that it's freed from the wrong
  `temperatureC` slot — a plausible future addition to `RawSensorLog` given it's clearly
  moisture-reactive, but out of scope for this fix (no new migration needed for the actual bug).
- `fa07`'s LED-state role isn't read/logged either — genuinely not needed for anything this
  project does today.
- No historical `Reading` row correction/relabeling — same open question the 2026-08-29 doc
  already raised and deferred; the historical `soilMoisturePercent`/`temperatureC` columns for
  real Parrot Pots reflect the *previous* wrong mapping(s), not today's corrected one.
