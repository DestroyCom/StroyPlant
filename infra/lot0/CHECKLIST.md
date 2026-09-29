# Batch 0 — Docker + Bluetooth validation checklist on the production server

> Initial context: the TP-Link UB500 Plus dongle had not arrived yet. While checking
> the production server, we discovered an already functional **integrated** Bluetooth adapter (Intel
> Wireless-AC 3168, Bluetooth 4.2, internal USB) — decision made with DestCom (2026-07-27)
> to validate Batch 0 with this adapter right away, the TP-Link will come as a
> replacement/complement once it arrives (revalidation required, different chipset —
> Realtek RTL8761B vs Intel, see note at the end of the file).

## Status: Batch 0 validated (2026-07-27)

Executed via a direct SSH connection to the real production server, full results below.

### Step A — host

- Native Docker Engine confirmed: version 29.6.1, Debian 12 (bookworm), `cgroupfs` cgroup driver
- **BlueZ was not installed by default** (a NAS-oriented distro, no base
  desktop/Bluetooth packages) → installed manually by DestCom (`apt-get install -y bluez`
  + `systemctl enable --now bluetooth`)
- Once installed: `bluetooth.service` active, `bluetoothctl: 5.66`
- System D-Bus socket present at the expected location
- Adapter detected on the host: `hci0`, Intel Corp. Wireless-AC 3168, `UP RUNNING`,
  BD Address `10:F0:05:0F:40:4B`, HCI Version 4.2

### Step B — Bluetooth access from a Docker container

Tested with the **fine-grained capabilities** config (not `privileged: true`):
`cap_add: NET_ADMIN, NET_RAW` + `network_mode: host` + mounting
`/var/run/dbus/system_bus_socket`.

- `dbus-send --system --dest=org.bluez / ... Introspect` → **responds correctly** (no
  timeout, no "Failed to connect to bus")
- `bluetoothctl list` from the container → sees the same controller as the host
- **Conclusion: the fine-grained capabilities config is sufficient, no need for `privileged: true`.**

### Step C — real BLE scan from the container (bonus, full validation)

`bluetoothctl scan on` for 10s from the container detected, among other BLE devices
nearby, the **P0 devices from the spec**:

- `A0:14:3D:CD:A3:D3` — "Parrot pot a3d3"
- `A0:14:3D:CD:A0:73` — "Parrot pot a073" (two Parrot Pots detected, not just one)
- `A4:C1:38:51:3B:54` — "LYWSD03MMC" (Xiaomi, pvvx firmware confirmed by the advertised name)

The full pipeline (Docker container → capabilities → D-Bus → host BlueZ → adapter →
BLE scan → detection of the real target devices) is validated end-to-end.

## Required host setup on BlueZ ≥ 5.76 (Debian 13+): disable the `gap` plugin (2026-09-29)

**Mandatory on any host running BlueZ 5.76 or later** (Debian 13 ships 5.82; Debian 12's 5.66 is
unaffected). Without it, only the first GATT connection to a Parrot Pot after an adapter reset
succeeds — every later one times out (`TIMEOUT: gatt (18000ms)`), which looks exactly like a
controller/firmware freeze but isn't one.

- **Root cause, confirmed via `btmon` on real hardware** (not guessed): BlueZ 5.76 added code to its
  built-in `gap` plugin (`profiles/gap/gas.c`, checked against the 5.66/5.75/5.76/5.82 sources) that
  reads the peripheral's *Peripheral Preferred Connection Parameters* (`0x2a04`) and loads them
  into the kernel (`MGMT Load Connection Parameters`). The Parrot Pot advertises 100-200ms
  interval / 10s supervision — so every connection after the first one requests 100-200ms, the
  controller picks 200ms, and each ATT round-trip takes ~400ms. Since these pots are never paired,
  BlueZ redoes full GATT discovery (~175 ATT exchanges) on every connection: **~40s at 200ms vs
  ~9s at the kernel's default 50ms** — well past node-ble's 18s `gatt()` timeout. The loaded
  parameters live only in kernel memory (unpaired devices → nothing written to
  `/var/lib/bluetooth`), which is why a `btusb` reload "fixed" it until the next connection.
