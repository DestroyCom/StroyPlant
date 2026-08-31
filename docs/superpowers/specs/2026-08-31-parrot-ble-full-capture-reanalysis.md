# Parrot BLE full capture re-analysis (2026-08-31)

**RESOLVED, same day, later** — the `f900` persistence mystery this document investigates (section
1 below) turned out to have a precise, confirmed answer: `f901` (CONFIG_ID) is an XOR-16 checksum
over the other 12 watering-service characteristics, already documented (and missed) in this
project's own `docs/PARROT_BLE_DEEP_DIVE.md`, independently rediscovered by 3 parallel AI research
passes (reports in `docs/debug_analyse/31082026_WOrkingLikeTheRealApp/`), and confirmed live on
real hardware. Full resolution: `[[project_autonomous_watering_f903_f904_revert]]`. Section 1's own
hypotheses (dwell time, response corruption) are superseded by this — kept below for the accurate
historical record of what this specific pass found, not as still-open questions.

Full, deliberately exhaustive byte-level re-analysis of every `.pklg` PacketLogger capture in
`docs/ble-captures/` (17 files, gitignored working data), done specifically to look for anything
the prior investigation rounds (`2026-08-29-parrot-official-app-ble-sniffing-findings.md` and the
`feature/parrot-device-side-autonomous-watering` branch's "7 failed hypotheses" session, see
`[[project_autonomous_watering_f903_f904_revert]]`) missed. Method: `tshark -r <file> -T fields
...` extraction of every ATT-layer packet (opcode/handle/value/UUID) across the whole file,
cross-referenced against `-V` full verbose decodes for anything ambiguous — not PacketLogger's own
decoded view, which the prior investigation already found unreliable once (the `f906`/`f90c`
handle mixup). No new hardware access was used or needed — this is a re-read of already-captured
traffic.

**Headline result: the central "does `f900` persist" mystery is very likely NOT what it looked
like.** Two independent, previously-unexamined pieces of wire-level evidence point the same
direction — see sections 1 and 2.

## 0. Capture inventory correction (methodology note)

The 17 files are **not** a clean cumulative history despite every one of them reporting the same
"earliest packet: 2026-08-28 12:27:55" in `capinfos` — that shared timestamp is an artifact of
macOS PacketLogger's rolling capture buffer (a fixed-size ring buffer that discards its oldest
packets as new ones arrive; every "Save As" snapshot inherits the buffer's structural start
reference even though its actual content only spans whatever's currently in the ring). Confirmed
empirically: `00_baseline_connect.pklg`'s own connection-complete event (frame 218, epoch
`1788036594`) **does not appear at all** in `15_full_sniff_30_aout_soir.pklg`, despite both files
claiming the same earliest-packet timestamp. Each file is really an **independent, non-overlapping
snapshot** of whatever real GATT traffic happened to be in the buffer at save time. Practical
consequence: don't assume a later, bigger file is a superset of an earlier, smaller one — each of
the 17 files needed opening separately. The two files copied to the home directory
(`~/30.08.2026 *.pklg`) are confirmed byte-identical in content to their `docs/ble-captures/`
counterparts, just re-encoded with a different endianness in the PacketLogger record header — no
new data there, safely ignorable.

Real GATT session activity (as opposed to passive advertisement noise from surrounding devices) is
concentrated in exactly 3 distinct time windows across all 17 files:
- **Aug 29, ~22:27–22:29** (`13_full_flowerpower_app_workout.pklg`, self-contained, 2638 packets)
- **Aug 29, ~23:54–00:02** (`12_log_claude_...pklg`, `11_my_script_attempt.pklg`, overlapping)
- **Aug 30, ~23:19–23:23** (`13_sniff_during_test_script.pklg`'s own unique window — despite the
  similar filename to the item above, this is a **separate, later session**)
- **Aug 30, ~23:34–23:56** (`15_full_sniff_30_aout_soir.pklg`, 19791 packets, by far the densest)

Files `00`–`10` are earlier snapshots already covered in detail by the prior investigation
(mode-switch field mapping, `f906`/`f90c` correction, `fa07`/`fa09` swap) — re-scanned here only
for the specific new things listed below (ATT errors, `f912`/`f913` activity), nothing new found
in them beyond what's already documented.

## 1. `f900` writes: a full write→disconnect→reconnect→read chain that persisted 4 times in a row

