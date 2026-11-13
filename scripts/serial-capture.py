#!/usr/bin/env python3
"""Capture the device's serial console to a timestamped log.

    python3 scripts/serial-capture.py [--port /dev/cu.usbserial-110] [--seconds 40]
                                      [--cmd info --cmd key --cmd test]

Writes docs/hardware/serial-YYYYMMDD-HHMMSS.log and prints the tail. Uses only
pyserial, which PlatformIO already installs; no other dependency.

Why this exists: `pio device monitor` is interactive and awkward to drive from a
script or an agent, and the proof artefact we need is a file, not a terminal
scroll. This opens the port once, drains the boot banner, sends each command,
and keeps everything it saw.
"""

from __future__ import annotations

import argparse
import datetime
import pathlib
import sys
import time

try:
    import serial
except ImportError:  # pragma: no cover - the message is the point
    sys.exit("pyserial missing: run this with the python that has PlatformIO installed")

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "hardware"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="/dev/cu.usbserial-110")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=45, help="total capture budget")
    ap.add_argument("--cmd", action="append", default=[], help="command to send, repeatable")
    args = ap.parse_args()

    cmds = args.cmd or ["info", "key", "test"]
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    path = OUT / f"serial-{stamp}.log"

    chunks: list[str] = []

    def pump(seconds: float) -> None:
        deadline = time.time() + seconds
        while time.time() < deadline:
            data = port.read(4096)
            if data:
                chunks.append(data.decode("utf-8", "replace"))

    port = serial.Serial(args.port, args.baud, timeout=0.3)
    # do not reset the board on open; we want the boot banner it already printed
    port.setDTR(False)
    port.setRTS(False)
    per = max(2.0, args.seconds / (len(cmds) + 1))
    pump(per)  # banner and any pending output
    for cmd in cmds:
        port.write((cmd + "\n").encode())
        port.flush()
        pump(per)
    port.close()

    text = "".join(chunks)
    path.write_text(text, encoding="utf-8")
    print(f"wrote {path} ({len(text)} chars)")
    print(text[-2000:])
    return 0 if text.strip() else 1


if __name__ == "__main__":
    raise SystemExit(main())