- **Fix** — a systemd drop-in, nothing else changes (no kernel/package/repo change):

  ```bash
  sudo mkdir -p /etc/systemd/system/bluetooth.service.d
  printf '[Service]\nExecStart=\nExecStart=/usr/libexec/bluetooth/bluetoothd --noplugin=gap\n' \
    | sudo tee /etc/systemd/system/bluetooth.service.d/10-stroyplant-noplugin-gap.conf
  sudo systemctl daemon-reload && sudo systemctl restart bluetooth
  ```

  Then reset the adapter so the kernel forgets any already-loaded parameters. **Prefer a USB-level
  reset over `modprobe -r btusb`**: a module reload done right after the `bluetooth` restart left
  the controller uninitialized (`command 0xfc11 tx timeout`, `HCI Reset failed: -110`, no
  controller visible to bluetoothd); a USB de/re-authorize recovered it cleanly (full firmware
  patch reload). Find the device with `readlink -f /sys/class/bluetooth/hci0`, then
  `echo 0 > /sys/bus/usb/devices/<usb-id>/authorized; sleep 3; echo 1 > .../authorized` as root.
- **Side effect**: BlueZ no longer reads Device Name/Appearance over GATT — irrelevant here, names
  come from BLE advertisements. The plugin can't be partially disabled.
- **Rollback**: remove the drop-in file, `daemon-reload`, restart `bluetooth`.
- **Verification**: `ps -o args -C bluetoothd` shows `--noplugin=gap`; a `btmon` capture of several
  successive connections shows `Connection interval: 50.00 msec` and no `Load Connection
  Parameters` on every one of them.

## Remaining work once the TP-Link dongle arrives

The Realtek RTL8761B chipset (TP-Link) is different from the already validated Intel
Wireless-AC 3168 — BlueZ theoretically absorbs these differences, but it needs concrete
re-verification:

- `dmesg | grep -i -E "usb|blue"` right after plugging it in — confirm that the kernel
  recognizes the chipset with no missing firmware error
- `hciconfig -a` — the new adapter must appear as `UP RUNNING`
- If both adapters (integrated Intel + TP-Link) are present at the same time, decide
  which one to use by default for Batch 1 (probably the TP-Link, recommended in the
  spec for its reliability/range — but the integrated one remains a good fallback)
- Redo the Step C scan test with the TP-Link to confirm at least equivalent
  range/reliability

---

## Original content of this folder (for reference / future re-run)

## 1. Preparation

Copy this `infra/lot0/` folder to the production server (scp, rsync, or clone of the repo once it exists).

## 2. Step A — host checks (outside Docker)

```bash
chmod +x check-host.sh
./check-host.sh
```

This script checks:
- that Docker Engine is native Linux (doesn't make sense to check on macOS/Windows, but we
  confirm the version and the cgroup driver)
- that `bluez` is installed on the host and that the `bluetooth.service` service is running (it
  must run even without an adapter plugged in, unless it was manually disabled)
- that the system D-Bus socket exists at the expected location (`/var/run/dbus/system_bus_socket`)
  — this is the socket we will mount into the container later
- list of adapters known to BlueZ (empty, normal without a dongle)

**Send me the full output.**

## 3. Step B — Bluetooth access from a Docker container

```bash
docker compose -f docker-compose.test.yml up --abort-on-container-exit
docker compose -f docker-compose.test.yml down
```

This test launches a **disposable** container (not yet the app image, just `debian:bookworm-slim`
+ `bluez` installed on the fly) with the Docker configuration required by the spec (section 5):
`cap_add: NET_ADMIN, NET_RAW` + `network_mode: host` + mounting the system D-Bus socket.

It tries to:
1. Display the version of `bluetoothctl` installed in the container
2. Make a direct D-Bus call to `org.bluez` (`dbus-send`) — **this is the key test**: if it
   responds (even a "no such adapter" error), the container is indeed talking to BlueZ via the
   host's system bus. If it times out or returns "Failed to connect to bus", the
   capabilities/mount config is not sufficient and we'll need to switch to `privileged: true`
   (alternative commented out in the file).
3. List known adapters (empty, normal without a dongle)

**Send me the full output, especially whether the `dbus-send` step responds or times out.**

## 4. What remains blocked without the dongle (to redo once received)

Once the dongle is plugged into the production server, Batch 0 will need to be fully revalidated:
- `dmesg | grep -i -E "usb|blue"` right after plugging it in — confirm that the kernel recognizes
  the Realtek RTL8761B chipset with no missing firmware error
- `hciconfig -a` on the host — the adapter must appear with `UP RUNNING` status
- Redo the Step B test with the dongle plugged in — `bluetoothctl list` must now
  show the real adapter, and `bluetoothctl scan on` must detect BLE devices nearby
  from inside the container
- Definitively decide between `privileged: true` and the fine-grained capabilities approach,
  depending on what worked in Step B

Do not consider Batch 0 "done" until this section is validated with the
real dongle — the above is only partial preparation.
