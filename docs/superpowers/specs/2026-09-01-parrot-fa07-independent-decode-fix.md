# fa07 outage — independent per-field decode fix (2026-09-01)

## Symptom

Since 2026-08-30 22:42-22:45, all 3 real Parrot Pots (`A0:73` Pot blanc, `A3:D3` Pot brique,
`87:33` test pot) stopped producing any `Reading` row at all — 46h+ of zero data by the time this
was investigated. `fa07` (soil moisture, `soilMoisturePercent`) returns a truncated 1-byte GATT
buffer (`0x00`) instead of 4, on every connection, on all 3 devices. `fa09`/`fa0b`
(temperature/luminosity) read fine on the same cycle. `readSensors` decodes all 3 fields
tout-ou-rien (Round 3 fix, 2026-08-31, `docs/superpowers/specs/2026-08-31-...` — deliberately kept
non-optional at the time, see CLAUDE.md's "Deliberately not changed" note for that entry), so the
single malformed field crashed the whole read, and with it, all 3 fields and every other
best-effort field read further down in the same function (tank level, Plant Dr, raw sensor log).

## Investigation (this session)

- Ruled out: BlueZ GATT cache (no per-device bonding folder exists — connections aren't paired),
  `bluetoothd` restart or a `bluez` package update (uptime traced back to 2026-07-27, no
  `apt`-log entry), adapter power-cycle (already retried automatically dozens of times over 46h,
  no effect), a code deploy at that exact time (nearest merge was ~20h earlier).
- **Full host reboot** (`omv`) tried — reset the USB/HCI driver and `bluetoothd` from scratch.
  No effect: `fa07` returned the exact same 1-byte truncated buffer on the very first post-reboot
  poll cycle. This eliminates the entire server/BlueZ/kernel side as the cause.
- **Physical test — battery pull on pot `87:33`** (the test pot, no species assigned, safest to
  manipulate): DestCom removed and reinserted both batteries. Result: **did not fix it**. Not only
  did `fa07` stay at 1 byte, but `temperatureC`/`luminosity` came back as bit-for-bit identical
  values (`temp=00000000`, `lux=cdcccc3d`) across 3 separate connection cycles ~6-9s apart — not
  live samples that happen to be stable, but values that look frozen/default. This is a stronger,
  new symptom than what Round 3 documented for the other 2 pots (where `fa09`/`fa0b` read
  correctly-varying live values while only `fa07` was truncated).
- Conclusion: not a stuck/recoverable device state fixable by a power cycle. Root cause (firmware
  fault vs. a genuine hardware failure across all 5 units simultaneously vs. something else)
  remains unconfirmed — this fix does not resolve `fa07` itself, only its blast radius.

## Decision

Given 2 of the 3 affected pots hold real, actively-growing plants, and the only safety net for
them (the Batch 5 backend scheduler) had been completely blind for 46h+ (no fresh
`soilMoisturePercent` ever reaching the DB to evaluate against), DestCom chose to apply the
best-effort independent-decode fix immediately rather than wait for the root cause to be found —
see chat log, 2026-09-01.

## Fix

`ParrotPotReading.soilMoisturePercent`/`temperatureC`/`luminosity` (`backend/src/providers/types.ts`)
widened to `number | undefined` — reversing Round 3's explicit "keep non-optional" call now that
real production impact (not just a hypothetical) makes the tradeoff worth it. `readSensors`
(`backend/src/providers/node-ble/index.ts`) now decodes each of the 3 fields via the same
`readRawBestEffort` helper already used for every other best-effort sensor on this function — a
malformed buffer on one field is logged individually and becomes `undefined`, the other two (and
the rest of the read: tank level, Plant Dr, raw sensor log) proceed normally and the `Reading` row
is persisted with whatever succeeded.

**Ripple check performed before widening the type** (this is exactly what Round 3's note warned
about): `Reading.soilMoisturePercent`/`temperatureC`/`luminosity` were already nullable at the
Prisma schema level (`Float?`), and `health/scoring.ts` already filters `value != null` everywhere
(it has to — Xiaomi devices and `isInAir` readings already produce gaps in these same columns).
The only real compile break was `plantDr.ts`'s `calibrateWet`, which read live
`soilMoisturePercent` assuming it was always a number — fixed with an explicit
"sensor unreadable, try again later" guard, matching the existing pattern right above it for a
missing species threshold. MQTT discovery's `value_template`s reference these fields by name only
(Home Assistant renders "Unknown" for a null, no crash). No other consumer assumes non-null.

**Deliberately not attempted in this pass**: no fix for `fa07` itself (root cause still
unconfirmed — see Investigation above), no change to the Health Engine's warm-up/staleness
handling (a device that goes quiet on `soilMoisturePercent` specifically now behaves exactly like
any other device with a real data gap on that one parameter, which the engine already tolerates).

## Verification

`cd backend && pnpm exec tsc --noEmit && pnpm test` (197/197) and
`cd frontend && pnpm typecheck` both clean. **Not yet verified against real hardware post-deploy**
— next deploy should confirm `Reading` rows resume for temperature/luminosity/tank level on all 3
real pots even while `soilMoisturePercent` stays null, and that the per-field failure log
(`Soil moisture (fa07) indisponible`) replaces the previous whole-cycle `CONNECT` failure.
