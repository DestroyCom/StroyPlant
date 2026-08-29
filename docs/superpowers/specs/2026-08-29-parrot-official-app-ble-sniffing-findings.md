# Parrot official app BLE sniffing — findings (2026-08-29)

Real BLE captures of the official Flower Power app talking to 2 real Parrot Pots
(`A0:14:3D:CD:A3:D3` "Figuier Pleureur"/Ficus benjamina, and a second exposed-sensor unit with no
plant), using PacketLogger (macOS's Bluetooth HCI snoop tool) + `tshark` for analysis. Raw
captures in `docs/ble-captures/` (gitignored, not committed — working data, not a deliverable).
Full blow-by-blow reasoning (including 2 dead ends that were caught and corrected) lives in the
assistant's memory file for this investigation; this document is the settled conclusion for the
4 questions DestCom asked at the start of this investigation.

## 1. Why does the app water near-instantly, while StroyPlant takes seconds/minutes?

**Root cause: mostly architectural, not a faster BLE mechanism.**

- The official app's manual "ARROSAGE" button writes `0x000a` (uint16 LE) to `39e1f90c`
  (Write-only characteristic). StroyPlant's `triggerWatering()` writes `[0x08, 0x00]` to
  `39e1f906` instead — a **different characteristic with a different value**.
- `39e1f906` is declared **Read+Notify only** (no Write bit) on the real device, yet StroyPlant's
  writes to it have produced many real, confirmed-successful waterings in production — the
  firmware evidently accepts the write despite not declaring the property. Re-examining `f906`'s
  live notify stream during a real watering shows it behaving like a **tank-level indicator**
  (starts at 100, drains to ~90 over ~20s as water is dispensed) — consistent with its Read+Notify
  properties and with the code's own existing (but only-ever-read) `waterTankLevel` label for a
  neighboring characteristic. `f906` is very likely a status/level characteristic StroyPlant
  happens to also be able to write to, not a second official trigger path.
- **Update, 2026-08-30 — f90c switch attempted and reverted, real mystery found.** Confirmed 7+
  times via real sniffing (including 3 consecutive repeats and one dedicated verification capture)
  that the app's "ARROSAGE" button always writes exactly `[0x0a, 0x00]` to `f90c` and nothing else.
  The code was changed to use `f90c`/`[0x0a, 0x00]` and empirically tested on real hardware — but
  replaying the exact same write from a bare standalone script produced an ATT-level write
  acknowledgment with **no physical watering**, reproducibly, across every variant tried: via
  `node-ble`/BlueZ on the real production server, and via `@abandonware/noble`/CoreBluetooth on the
  Mac (matching the app's own stack) — the latter tested with the official app fully closed and
  StroyPlant's production container stopped, to rule out any connection contention. The write
  genuinely reaches the device (confirmed via a dedicated verification capture showing my script's
  connection/discovery/write sequence directly) but the pump never activates. **Change reverted —
  `trigger` stays `f906`/`[0x08, 0x00]`**, the mechanism already confirmed working in production for
  months, despite its own paradoxical GATT declaration (Read+Notify only, no Write bit). Leading
  hypothesis, unverified: the device may require an actual BLE bond/pairing or an app-specific
  authentication handshake before honoring a write to `f90c` specifically, as a safety measure
  against an arbitrary nearby BLE client remotely triggering a real watering. Not resolvable with
  the tooling available this session (no way found to inspect BLE bond state for a generic GATT
  peripheral on macOS). **Do not attempt this switch again without a real plan to test the
  bonding/authentication hypothesis specifically** — this cost 4 real watering-trigger attempts
  across 2 real pots for no resolved answer, and repeating the same trial-and-error will just cost
  more of the same.
- The BLE **write acknowledgment itself is near-instant** (~59ms, measured directly). The
  *physical* watering/moisture-settling process takes a comparable ~20-25s regardless of which
  characteristic triggers it. The most likely explanation for the perceived speed difference:
  **the official app shows success as soon as the BLE write is acknowledged**, while StroyPlant's
  explicit "never fire-and-forget" design (spec section 7.1) waits for a fuller confirmation
  before reporting success — a deliberate safety choice that costs perceived latency, not evidence
  that the pot itself responds slower to StroyPlant.
- **Not yet directly measured**: this is inferred from the app-side capture alone. A true
  side-by-side timing comparison would need instrumenting StroyPlant's own trigger path during a
  live capture, not done this session.
- **Update, DestCom-confirmed real timing**: the app's own watering trigger fires instantly;
  StroyPlant's equivalent button takes **1-2 minutes**. That gap is far too large to be explained
  by the ~20s physical watering process alone — the dominant cause is almost certainly that
  **StroyPlant never holds a persistent BLE connection open**. Every action (periodic poll, manual
  trigger) does a full fresh connect + GATT discovery + activation + write + disconnect cycle,
  serialized behind the single shared `connectionQueue` (one physical BLE adapter, shared with
  every other device's poll). The official app opens one connection when its pot page is opened
  and reuses it for every subsequent interaction — the connection cost is paid once, not per click.
  **Proposed direction (not yet planned or built)**: extend the existing Live Sensor Mode feature
  (`backend/src/liveSession/manager.ts`, live since 2026-07-29) so that while a live session is
  open for a device, the manual watering trigger (and future mode-switch actions) reuse that
  session's already-open connection instead of queuing a brand-new one via `connectionQueue`. This
  only speeds up manual actions taken while a user has the device's page open — the headless
  scheduled/auto-watering path is unaffected and doesn't need it. Needs its own proper plan
  (concurrency with the existing live-session/poll coordination, the 5-minute auto-cutoff, and the
  never-fire-and-forget guarantee all need to keep holding) — not started.

## 2. Is StroyPlant's calibration approach consistent with the official app's?

**There is no dedicated manual calibration button in the app at all** — checked directly in the
Settings screen for a real, already-calibrated pot (firmware, name, photos, plante, environnement,
"Oublier ce Pot" — nothing else). StroyPlant's own `plantDr.calibrateWet` (Batch 6, an explicit
user-triggered "capture wet point" action) has no equivalent in the official app's UI.

Instead, **calibration/threshold data is pushed automatically whenever a species is
(re-)assigned**, confirmed by capturing a real species change (Ficus benjamina → Echinocactus
grusonii) on a real pot: the write batch included both the `f900` watering-config thresholds
(`f903`/`f904`, matching the new species' exact values from the Parrot plant database) **and** a
batch of writes to the previously-never-seen Plant Dr `fd8x` block. One specific value,
`fd85=288`, appeared identically in both the "old" and "new" species write batches — this is the
exact `n_wet=288` figure already flagged as an unexplained anomaly during the Parrot plant-database
import (present on 8089/8090 imported species). This capture is the first real evidence connecting
that database anomaly to an actual protocol field: `fd85` (or a directly related Plant-Dr
characteristic) very likely holds that `n_wet` sample count, and it being identical across two very
different species' write batches confirms it really is a fixed/global constant, matching what the
import's own data already showed.

**Consequence for StroyPlant**: today, species assignment in StroyPlant only updates the
database (`PlantProfile` relation) — it never pushes anything to the device itself. The official
app's real behavior suggests species assignment should also configure the pot's own thresholds if
StroyPlant wants behavioral parity — see section 4 below, this is really the same root cause.

## 3. Is StroyPlant's sensor interpretation (values, units, mapping) correct?

**No — a real, confirmed bug: `soilMoisturePercent` and `temperatureC` are swapped.**

`backend/src/ble/parrot/uuids.ts` maps `soilMoisturePercent → 39e1fa09` and
`temperatureC → 39e1fa0a`. Both are wrong. This was confirmed with two independent, controlled,
real-hardware tests (not inference — see the memory file for a first attempt at "confirming via
production data" that turned out to be a coincidence, corrected before being trusted):

- **Live app-display cross-check**: reading the app's own live gauges at the exact moment of
  capture showed `fa07=49.3550` matching the app's displayed **49%** (humidité), and
  `fa09=22.9107` matching the app's displayed **23°C** (température) — both to within normal
  float/display rounding.
- **Controlled heat-stimulus test** (on the second, exposed-sensor pot, decisive): warming the
  probe by hand for ~15-20s made `fa09` rise from 23.00°C to a peak of 25.02°C, then settle back
  to 22.96°C after releasing — an exact rise-then-recovery matching the applied stimulus, while
  `fa0a` stayed completely flat and `fa07` stayed in its moisture-plausible 48-51% band.

**Correct mapping**: `fa07` = real soil moisture (VWC%), `fa09` = real temperature (°C). The
official PDF (`docs/PARROT_OFFICIAL_BLE_SPEC.md`) also states `fa09`=VWC/`fa0a`=temperature — so
either that transcribed document has the same error, or the real device's wiring genuinely differs
from what was documented there. Either way, the current code and the current spec doc **both** say
something the real hardware, tested twice with two different independent methods, contradicts.

`fa0a` is not luminosity either — it's demonstrably light-reactive (spiked from 0.1 to a peak of
4.70 the instant a flashlight was held over the sensor, then settled ~1.08) but is not what the
code calls `luminosity` (that's `fa0b`, untested this session — it never appeared in any live
notify stream captured, so its role is unconfirmed, not re-validated). The app's own "5046 live
lux" display does not match any raw value captured on the wire during that same moment (`fa0a`
peaked at 4.70, three-plus orders of magnitude away from 5046) — it's most likely computed
client-side from `fa0a` via an unidentified scaling formula, not read from a separate raw
characteristic. Not resolved this session.

**Real-world consequence, not yet acted on**: if this holds for the actual production Parrot Pots
(only verified against this session's 2 test units, not yet re-checked against
`A0:14:3D:CD:A3:D3`/`A0:14:3D:CD:A0:73` specifically in their real deployed state), every historical
`Reading` row for every real Parrot Pot has temperature stored under `soilMoisturePercent` and
vice versa. This affects the Health Engine's scoring, the auto-watering scheduler's trigger
condition, and any historical chart. **This needs a deliberate decision with DestCom** on: whether
to fix `uuids.ts` (swap `fa07`/`fa09`), whether historical `Reading` rows need any
correction/relabeling or should stay as an acknowledged-wrong record, and whether Health Engine
threshold comparisons need re-validation once real moisture data starts flowing from the correct
characteristic. Not fixed as part of this investigation — flagged for a separate, deliberate task.

## 4. How do the watering modes (Perfect Drop / Plant Sitter / Manuel / Custom) actually work?

All 4 modes write the same batch of fields in the `f900` "watering config" service; only a few
fields actually change per mode. Confirmed by diffing real captures of all 4 mode switches plus a
user-edited Custom save:

| Field | Role | Evidence |
|---|---|---|
| `f903` (`vwcIrr` in code) | Trigger threshold, `% × 10` | Matched the app's own displayed number exactly in 3/3 tests (32.0, 26.0, 30.0) |
| `f904` (`vwcCmd` in code) | Target/consigne, `% × 10` | Matched exactly in 3/3 tests (38.0, 32.0, 40.0) |
| `f905` (`nIrr` in code) | Likely the "délai d'arrosage" dry-delay, in **15-minute units** | `48 × 15min = 12h` exactly matched a user-set 12h delay; also plausibly explains the `0/384/672` "n_irr" values already flagged as an anomaly during the plant-DB import (384×15min=4 days, 672×15min=7 days — species-specific *delay presets*, not calibration sample counts as first assumed there) |
| `f908` (`pumpDutyCycle` in code, likely mislabeled) | Auto-algorithm enable flag (uint8) | `1` for Perfect Drop/Plant Sitter/Custom, `0` for Manuel — a duty-cycle percentage wouldn't plausibly stay pinned to exactly 0 or 1 |
| `f90e`/`f90f` (`timeSlotStart`/`timeSlotDurr` in code) | Allowed watering hours window | Constant (1440 / 0) across every mode tested — none of the 4 modes' UI exposed an hours-restriction control, consistent with these fields just holding "no restriction" defaults, not yet directly exercised |
| `f901`, `f902`, `f90a`/`b`/`c`/`d` | Unconfirmed | Vary without a clean formula found (`f901`), or stayed constant/zero in every capture (`f902`, and the `eco`/`mode` fields) — none of the 4 mode-switch screens exercised them |
| `f912` (`algorithmStatus` in code) | Unconfirmed, separate from `f908` | Never touched by any of these captures at all — the pre-existing "values 1-6 unconfirmed" open question from earlier project history is untouched by this investigation |

**This is the real architectural answer to "why doesn't StroyPlant behave like the app" as a
whole, beyond the specific bugs above**: StroyPlant's code already has UUID constants defined for
this entire `f900` service (`vwcIrr`, `vwcCmd`, `nIrr`, `pumpDutyCycle`, `mode`, `timeSlotStart`,
`algorithmStatus`, etc. — from the Parrot plant-database import work) but **only ever reads them**
(for the debug `RawSensorLog`), **never writes them**. The official app configures the pot to run
its own closed-loop watering algorithm autonomously on-device — this is how Plant Sitter achieves
"up to a month of autonomy" with no phone/app connection needed. StroyPlant, by contrast, never
programs the pot at all: it treats the Parrot Pot as a dumb sensor+pump, doing 100% of the
watering *decision* server-side (Health Engine + `scheduler.ts`) and firing one-shot triggers.
This is a legitimate, deliberate architectural choice (StroyPlant's own scheduler already exists
and works, and rewriting to depend on the pot's on-device algorithm would be a substantial design
change) — but it is the fundamental reason behavior diverges from the official app beyond the
specific bugs found above, and it means StroyPlant-managed devices have zero watering autonomy if
the backend or its BLE connection is ever down, unlike an official-app-configured pot.

## Summary of concrete action items (none acted on yet — for DestCom to prioritize)

1. ✅ **Done (2026-08-30)** — fixed the `fa07`/`fa09` sensor swap in `uuids.ts` (both backend and
   `noble-bridge`), plus a one-off migration script for historical `Reading`/`RawSensorLog` rows.
2. ❌ **Attempted and reverted (2026-08-30)** — switching `trigger` to `f90c` (matching the real
   app) was tried and empirically tested on real hardware, but the write has no physical effect
   when sent from our own code (see the Update under Finding 1 above for the full story). Reverted
   to `f906`, which works. Needs a real plan (likely investigating BLE bonding/authentication) before
   trying again — not another ad-hoc trial-and-error session.
3. Decide whether species assignment should push `fd8x`/`f903`/`f904` to the device (Finding 2),
   moving StroyPlant's calibration model closer to the official app's.
4. Decide whether StroyPlant should ever program the pot's own `f900` algorithm (Finding 4) for
   real device-side autonomy, or stay fully server-side-driven by design.
5. Correct the `PARROT_OFFICIAL_BLE_SPEC.md` transcription for `fa09`/`fa0a` if it's confirmed
   wrong rather than the hardware differing from the source PDF (not determined which is the case).
6. **DestCom-proposed direction for Finding 1**: reuse the existing Live Sensor Mode connection
   (`liveSession/manager.ts`) for the manual watering trigger (and future mode-switch UI) while a
   device's page is open, instead of queuing a fresh `connectionQueue` connect per action — matches
   the app's own "connect once when the page opens" pattern and should close most of the observed
   1-2 minute gap (vs. the app's instant response) for the manual-trigger case specifically. Needs
   its own plan (concurrency with the existing poll/live-session coordination, the 5-minute
   auto-cutoff, and the never-fire-and-forget guarantee all need to keep holding) — not started.
7. Minor/lower-priority open items: `fa0a`/`fa0b`'s true roles, the app's "5046 live lux" source,
   the exact identity of Plant-Dr handle `0x00a0`, why species-change wrote in two batches 30s
   apart, and `f901`/`f902`'s exact meaning.

## Addendum: real production device cross-check (`PARROT-A073`)

DestCom separately confirmed `A0:14:3D:CD:A0:73` ("Parrot pot a073" in the app) shows "Capteurs
d'humidité de la terre et du niveau d'eau opérationnels" / "Capteur de température opérationnel" /
"Capteur de luminosité opérationnel" — calibration is complete on this real production unit
(23% humidité, 24°C, luminosité 0 "live lux" in the dark, engrais "non disponible en mode live").
**No species is assigned to this device in the official app**, while StroyPlant's own database has
had Alcea rosea assigned to it since earlier project history — confirming the two clients keep
fully independent state for the same physical device today. Relevant if action item 3 above is
ever pursued: if StroyPlant starts pushing species-derived thresholds to the device too, a real
question arises about what happens if the official app and StroyPlant each assign a different
species to the same pot — not an issue today since only reads happen, but a design question worth
answering before making StroyPlant write to the device's calibration.
