# Wiring and provisioning the real device

You need: a Dabao / YD-ESP32-S3 board, an SPI TFT (ILI9341, ST7789 or ST7735),
one momentary button for the plunger, optionally a second switch under the cover,
a USB-C cable, and the same WiFi network as the relay.

Nothing in this firmware is compiled for a specific board. The panel driver,
pins, WiFi credentials and relay URL all live in NVS and are set once over the
serial console, so a wrong pin guess costs a `set pins ...` line, not a reflash.

## 1. Flash

```bash
~/Library/Python/3.12/bin/pio run -d firmware -t upload
~/Library/Python/3.12/bin/pio device monitor -d firmware
```

If upload fails to find the port: hold BOOT, tap RESET, release BOOT, then rerun
with `--upload-port /dev/cu.usbmodem*`. Some YD-ESP32-S3 boards need a USB-C
cable in the port labelled `USB`, not `COM`.

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
set relay http://<your-laptop-lan-ip>:8787
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
