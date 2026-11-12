# Firmware

Reference device software for **YD-ESP32-S3 (N16R8)** + **ILI9341 2.4" SPI panel**, with a red
plunger, a flip cover, and a YOLO slider.

Status: written and reviewed, **not compiled in this repo's CI** — the build machine has no ESP32
toolchain. The relay, the signing flow and the receipt format it talks to are the parts covered by
`npm run verify`. If you have PlatformIO, `pio run -d firmware` builds it as-is.

## Wiring

| Signal | S3 pin | Notes |
| --- | --- | --- |
| TFT SCLK | 12 | SPI2 |
| TFT MOSI | 11 | |
| TFT MISO | 13 | shared bus, not required by ILI9341 |
| TFT CS | 10 | |
| TFT DC | 9 | |
| TFT RST | 8 | |
| TFT BL | 7 | 100Ω to LED, HIGH = lit |
| Plunger | 4 | other leg to GND, `INPUT_PULLUP`, pressed = LOW |
| Cover switch | 5 | reed or micro-switch, closed cover = LOW |
| YOLO slider | 6 | closed = LOW |

The panel pin map lives in `platformio.ini` `build_flags`, so TFT_eSPI needs no `User_Setup.h`.

## Build and flash

```bash
pio run -d firmware -t upload
pio device monitor -b 115200
```

First boot prints the device public key:

```
device pubkey: 7Xh...Qm
```

Put that key into the policy (`devicePubKey`) and the same relay URL into `RELAY`. From then on the
device is the only thing that can authorise a panic for that policy, because a challenge is signed
with the seed in NVS and the relay only accepts that signature.

## What it does, in order

1. `GET /api/state` — shows the guarded account and the cap on the screen.
2. `GET /api/quotes` — shows what would move and what it would net, refreshed every 60s.
3. Plunger press with the cover **down** → refused on-device (`GUARD`), nothing is sent.
4. Plunger press with the cover **up** → `POST /api/challenge`, sign the nonce with ed25519,
   `POST /api/panic`, draw the receipt. The receipt stays on screen until the next press.
5. `REFUSED` is a real outcome, not a stub: a 402 (over cap), 401 (bad signature) or 404 (stale
   challenge) each renders with the server's reason and the line "nothing moved."

## Deliberate omissions

- TLS uses `setInsecure()` in the demo build. Pin the relay certificate before this holds anything
  real.
- No OTA, no battery management, no enclosure CAD. The point of the object is the seam between a
  physical gesture and an irreversible signature, not the plastic.
- The seed is stored in NVS in plaintext. A shipped product would use the S3's eFuse-backed
  HMAC or an ATECC608 with the key never in RAM.
