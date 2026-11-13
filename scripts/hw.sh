#!/usr/bin/env bash
# One entry point for the physical device.
#   ./scripts/hw.sh ports            list serial ports
#   ./scripts/hw.sh build            compile the firmware
#   ./scripts/hw.sh flash            compile and upload
#   ./scripts/hw.sh monitor          open the provisioning console
#   ./scripts/hw.sh proof [seconds]  capture the serial console to docs/hardware/
set -euo pipefail
cd "$(dirname "$0")/.."

PIO="${PIO:-$HOME/Library/Python/3.12/bin/pio}"
PORT="${PORT:-}"

port_args=()
if [ -n "$PORT" ]; then port_args=(--upload-port "$PORT"); fi

case "${1:-build}" in
  ports)
    "$PIO" device list
    ;;
  build)
    "$PIO" run -d firmware
    ;;
  flash)
    "$PIO" run -d firmware -t upload "${port_args[@]}"
    ;;
  monitor)
    "$PIO" device monitor -d firmware "${port_args[@]}"
    ;;
  proof)
    secs="${2:-120}"
    mkdir -p docs/hardware
    log="docs/hardware/serial-$(date +%Y%m%d-%H%M%S).log"
    echo "capturing ${secs}s of serial to $log"
    echo "now: lift the cover, press the plunger, type 'key', then 'status'"
    "$PIO" device monitor -d firmware --raw "${port_args[@]}" >"$log" 2>&1 &
    pid=$!
    sleep "$secs"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    echo "--- capture ---"
    cat "$log"
    ;;
  *)
    echo "usage: $0 {ports|build|flash|monitor|proof [seconds]}" >&2
    exit 2
    ;;
esac
