#!/usr/bin/env bash
# Put the board on WiFi without ever echoing the password to the terminal,
# a shell history file, or a chat log.
#
#   ./scripts/provision-wifi.sh "<SSID>"
#
# It prompts for the password with `read -s`, sends `set ssid`, `set pass` and
# `save` to the board over serial, then prints the resulting status. The password
# lives in `$WIFI_PASS` for the lifetime of this process only; it is never written
# to disk and never passed on a command line (where `ps` could see it).
set -euo pipefail

SSID="${1:-}"
if [ -z "$SSID" ]; then
  echo "usage: $0 \"<SSID>\"   (password is prompted)" >&2
  exit 2
fi

PORT="${PORT:-/dev/cu.usbserial-110}"
PY="${PY:-$HOME/.venvs/pio/bin/python}"
command -v "$PY" >/dev/null 2>&1 || PY="$(command -v python3)"

printf 'WiFi password for %s: ' "$SSID" >&2
IFS= read -rs WIFI_PASS
printf '\n' >&2
[ -n "$WIFI_PASS" ] || { echo "empty password" >&2; exit 2; }
export WIFI_PASS

WIFI_SSID="$SSID" "$PY" - "$PORT" <<'PY'
import os, sys, time, serial

port = serial.Serial(sys.argv[1], 115200, timeout=0.3)
port.setDTR(False)
port.setRTS(False)


def pump(seconds):
    out = []
    end = time.time() + seconds
    while time.time() < end:
        data = port.read(4096)
        if data:
            out.append(data.decode("utf-8", "replace"))
    return "".join(out)


pump(1.5)
for cmd in (
    f"set ssid {os.environ['WIFI_SSID']}",
    f"set pass {os.environ['WIFI_PASS']}",
    "save",
    "reboot",
):
    port.write((cmd + "\n").encode())
    port.flush()
    print(pump(2.0).strip())
port.close()

# reconnect after the reboot and report what the board thinks of its WiFi
time.sleep(6)
port = serial.Serial(sys.argv[1], 115200, timeout=0.3)
port.setDTR(False)
port.setRTS(False)
pump(2.0)
port.write(b"status\n")
port.flush()
print(pump(3.0).strip())
port.close()
PY