Inside `15_full_sniff_30_aout_soir.pklg`, pot `A0:14:3D:CD:CD:87:33` ("8733", the dedicated
no-species-assigned test pot) went through 4 independent write sessions using the **exact 13-field
batch order already on record as tested-and-failed** (`f902,f903,f904,f905,f90a,f90b,f90c,f90e,
f90f,f910,f911,f90d,f901`, per `[[project_autonomous_watering_f903_f904_revert]]`'s "Update
2026-08-30, later" entry). Every single one of the 4 write→reconnect→read cycles shows the
**freshly-written value read back correctly** in a brand new connection, not the pre-write
baseline:

| # | Write session (chandle) | `f903`/`f904` written | Verified in (chandle, gap) | `f903`/`f904` read back |
|---|---|---|---|---|
| 1 | `0x0053`, t=133482.5 | `0140`/`017c` = 32.0%/38.0% | `0x0047`, +4m17s | `4001`/`7c01` = 32.0%/38.0% ✓ |
| 2 | `0x0047`, t=133790.6 | `017c`/`01b8` = 38.0%/44.0% | `0x0057`, +3m14s | `7c01`/`b801` = 38.0%/44.0% ✓ |
| 3 | `0x0057`, t=134005.0 | `0140`/`017c` = 32.0%/38.0% | `0x0059`, +21s | `4001`/`7c01` = 32.0%/38.0% ✓ |
| 4 | `0x0048`, t=134442.2 | `0104`/`0140` = 26.0%/32.0% | `0x004c`, +28s | `0401`/`4001` = 26.0%/32.0% ✓ |

(Frame numbers for row 4, the most-checked one: write at 17954/17956, read-back-in-new-connection
at 19628/19630 and 19631/19633; full verbose decode of frames 9864–9869 confirms row 1's
verification read is clean — correct L2CAP length, single unambiguous
`[Request in Frame: N]` linkage, no corruption markers.)

Each reconnect shows the **most recently written** value, never a fixed baseline, never a
different device's value, across 4 chained tests spanning ~13 minutes — this rules out
coincidence (a device that "always reverts to some fixed default" could never produce 4 different,
sequentially-tracking values). A completely separate, much earlier capture
(`13_full_flowerpower_app_workout.pklg`, Aug 29) independently shows the same pot's `f903`/`f904`
having moved from a very early `af00`/`e100` (17.5%/22.5% — the Plant-Dr factory calibration
pair, not even the watering-config factory pair) to `0140`/`017c` (32.0%/38.0%) by the end of that
session, and `15_full_sniff`'s very first read the next day (frame 425/428, session start) shows
`017c`/`01b8` (38.0%/44.0%) — i.e. the value kept evolving and holding across a full day and
multiple real reconnects/power-cycles-worth-of-time, not just within one test run.

**This directly contradicts the documented conclusion that this exact batch/order "failed" (test
#4 in the 7-hypotheses list).** Two explanations are consistent with the evidence and are not
mutually exclusive:

1. The verification read used to originally conclude "reverted" may itself have been corrupted —
   see section 2, a real, wire-confirmed response-corruption bug exists and was caught red-handed
   in the middle of one of this file's own 8733 sessions.
2. Something about *this* round of testing (dwell time before disconnect was 54–100s across these
   4 sessions, vs the 20s explicitly tested-and-"disproven" in the documented round) differs from
   whatever produced the original "revert" conclusion. Session #31 (row 4) held the connection open
   for ~80s after its final write before disconnecting, streaming live notifications the whole
   time — notably, it never sent the `fa06=0` "deactivate" write the real app always sends before
   disconnecting (frame range 16854–19086 has no such write), yet still persisted — so a clean
   app-style shutdown is **not** the missing ingredient either.

**This does not yet prove the mystery is fully closed** — it wasn't reproduced live with fresh
hardware this session, only found by re-reading old traffic more carefully. But it means the
working assumption going into any future test should flip: **assume full-batch writes in this
order persist, and go looking for what's different about the cases that don't**, rather than the
reverse.

## 2. A real, wire-confirmed BLE response-corruption bug exists on this hardware

Scanning `15_full_sniff_30_aout_soir.pklg` for tshark's own `_ws.expert` decode-anomaly markers
(not a guess — actual dissector-flagged inconsistencies) turns up exactly 2 instances of genuine
corruption out of 11665 ATT packets in that file (~0.017%, rare but real):

- **Frame 7586** (chandle `0x0040`, one of pot 8733's test sessions, t=133670.437): a Read
  Response for the Battery Level characteristic decodes as **"Battery Level: 160%"** — physically
  impossible (max 100%), flagged by tshark itself as `[Expert Info: Bad Data]`.
- **The very same burst** (frames 7589/7590/7592, all within 60ms of the impossible battery read):
  **two different Read Responses, both claiming `[Request in Frame: 7589]`**, i.e. two separate
  ATT PDUs answering the *same* single Read Request — frame 7590 says `Value: 5f` (1 byte), frame
  7592 says `Value: 00` (1 byte), for what should be the 2-byte `f903` characteristic. Both are
  genuinely 1-byte-short PDUs at the wire level (L2CAP `Length: 2`, not the expected `Length: 3`
  for a 2-byte value) — not a dissector misparse, a real truncated/duplicated packet.
- **A second, independent occurrence of the same impossible-battery-level pattern** at **frame
  16950** (chandle `0x0045`, t=134401.764) — this one is inside one of the **real official app's**
  own sessions (pot A3D3), not a test-script session. This rules out "our tooling/library has a
  bug" as the sole explanation — the corruption happens on traffic the official app itself
  generates too, so it's a property of the BLE link/radio/this TI chip's stack under load, not of
  any particular client.

Practical read: any *single* verification read taken right after a write, with no retry, has a
small but real chance of coming back truncated/garbled — and a garbled 1-byte "5f" or "00" where
32.0% (`0x0140`) was expected is exactly the kind of result a human (or a script with no
length-sanity-check) would log as "reverted", when it's actually neither the old nor the new
value, just noise. This is the same general class of bug already found and left unfixed on
`main` in `[[project_a073_sensor_read_crash]]` (a truncated `fa07` buffer crashing `readSensors()`)
— this session's finding generalizes it: it's not soil-moisture-specific, it can hit *any*
characteristic read, on multiple pots, under both our own tooling and the official app.

**Recommendation for the next live retest**: read back at least twice (or retry any response whose
byte length doesn't match the characteristic's known width) before concluding a write didn't
persist.

## 3. `f908`'s only-ever-attempted write got a hard ATT error, not a silent revert

`13_sniff_during_test_script.pklg` (Aug 30, ~23:19–23:23 — a separate, earlier, much shorter
session than `15_full_sniff`, almost certainly part of the documented single-field hypothesis
round) contains the *only* `f908` write attempt found anywhere across all 17 files. Full sequence,
chandle `0x005a`:

- Frame 7145/7147: Read Request/Response on handle `0x008e` (`f908`) → `01`.
- Frame 7148: Write Request, value `00`.
- **Frame 7150: `Error Response`, `Request Opcode in Error: Write Request (0x12)`, `Handle in
  Error: 0x008e`, `Error Code: Invalid PDU (0x04)`.**
- Frame 7151/7153: immediate re-read → still `01` (consistent with the write never landing, but
  this time for an *explicit, protocol-level reason*, not silently).

`Invalid PDU` (ATT error 0x04) means the device rejected the PDU's *framing*, not its value — this
is a different, more specific signal than "wrote fine, value didn't stick" as currently documented
in `[[project_autonomous_watering_f903_f904_revert]]`. Whether this was logged/surfaced correctly
by whatever tool ran this test originally isn't something a packet capture can answer, but the
wire evidence is unambiguous. Scanned all 17 files for any *other* real ATT error (excluding the
benign "end of GATT discovery" `0x0a`/Attribute-Not-Found terminator, which is normal and appears
6× across the corpus) — this is the only one that exists.

**Separately in the same file**, `f90d`'s isolated write (chandle `0x005e`, frame 8123, value
`00`) *did* get a clean `Write Response` (frame 8125) but the immediate same-connection re-read
(frame 8128) still shows `01` — this one really is a clean-ack-silent-no-op, exactly as documented.
So the two "failed" single-field tests actually failed in **two different ways** — `f908` was
rejected outright, `f90d` was accepted-and-ignored — worth keeping distinct in any future writeup
rather than lumping both under "reverted."

## 4. `f913`: a 13th `f900`-service characteristic that has never once been read or written

GATT discovery (`Read By Type Request/Response` for `0x2803` declarations) in every full-discovery
session across every file consistently enumerates a characteristic at handle `0x009b`/`0x009c`,
UUID `39e1f913`, sitting immediately after `f912` (`ALGORITHM_STATUS`) and before the Plant-Dr
block starts. It is declared in every single discovery pass (confirmed across `15_full_sniff`,
`13_sniff_during_test_script`, and `13_full_flowerpower_app_workout` — at least 20 separate
discovery passes) but **no Read Request, Write Request, or Notification targeting it appears
anywhere in any of the 17 files** — not from the official app, not from any test script. Not in
`docs/PARROT_OFFICIAL_BLE_SPEC.md`, `docs/PARROT_BLE_REVERSE_ENGINEERING.md`, or
`docs/PARROT_BLE_DEEP_DIVE.md` either (not grepped exhaustively this session, but not previously
flagged in any existing doc). Completely unexplored — properties bitmap wasn't decoded this pass
either (would need one more `-V` dump of its `0x2803` declaration entry).

## 5. `f912` (`ALGORITHM_STATUS`)'s apparent variable length is very likely a corruption artifact, not real

Section 2's corruption bug caused an initial hypothesis that `f912` might genuinely return
1/2/4-byte payloads depending on device state (real values glimpsed: `01`, `04`, `05`, `00`
one-byte; `b124` two-byte; `00000000`/`35a6946a` four-byte). **Checked and revised**: scanned
`f912` read lengths across every other file in the corpus (`00_baseline_connect`,
`12_log_claude_...`, `13_full_flowerpower_app_workout`) — **every single read in every other file
is exactly 1 byte**, no exceptions. The multi-byte reads only appear inside
`15_full_sniff_30_aout_soir.pklg`'s own densest window, the same file where the confirmed
corruption in section 2 lives. Most likely explanation: these are more instances of the same
response-misattribution/truncation bug, not a real variable-length characteristic. Downgrading
this from "new characteristic behavior" to "another symptom of section 2's bug" — flagged here so
a future session doesn't waste time trying to decode `35a6946a` as if it were meaningful device
state.

The confirmed-clean 1-byte values (`00`, `01`, `04`, `05`) are still real and worth keeping: they
fall inside the "1-6" range `CLAUDE.md` already flags as unconfirmed `ALGORITHM_STATUS` values —
**and now have named meanings, via web research this session** (see the Internet research section
below): a third-party project (`antoineraulin/homebridge-parrot-flower`) documents `f912` as
`0=Initializing, 1=Ready, 2=Watering, 3=Error: No water, 4=Error: In Air, 5=Error: VWC Still,
6=Error: Internal`. This **revises** `[[project_parrot_algorithm_status_enabled]]`'s tentative read
of a real `algorithm_status=1` as "likely just firmware idle default" — per this independent
source, `1` means **"Ready"**, i.e. armed and waiting to water, not idle/disabled. Worth
re-flagging to DestCom given the safety implications for the autonomous-watering work: `4/5` (both
saw as `04`/`05` in this capture's clean 1-byte reads) would be **In Air** / **VWC Still** error
states, not just arbitrary numbers.

## 6. Advertisement manufacturer-data byte — SOLVED, confirmed against real trigger data

`[[project_parrot_advertisement_correlation]]` has been an open, physical-access-blocked item for
a while — **now resolved**, combining a real trigger event already in the captures with a
community-sourced decode found via web research this session (see the Internet research section
below): `antoineraulin/homebridge-parrot-flower`'s `Pot.js#getDeviceStatus()` decodes the 3-byte
Parrot (`0x0043`) manufacturer payload as `[dataVersion][type<<4|color][statusFlags]`, with
`statusFlags` = `UNREAD_ENTRIES=0x01, DEVICE_MOVED=0x02, DEVICE_STARTED=0x04,
DEVICE_LOW_WATER=0x08, DEVICE_LOW_BATTERY=0x10, DEVICE_WATERING_NEEDED=0x20`.

Re-decoded every advertisement byte captured in `15_full_sniff_30_aout_soir.pklg`, grouped per
source device address (an earlier same-session pass conflated all 3 pots' advertisements together
and produced a misleading picture — corrected before trusting this), against this bitmap. It
fits perfectly, with a physically sensible story for all 3 devices:

- **a073** (real trigger, `f906` write at t=133371, ~296s connection): `0x21` =
  `UNREAD_ENTRIES + DEVICE_WATERING_NEEDED` before the trigger (t≤133356) → `0x20` = just
  `DEVICE_WATERING_NEEDED` right after the connection carrying the trigger ends (t=133662) —
  `UNREAD_ENTRIES` cleared *during* the connection, consistent with the connected client reading
  the device's log → `0x00` = both clear by t=133956 (~6 min after the trigger) —
  `DEVICE_WATERING_NEEDED` takes longer to clear than `UNREAD_ENTRIES`, exactly as expected if it's
  tied to the soil-moisture sensor actually detecting the rise after real water has time to soak
  in, not an instant flag flip.
- **a3d3** (no trigger, no species change, just an app mode-switch/live-view session): `0x01` =
  `UNREAD_ENTRIES` only, pre-session (t≤133350) → `0x00` right after the session ends (t=133662+).
  No `DEVICE_WATERING_NEEDED` bit ever — consistent with a3d3 (a real, actively-maintained plant)
  simply not being dry at the time.
- **8733** (the dedicated no-species-assigned test pot, secondhand-acquired per `CLAUDE.md`'s
  2026-08-29 entry, multiple config-write test sessions but never triggered in this file): `0x23` =
  `UNREAD_ENTRIES + DEVICE_MOVED + DEVICE_WATERING_NEEDED`, constant across *every* sample from
  t=133290 through t=134022 (spanning many reconnects/writes) → `0x20` = `DEVICE_WATERING_NEEDED`
  only, from t=134099 onward — `DEVICE_MOVED` and `UNREAD_ENTRIES` both clear together (matches a
  secondhand pot's "moved" flag finally settling once it's been connected to enough), while
  `DEVICE_WATERING_NEEDED` stays set for the *entire* capture, never clearing — exactly what you'd
  expect from a pot that genuinely never got watered in this window.

Every transition matches the bitmap's semantics with no exceptions across all 3 devices — this is
about as clean a confirmation as packet analysis alone can give without live hardware in hand.
**Practical payoff**: `DEVICE_WATERING_NEEDED` (bit `0x20`) is a real, passively-observable,
zero-BLE-connection-cost signal for "this pot's soil is dry" straight from the advertisement,
independent of and complementary to StroyPlant's own Health-Engine-based moisture reading — worth
considering as a cheap cross-check or even a fallback signal for devices that are hard to connect
to. `DEVICE_LOW_WATER` (`0x08`) and `DEVICE_LOW_BATTERY` (`0x10`) use the same mechanism and were
never observed set in this capture (both real pots apparently had full reservoirs/batteries at the
time) but should decode the same way. Also found:
`12_log_claude_script_tries_and_3_water_trigger_From_parrotflowerpower.pklg` actually contains
**4** rapid manual watering triggers on pot 8733 (12 seconds apart, frames 3247/3395/3548/3739,
t=132831–132868), one more than the filename's "3" — the file's capture window ends before the
connection closes, so no post-trigger advertisement data was available from this particular
event.

## 7. Confirmed: zero SMP traffic, zero genuine ATT errors on watering-relevant handles

Re-confirmed across the full corpus, not just the previously-checked files: **zero** `btsmp`
frames anywhere (protocol hierarchy stats show `bthci_acl → btl2cap → btatt` directly, no security
manager layer at all, in every file) — no pairing/bonding involved anywhere, ever, on any pot. And
beyond the two errors already covered in sections 2/3, **no other ATT Error Response exists on any
`f9xx`/`fd8x`/`fa0x` handle in any file** — every other write in the entire corpus that received a
`0x13 Write Response` genuinely got one cleanly.

## 8. The real official app's exact connection signature (useful for future replication)

Every one of the 8 real app-driven sessions found across the corpus (a3d3/a073, never 8733 for
this behavior) follows an identical script, useful if a future test wants to mimic the app more
closely than a generic "discover everything" library default does:

1. Enable notifications (`0x2902` = `0x0001`) on ~8 characteristics in a fixed order: battery
   (`0x000f`), then `0x008c`, `0x00ab`, `0x00ae`, `0x00b1`, `0x0042`, `0x0045`, `0x0048` (live
   sensor value CCCDs).
2. Write `01` to `fa06` (`0x003d`) — activate live measurement.
3. Enable 2 more CCCDs (`0x005f`, `0x0062`).
4. Write a 4-byte value to `fc03` (handle `0x0053`) that looks like a little-endian timestamp or
   counter (e.g. `09180000`, `4d180000`, `e98ea454` seen across different sessions — genuinely
   different each time, consistent with a real clock/counter, not a fixed constant).
5. Write `01` then, ~0.5s later, `02` to `fb03` (handle `0x0064`) — a 2-step handshake/mode-select
   of some kind, role still unconfirmed.
6. *(Only when actually triggering)* write `0a00` to `f906` (`0x0089`).
7. *(Only when actually changing watering config)* the already-documented `f900`-service batch.
8. Hold the connection open, streaming live notifications, for tens of seconds to several minutes
   before finally writing `fa06=00` and disconnecting.

`fc03` and `fb03`'s exact roles remain unconfirmed — flagged here since they've never been called
out before in any prior investigation doc and might matter for whatever's actually gating `f900`
persistence (e.g. if `fc03`'s "timestamp" write is itself a required pre-condition the failed
test-script attempts never sent).

## 9. Internet research findings (parallel to the packet re-analysis)

A background research pass (WebSearch/WebFetch, not packet analysis) was run in parallel,
specifically hunting for prior third-party reverse-engineering of this exact device. Full prompt
used is preserved in `docs/superpowers/specs/2026-08-31-parrot-ble-ai-research-prompt.md` (also
handed to DestCom to run through other AI assistants for a second independent pass). Headline:
**StroyPlant is likely the first project to attempt writing to the undocumented `f9xx` fields at
all** — every third-party project found only reads `f907`/`f90d`/`f912` and writes the `f906`
trigger, never touches dry/wet-threshold or algorithm config over BLE.

- **`emericg/WatchFlower`'s own Parrot Pot doc**
  (`docs/parrotpot-ble-api.md` in that repo — not `ropot-ble-api.md`, a naming false-friend for an
  unrelated Xiaomi device) gives a field-by-field table for the `39e1f9xx` "Watering service":
  `f906`=trigger, `f907`=tank level %, `f90d`=watering mode, `f912`=watering status — everything
  else (`f901,f902,f90a,f90b,f90c,f90e,f90f,f910,f911,f913`) is marked unresolved even there, the
  most complete public source found. Confirms nobody else has cracked these fields either.
- **`antoineraulin/homebridge-parrot-flower`** (fork of `grover/homebridge-flower-sensor`, the
  earliest known Pot-specific project, and WatchFlower's own cited source) — pulled its raw
  source, not a summary:
  - `WaterPlantTask.js` writes `uint16LE(0x08)` (bytes `08 00`) to `f906` — **exactly matches**
    StroyPlant's current code, independently corroborating the already-settled "f906 was correct
    all along" resolution.
  - `RetrieveWateringStatusTask.js` gives the `f912` state table used in section 5 above, and
    confirms `f90d` (Watering mode) is `0=Manual, 1=Auto, 2=Vacation` — a 3-state mode selector,
    not a plain boolean enable flag as `CLAUDE.md`'s current `mode` field comment might imply.
  - `Pot.js#getDeviceStatus()` gives the advertisement-byte decode used in section 6 above.
  - `Pot.js` has commented-out (known-UUID, unimplemented-in-that-project) fields worth checking
    against StroyPlant's own `fd8x` map: **`fd87`=Next Empty Tank Date, `fd88`=Next Watering Date,
    `fd89`=Full Tank Autonomy Duration** — i.e. this source claims these are *predictive dates*,
    not raw calibration/status bytes. Not cross-checked against our own captures this session
    (worth a follow-up: `fd87`/`fd88`/`fd89` were read in `15_full_sniff`'s session #31 as 4-byte
    `00000000` values — plausibly an "unset" date given 8733 has no species/schedule).
  - `RetrieveFlowerPowerCalibratedDataTask.js` matches our current `fa02`(soil EC)/`fa09`(VWC,
    labeled "temperature" in this file's older terminology but confirmed elsewhere as
    moisture)/`fa0a`(air temp)/`fa0b`(light) understanding exactly, and gives the soil-temp
    calibration polynomial for raw `fa03`: `0.00000003044·x³ − 0.00008038·x² + 0.1149·x − 30.45`.
- **Official `github.com/Parrot-Developers` org** (~140 repos, enumerated in full): only 3 touch
  Flower Power/Pot at all (`node-flower-power`, `FlowerPower-Tools`, `node-flower-bridge`), none
  Pot-specific, none publishing a `f9xx` field spec. No official Parrot Pot BLE spec exists
  publicly — only the original Flower Power spec PDF (below), which predates the Pot.
- **Official Flower Power BLE spec PDF**
  (`developer.parrot.com/docs/FlowerPower/FlowerPower-BLE.pdf`, fetched and read in full this
  session) — for the original spike sensor, not the Pot, but shares the same `fa0x`/`fd0x`/`fe0x`
  base UUIDs. Confirms `fa09`=VWC, `fa0a`=air temp, `fa0b`=DLI (all float32), independently
  corroborating the already-settled `fa07`/`fa09` swap fix. **Resolves the "confirmed-dead"
  `fa0c`/`fa0d`/`fa0e` characteristics** flagged in `CLAUDE.md`: they're `fa0c`=calibrated Ea,
  `fa0d`=calibrated Ecb, `fa0e`=calibrated Ec porous — three different derived-conductivity
  outputs (apparent/bulk/pore-water EC, standard soil-science models), all float32. Plausible
  explanation for why they read dead on the Pot specifically: the Pot's firmware may simply never
  populate this particular triple, relying on the single raw `fa02` instead, rather than a
  read/hardware fault. Also confirms the `fd8x` "Plant Dr" service is a genuinely Pot-specific
  addition, absent from the original Flower Power spec entirely. Incidentally, the spec's own
  pseudocode literally labels the device **"Hawaii device"** (page 20) — confirms "Hawaii" was
  Parrot's real internal codename for this product line, consistent with the "hawaii2"/
  "kauai-protoA" strings read off real hardware (Batch 6 history) — no further detail on those
  exact codenames found anywhere else public.
- **TI CC254x/CC2640 OAD + cross-vendor NV-flash/BLE-stack timing** — no CC254x-specific erratum
  found describing this exact symptom, but a well-evidenced, cross-vendor pattern on
  structurally-similar single-radio-core BLE SoCs (STM32WB, Nordic nRF52, ESP32, PSoC 4): a flash/
  NV write **blocks the BLE stack's radio servicing** for its duration (~22ms for a sector erase,
  documented on STM32WB), and on some stacks the ATT-level Write Response can be sent
  **before the actual flash commit is confirmed** (optimistic transport-layer ack). Separately,
  Apple's own BLE engineering guidance states write-with-response needs **at least 2 connection
  intervals** to fully complete, and that firing writes back-to-back without awaiting each
  callback "may silently fail with no way for the app to detect it" — general BLE protocol
  behavior, not iOS-specific. This is a real, if not device-specific, candidate explanation
  alongside section 2's corruption-read hypothesis for why some `f900` write rounds looked like
  reverts — not proven for this exact chip, but concrete enough to justify testing a **~100-200ms
  dwell between each individual field write** (not just before the final disconnect) in the next
  live retest, which none of the 7 originally-documented hypotheses tried.
- **Parrot's own patent**, confirmed genuine: **US20160174478A1**, "Autonomous irrigation device,
  in particular for pot plants", Parrot Drones SAS (Google Patents) — mechanical/architecture
  level (substrate-electrode humidity detection, all-or-nothing valve control, BLE remote
  programming from a phone), not useful for field-level protocol detail, but confirms this is a
  real patented Parrot mechanism.

## Not done this session / explicit follow-ups

- No new hardware access was used — everything above is a re-read of existing captures. The
  section 1 finding needs a **live retest** (fresh capture, same 13-field batch, deliberately
  short dwell + a *retried* verification read) before it can be called fully resolved rather than
  "best current read of old evidence."
- `f913`'s declared properties (readable? writable? notifiable?) weren't decoded — one more `-V`
  dump of its declaration entry would settle it. WatchFlower's own doc (section 9) marks it
  `read/notify`, unconfirmed against our own captures.
- Section 6's advertisement byte is now considered solved (see section 9's corroboration), but the
  fully-isolated single-trigger test described there would still be the cleanest possible proof.
- Did not re-derive the `fc03`/`fb03` roles beyond noting their existence and rough shape — no
  external source found either (section 9).
- `antoineraulin/homebridge-parrot-flower`'s claim that `fd87`/`fd88`/`fd89` are predictive dates
  (next-empty-tank, next-watering, full-tank-autonomy) rather than raw calibration fields was not
  cross-checked against our own `fd8x` captures this session — worth a follow-up read.
- The companion prompt handed to other AI assistants for a second independent web-research pass is
  at `docs/superpowers/specs/2026-08-31-parrot-ble-ai-research-prompt.md`.
