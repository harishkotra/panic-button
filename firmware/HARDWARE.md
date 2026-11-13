# Wiring and provisioning the real device

You need: a Dabao / YD-ESP32-S3 board, an SPI TFT (ILI9341, ST7789 or ST7735),
one momentary button for the plunger, optionally a second switch under the cover,
a USB-C cable, and the same WiFi network as the relay. The relay binds all
interfaces by default and prints the exact address to use, e.g.
`panic-button relay on http://127.0.0.1:8787 (LAN: http://192.168.68.60:8787)`;
set HOST=127.0.0.1 to keep it loopback-only for browser-only use.

Nothing in this firmware is compiled for a specific board. The panel driver,
pins, WiFi credentials and relay URL all live in NVS and are set once over the
serial console, so a wrong pin guess costs a `set pins ...` line, not a reflash.

## 1. Flash

```bash
./scripts/hw.sh ports      # prints the ports and which one is the ESP32
./scripts/hw.sh flash      # add PORT=/dev/cu.usbserial-110 if autodetect picks wrong
./scripts/hw.sh monitor
```

Two serial devices can appear on a Mac, and picking the wrong one wastes an hour:

- `/dev/cu.usbserial-*` (VID `1a86`, CH343/CP210x bridge). **This is the ESP32-S3.**
  esptool talks to it, the console prints on it, one cable does both.
- `/dev/cu.usbmodem*`. On a desk with a Baochip Dabao in the same hub, this is the
  **Dabao's** USB CDC, not the ESP32. Flashing it fails with
  `Invalid head of packet (0xC3): Possible serial noise or corruption`, because the
  board answers esptool's sync with Xous console output. Nothing is wrong with the
  cable or the speed.

The firmware keeps `Serial` on UART0 for exactly this reason
(`-DARDUINO_USB_CDC_ON_BOOT=0`). With it set to 1 the console moves to the native
USB port, and a single cable to the bridge flashes the board but prints nothing.

If upload still fails: hold BOOT, tap RESET, release BOOT, rerun. Some
YD-ESP32-S3 boards need the cable in the port labelled `USB`, not `COM`.
Upload runs at 460800; 921600 fails on longer or hub-mediated cables.

To capture the console to a file instead of scrolling it:

```bash
python3 scripts/serial-capture.py --port /dev/cu.usbserial-110 --cmd info --cmd key --cmd test
```

## 2. Wire the screen (default pins)

The defaults are the ESP32-S3 SPI2 defaults and are the ones most breakout
boards expose as a cluster:

| Screen | ESP32-S3 | note |
|---|---|---|
| VCC | 3V3 | never 5 V |
| GND | GND | |
| CS | GPIO10 | `set pins` field 1 |
| DC / RS | GPIO9 | field 2 |
| RST | GPIO8 | field 3 (can be -1) |
| LED / BL | GPIO7 | field 4, PWM dimming |
| MOSI / SDA | GPIO11 | field 5 |
| SCK / SCL | GPIO12 | field 6 |
| MISO | not connected | we never read back |
| TOUCH | not connected | |

If the screen stays dark or shows snow, run `test` and adjust. `test` paints
three colour bars plus the detected width and height. Reading them tells you
immediately whether the wiring or the driver is wrong:

- **dark, no backlight** → `set pins …` backlight or CS wrong
- **backlight, white screen** → wrong `set driver` or wrong `set rot`
- **colours inverted or shifted** → `set invert 1`, then `set rot 1`
- **bars visible but squeezed / with a border** → `set size <w> <h>`

## 3. Wire the buttons

Defaults: plunger on GPIO0 (the BOOT button on most S3 devkits, so you can test
before soldering), cover switch on GPIO5.

Both pins are `INPUT_PULLUP` and read active-low, so each button simply shorts
the pin to GND:

```
GPIO0 ──[ plunger ]── GND        # press = escape
GPIO5 ──[ cover switch ]── GND   # closed = cover down = interlocked
```

The cover switch is the honesty mechanism: with the cover down the device does
not even ask the relay for a challenge. Both prints appear on screen — `GUARDED`
if it was pressed under the cover, `ARMED` when the cover is up.

No cover switch? `set buttons 0,-1` and the interlock is skipped (the screen
stops claiming there is one).

## 4. Provision

```bash
set ssid <your wifi>
set pass <your wifi password>
set relay http://<your-laptop-lan-ip>:8787   # printed at relay startup as (LAN: ...)
set account intents.near
set driver ili9341
set size 240 320
set rot 0
save
reboot
```

`status` prints the current config, the WiFi state and the device public key.
`key` prints the public key alone. That key is generated from the ESP32-S3
hardware RNG on first boot and never leaves the chip — there is no private key
anywhere on the laptop.

## 5. Register the device with the relay

On the laptop, take the base58 key printed by `key` and register it as the only
key allowed to fire:

```bash
DEVICE_PUBKEY=<base58 from serial> CAP=1000 npm run seed
```

From that moment the relay will refuse any signature that did not come from that
chip. The browser console's key no longer works, which is the point: the demo is
the device now, not a drawing of one.

## 6. What good looks like

Serial, on a successful press with the cover up and the cap high enough:

```
cover: open
panic: challenge
panic: signed 214 bytes, challenge 0b3f…
panic: relay 200
panic: ESCAPED net=$2.9K receipt=533324d97b84786a…
```

Serial, on a press under the cap:

```
cover: open
panic: challenge
panic: signed 214 bytes, challenge 7f1c…
panic: relay 402
panic: REFUSED portfolio $62300000 exceeds cap $1000
```

The panel shows the matching screen, and `GET /api/panics` on the relay contains
the same signature and `devicePubKey`. That triple — serial line, photograph of
the panel, and the panic record naming the device key — is the hardware proof.

## 7. If the panel never lights up

Run `test` after every change. If it stays dark with all pins correct, check the
board's 3V3 rail with a meter; some YD-ESP32-S3 clones ship with a 5 V-only
regulator arrangement on the display header and need the screen fed from the 5 V
pin while logic stays 3V3.

## 8. The press that actually happened

Two runs are on the record from board `FoGadzn243LXvstSF3iJ7Vunbdz5mh4uLawrbwnCS2eU`,
both over WiFi at `192.168.68.61`, both signed on the chip with the same key that
never leaves NVS:

- `docs/hardware/serial-20261113-195938.log` — `panic` typed over serial.
- `docs/hardware/press-20261113-2028.log` — the red plunger pressed by hand.

Both end the same way:

```
panic: challenge
panic: signed 178 bytes, challenge 365f2230-90de-448b-bed4-708bd6840a06
panic: relay 402
panic: REFUSED portfolio $64986064.71 exceeds cap $1000
```

and the relay stores the matching record (`verdict: REJECTED`, `reason: portfolio
$64986064.71 exceeds cap $1000`, `devicePubKey: FoGadzn…S2eU`). The panel in
`docs/hardware/refused-20261113.jpeg` is the third leg of that triple: the board
in hand, screen reading REFUSED, wired to the same device key.

The button is on GPIO0. `watch on` (see `help`) reports every GPIO that changes,
which is how the pin was identified instead of guessed; GPIO12 on this carrier is
unconnected and floats, so it chatters in the log — ignore it.
