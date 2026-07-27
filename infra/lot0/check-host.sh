#!/usr/bin/env bash
set -euo pipefail

echo "=== Docker Engine ==="
docker --version
docker info --format 'OS: {{.OperatingSystem}} | cgroup driver: {{.CgroupDriver}} | server version: {{.ServerVersion}}'
echo

echo "=== BlueZ (hote) ==="
if command -v bluetoothctl >/dev/null 2>&1; then
  bluetoothctl --version
else
  echo "bluetoothctl introuvable - installer via: apt install bluez"
fi
echo

echo "=== Service bluetooth.service (hote) ==="
systemctl status bluetooth --no-pager || true
echo

echo "=== Socket D-Bus systeme ==="
ls -la /var/run/dbus/system_bus_socket 2>/dev/null || echo "Socket introuvable a l'emplacement attendu"
echo

echo "=== Adaptateurs connus de BlueZ (vide normal sans dongle branche) ==="
bluetoothctl list || true
