// Panic Button - device firmware.
//
// The device holds an ed25519 key. It never touches funds. It asks the relay for
// a challenge, signs it, and posts it back. The relay decides whether the escape
// is inside the cap that was set before the emergency.
//
// Everything hardware-specific (screen driver, pins, WiFi, relay URL) is runtime
// config stored in NVS and set over the serial console, so one binary works on
// any ESP32-S3 + SPI TFT combination. See firmware/HARDWARE.md.

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <LovyanGFX.hpp>

extern "C" {
#include "ed25519.h"
}

// ───────────────────────────────────────────────────────────── config ──

struct Cfg {
  String ssid = "";
  String pass = "";
  String relay = "http://192.168.1.10:8787";
  String account = "intents.near";
  int cs = 10, dc = 9, rst = 8, bl = 7, mosi = 11, sclk = 12;
  int drv = 0;          // 0 ILI9341, 1 ST7789, 2 ST7735
  int rot = 0;
  int w = 240, h = 320;
  int offX = 0, offY = 0;   // memory window offset; ST7789 240x240 lives 80 rows into a 320-row RAM
  bool inv = false;
  int pinPlunger = 0;   // onboard BOOT on most S3 devkits
  int pinCover = 5;     // jumper to GND = cover down; -1 disables the interlock
};

static Cfg cfg;
static Preferences prefs;

static void loadCfg() {
  prefs.begin("panic", true);
  cfg.ssid = prefs.getString("ssid", cfg.ssid);
  cfg.pass = prefs.getString("pass", cfg.pass);
  cfg.relay = prefs.getString("relay", cfg.relay);
  cfg.account = prefs.getString("acct", cfg.account);
  cfg.cs = prefs.getInt("cs", cfg.cs);
  cfg.dc = prefs.getInt("dc", cfg.dc);
  cfg.rst = prefs.getInt("rst", cfg.rst);
  cfg.bl = prefs.getInt("bl", cfg.bl);
  cfg.mosi = prefs.getInt("mosi", cfg.mosi);
  cfg.sclk = prefs.getInt("sclk", cfg.sclk);
  cfg.drv = prefs.getInt("drv", cfg.drv);
  cfg.rot = prefs.getInt("rot", cfg.rot);
  cfg.w = prefs.getInt("w", cfg.w);
  cfg.h = prefs.getInt("h", cfg.h);
  cfg.offX = prefs.getInt("ox", cfg.offX);
  cfg.offY = prefs.getInt("oy", cfg.offY);
  cfg.inv = prefs.getBool("inv", cfg.inv);
  cfg.pinPlunger = prefs.getInt("plg", cfg.pinPlunger);
  cfg.pinCover = prefs.getInt("cov", cfg.pinCover);
  prefs.end();
}

static void saveCfg() {
  prefs.begin("panic", false);
  prefs.putString("ssid", cfg.ssid);
  prefs.putString("pass", cfg.pass);
  prefs.putString("relay", cfg.relay);
  prefs.putString("acct", cfg.account);
  prefs.putInt("cs", cfg.cs);
  prefs.putInt("dc", cfg.dc);
  prefs.putInt("rst", cfg.rst);
  prefs.putInt("bl", cfg.bl);
  prefs.putInt("mosi", cfg.mosi);
  prefs.putInt("sclk", cfg.sclk);
  prefs.putInt("drv", cfg.drv);
  prefs.putInt("rot", cfg.rot);
  prefs.putInt("w", cfg.w);
  prefs.putInt("h", cfg.h);
  prefs.putInt("ox", cfg.offX);
  prefs.putInt("oy", cfg.offY);
  prefs.putBool("inv", cfg.inv);
  prefs.putInt("plg", cfg.pinPlunger);
  prefs.putInt("cov", cfg.pinCover);
  prefs.end();
}

// ───────────────────────────────────────────────────────────── screen ──

class Screen : public lgfx::LGFX_Device {
 public:
  lgfx::Panel_ILI9341 ili;
  lgfx::Panel_ST7789 st7789;
  lgfx::Panel_ST7735 st7735;
  lgfx::Bus_SPI bus;
  lgfx::Light_PWM light;
  bool ready = false;

  void configure() {
    auto b = bus.config();
    b.spi_host = SPI2_HOST;
    b.spi_mode = 0;
    b.freq_write = 40000000;
    b.freq_read = 16000000;
    b.spi_3wire = true;
    b.use_lock = true;
    b.dma_channel = SPI_DMA_CH_AUTO;
    b.pin_sclk = cfg.sclk;
    b.pin_mosi = cfg.mosi;
    b.pin_miso = -1;
    b.pin_dc = cfg.dc;
    bus.config(b);

    lgfx::Panel_Device *p = &ili;
    if (cfg.drv == 1) p = &st7789;
    if (cfg.drv == 2) p = &st7735;

    auto pc = p->config();
    pc.pin_cs = cfg.cs;
    pc.pin_rst = cfg.rst;
    pc.pin_busy = -1;
    // A 240x240 ST7789 is a 240x320 controller with the visible window 80 rows
    // down. Claiming a 240-row memory breaks rotation and shifts every pixel, so
    // declare the real RAM and offset into it.
    bool squareST = (cfg.drv == 1 && cfg.w == 240 && cfg.h == 240);
    pc.memory_width = cfg.w;
    pc.memory_height = squareST ? 320 : cfg.h;
    pc.panel_width = cfg.w;
    pc.panel_height = cfg.h;
    pc.offset_x = cfg.offX;
    pc.offset_y = cfg.offY + (squareST ? 80 : 0);
    pc.invert = cfg.inv;
    pc.readable = false;
    pc.bus_shared = false;
    p->config(pc);
    p->setBus(&bus);

    auto l = light.config();
    l.pin_bl = cfg.bl;
    l.invert = false;
    l.freq = 12000;
    l.pwm_channel = 7;
    light.config(l);
    p->setLight(&light);

    setPanel(p);
    ready = init();
    if (ready) {
      setRotation(cfg.rot);
      setColorDepth(16);
      setBrightness(255);
    }
  }
};

static Screen tft;

// palette
static const uint16_t C_BG = 0x10A2;      // near-black
static const uint16_t C_INK = 0xFFFF;
static const uint16_t C_DIM = 0x8C71;
static const uint16_t C_LINE = 0x2A69;
static const uint16_t C_RED = 0xE1C8;
static const uint16_t C_GREEN = 0x3666;
static const uint16_t C_AMBER = 0xFD20;
static const uint16_t C_PANEL = 0x1926;

enum State { BOOT, NO_WIFI, OFFLINE, READY, ARMED, GUARD, SIGNING, REFUSED, ESCAPED, FAULT };
static State state = BOOT;

static void text(const char *s, int x, int y, int size, uint16_t color, uint8_t datum = TL_DATUM) {
  tft.setTextDatum(datum);
  tft.setTextColor(color, C_BG);
  tft.setTextSize(size);
  tft.drawString(s, x, y);
}

static void centre(const char *s, int y, int size, uint16_t color) {
  text(s, tft.width() / 2, y, size, color, TC_DATUM);
}

// live values painted on the watch screen
static String gPortfolio = "$-";
static String gNet = "$-";
static String gLegs = "-";
static String gRoute = "near";
static String gNote = "";      // last error / hint, one line
static String gReceipt = "";   // latched receipt prefix
static uint32_t gCapUsed = 0;

static void chrome(const char *label, uint16_t accent) {
  const int W = tft.width();
  tft.fillScreen(C_BG);
  tft.fillRect(0, 0, W, 26, C_PANEL);
  tft.fillRect(0, 0, 3, 26, accent);
  text("PANIC BUTTON", 8, 7, 1, C_DIM);
  text(label, W - 8, 7, 1, accent, TR_DATUM);
  tft.drawFastHLine(0, tft.height() - 22, W, C_LINE);
}

static void drawReady() {
  chrome(WiFi.status() == WL_CONNECTED ? "LIVE" : "OFFLINE",
         WiFi.status() == WL_CONNECTED ? C_GREEN : C_AMBER);
  const int W = tft.width();
  centre("UNDER WATCH", 44, 1, C_DIM);
  centre(gPortfolio.c_str(), 60, 4, C_INK);
  tft.drawFastHLine(16, 108, W - 32, C_LINE);
  text("ESCAPE TO", 16, 120, 1, C_DIM);
  text(gRoute.c_str(), 16, 136, 2, C_INK);
  text("NET OUT", W - 16, 120, 1, C_DIM, TR_DATUM);
  text(gNet.c_str(), W - 16, 136, 2, C_INK, TR_DATUM);
  text("LEGS", 16, 172, 1, C_DIM);
  text(gLegs.c_str(), 76, 172, 2, C_INK);
  if (gNote.length()) {
    text(gNote.c_str(), 16, 204, 1, C_AMBER);
  } else if (cfg.pinCover >= 0) {
    text(digitalRead(cfg.pinCover) == HIGH ? "COVER OPEN - PRESS" : "COVER DOWN - LIFT IT", 16, 204, 1,
         digitalRead(cfg.pinCover) == HIGH ? C_AMBER : C_DIM);
  } else {
    text("NO COVER SWITCH WIRED", 16, 204, 1, C_DIM);
  }
  centre("ONE PRESS. NOTHING ELSE.", tft.height() - 8, 1, C_DIM);
}

static void drawArmed() {
  chrome("ARMED", C_AMBER);
  centre("COVER IS UP", 52, 2, C_AMBER);
  centre("THE BUTTON IS LIVE", 78, 1, C_DIM);
  centre(gPortfolio.c_str(), 110, 3, C_INK);
  centre("press to escape everything", 158, 1, C_DIM);
  centre("CAP IS SET BEFORE THIS", tft.height() - 8, 1, C_DIM);
}

static void drawSigning() {
  chrome("SIGNING", C_AMBER);
  centre("CHALLENGE", 62, 2, C_INK);
  centre("ed25519 over the relay nonce", 96, 1, C_DIM);
  centre("one key. one press.", 120, 1, C_DIM);
  tft.drawRect(20, 160, tft.width() - 40, 8, C_LINE);
  tft.fillRect(20, 160, tft.width() - 40, 8, C_AMBER);
}

static void drawRefused(const String &why) {
  chrome("REFUSED", C_RED);
  centre("REFUSED", 56, 4, C_RED);
  centre("402 - not signed off", 96, 1, C_RED);
  tft.drawFastHLine(16, 116, tft.width() - 32, C_LINE);
  text("WHY", 16, 128, 1, C_DIM);
  centre(why.c_str(), 148, 1, C_INK);
  centre("nothing moved", 190, 2, C_DIM);
  centre("the cap held", tft.height() - 8, 1, C_DIM);
}

static void drawEscaped() {
  chrome("ESCAPED", C_GREEN);
  centre("ESCAPED", 50, 4, C_GREEN);
  centre("signed by this device", 90, 1, C_DIM);
  tft.drawFastHLine(16, 108, tft.width() - 32, C_LINE);
  text("NET OUT", 16, 120, 1, C_DIM);
  text(gNet.c_str(), 16, 138, 2, C_INK);
  text("LEGS", tft.width() - 16, 120, 1, C_DIM, TR_DATUM);
  text(gLegs.c_str(), tft.width() - 16, 138, 2, C_INK, TR_DATUM);
  text("RECEIPT", 16, 172, 1, C_DIM);
  text(gReceipt.c_str(), 16, 190, 1, C_INK);
  centre("hold the button to re-arm", tft.height() - 8, 1, C_DIM);
}

static void drawFault(const String &why) {
  chrome("FAULT", C_RED);
  centre("NO SIGNAL", 60, 2, C_RED);
  centre(why.c_str(), 92, 1, C_INK);
  centre("device key never left the chip", 130, 1, C_DIM);
  centre("check the relay, then reboot", tft.height() - 8, 1, C_DIM);
}

static void drawGuard() {
  chrome("GUARDED", C_RED);
  centre("COVER DOWN", 62, 2, C_RED);
  centre("the relay never heard a thing", 92, 1, C_DIM);
  centre("lift the cover, then press", 128, 1, C_AMBER);
  tft.drawRect(30, 170, tft.width() - 60, 40, C_LINE);
  centre("INTERLOCK", 182, 1, C_DIM);
}

static void drawNoWifi() {
  tft.fillScreen(C_BG);
  centre("PANIC BUTTON", 24, 2, C_INK);
  centre("needs provisioning", 52, 1, C_AMBER);
  centre("open the serial console", 84, 1, C_DIM);
  centre("115200 baud", 100, 1, C_DIM);
  centre("help", 128, 2, C_INK);
}

// ────────────────────────────────────────────────────────────── crypto ──

static uint8_t seed[32];
static uint8_t priv[64];
static uint8_t pub[32];
static String pubB58;

static const char *B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

static String b58encode(const uint8_t *data, size_t len) {
  size_t zeros = 0;
  while (zeros < len && data[zeros] == 0) zeros++;
  uint8_t buf[64] = {0};
  size_t n = 0;
  for (size_t i = zeros; i < len; i++) {
    uint32_t carry = data[i];
    for (size_t j = 0; j < n; j++) {
      carry += (uint32_t)buf[j] << 8;
      buf[j] = carry % 58;
      carry /= 58;
    }
    while (carry) {
      buf[n++] = carry % 58;
      carry /= 58;
    }
  }
  String out;
  for (size_t i = 0; i < zeros; i++) out += '1';
  for (size_t i = 0; i < n; i++) out += B58[buf[n - 1 - i]];
  return out;
}

static String b64encode(const uint8_t *data, size_t len) {
  static const char *T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  String out;
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = data[i] << 16;
    if (i + 1 < len) v |= data[i + 1] << 8;
    if (i + 2 < len) v |= data[i + 2];
    out += T[(v >> 18) & 63];
    out += T[(v >> 12) & 63];
    out += (i + 1 < len) ? T[(v >> 6) & 63] : '=';
    out += (i + 2 < len) ? T[v & 63] : '=';
  }
  return out;
}

static void initKeys() {
  prefs.begin("panic", true);
  size_t got = prefs.getBytes("seed", seed, 32);
  prefs.end();
  if (got != 32) {
    esp_fill_random(seed, 32);   // hardware RNG, never leaves the chip
    prefs.begin("panic", false);
    prefs.putBytes("seed", seed, 32);
    prefs.end();
  }
  ed25519_create_keypair(pub, priv, seed);
  pubB58 = b58encode(pub, 32);
  Serial.print("device pubkey (base58 ed25519): ");
  Serial.println(pubB58);
}

// ───────────────────────────────────────────────────────────────── http ──

static String urlOf(const String &path) {
  String base = cfg.relay;
  while (base.endsWith("/")) base.remove(base.length() - 1);
  return base + path;
}

static int httpJson(const String &method, const String &path, const String &body, String &out) {
  HTTPClient http;
  http.setTimeout(9000);
  http.setConnectTimeout(6000);
  String url = urlOf(path);
  int code;
  if (url.startsWith("https://")) {
    WiFiClientSecure c;
    c.setInsecure();
    if (!http.begin(c, url)) return -1;
    http.addHeader("content-type", "application/json");
    code = (method == "GET") ? http.GET() : http.POST(body);
    out = http.getString();
    http.end();
  } else {
    WiFiClient c;
    if (!http.begin(c, url)) return -1;
    http.addHeader("content-type", "application/json");
    code = (method == "GET") ? http.GET() : http.POST(body);
    out = http.getString();
    http.end();
  }
  return code;
}

static String money(double v) {
  char b[24];
  if (v >= 1e6) snprintf(b, sizeof b, "$%.1fM", v / 1e6);
  else if (v >= 1e3) snprintf(b, sizeof b, "$%.1fK", v / 1e3);
  else snprintf(b, sizeof b, "$%.0f", v);
  return String(b);
}

static bool refreshQuotes() {
  String body;
  int code = httpJson("GET", "/api/quotes", "", body);
  if (code != 200) {
    gNote = "relay " + String(code);
    return false;
  }
  JsonDocument doc;
  if (deserializeJson(doc, body)) {
    gNote = "bad json";
    return false;
  }
  double value = doc["totals"]["valueUsd"] | 0.0;
  double net = doc["totals"]["netUsd"] | 0.0;
  int legs = 0;
  for (JsonVariant v : doc["legs"].as<JsonArray>()) { (void)v; legs++; }
  if (!legs) legs = doc["totals"]["legs"] | 0;
  gPortfolio = value > 0 ? money(value) : "$-";
  gNet = net > 0 ? money(net) : "$-";
  gLegs = String(legs);
  gNote = "";
  return true;
}

// ─────────────────────────────────────────────────────────────── escape ──

static bool gFired = false;   // latch: a verdict stays on screen

static void fire() {
  state = SIGNING;
  drawSigning();
  Serial.println("panic: challenge");

  String chBody = "{\"mode\":\"PANIC\"}";
  String out;
  int code = httpJson("POST", "/api/challenge", chBody, out);
  if (code != 200) {
    state = FAULT;
    drawFault("challenge " + String(code));
    Serial.printf("panic: challenge failed %d %s\n", code, out.c_str());
    return;
  }
  JsonDocument doc;
  if (deserializeJson(doc, out)) {
    state = FAULT;
    drawFault("challenge json");
    return;
  }
  String id = doc["challengeId"] | "";
  String msg = doc["message"] | "";
  if (id.isEmpty() || msg.isEmpty()) {
    state = FAULT;
    drawFault("empty challenge");
    return;
  }

  uint8_t sig[64];
  ed25519_sign(sig, (const unsigned char *)msg.c_str(), msg.length(), pub, priv);
  String sigB64 = b64encode(sig, 64);
  Serial.printf("panic: signed %u bytes, challenge %s\n", (unsigned)msg.length(), id.c_str());

  JsonDocument req;
  req["challengeId"] = id;
  req["signature"] = sigB64;
  String payload;
  serializeJson(req, payload);

  out = "";
  code = httpJson("POST", "/api/panic", payload, out);
  Serial.printf("panic: relay %d\n", code);

  JsonDocument res;
  deserializeJson(res, out);
  double value = res["panic"]["quotes"]["totals"]["valueUsd"] | 0.0;
  double net = res["panic"]["quotes"]["totals"]["netUsd"] | 0.0;
  String receipt = res["panic"]["receipt"] | "";

  if (code == 200) {
    gNet = money(net);
    gReceipt = receipt.length() > 16 ? receipt.substring(0, 16) + "..." : receipt;
    state = ESCAPED;
    gFired = true;
    drawEscaped();
    Serial.printf("panic: ESCAPED net=%s receipt=%s\n", gNet.c_str(), receipt.c_str());
  } else if (code == 402) {
    gCapUsed = (uint32_t)value;
    String why = res["error"] | "cap exceeded";
    if (why.length() > 46) why = why.substring(0, 45) + "...";
    state = REFUSED;
    gFired = true;
    drawRefused(why);
    Serial.printf("panic: REFUSED %s\n", why.c_str());
  } else {
    String fallback = "relay " + String(code);
    String why = res["error"] | fallback;
    state = FAULT;
    drawFault(why);
    Serial.printf("panic: FAULT %s\n", why.c_str());
  }
}

// ───────────────────────────────────────────────────────────── buttons ──

static bool plungerDown = false;
static bool coverOpen = false;
static uint32_t lastDebounce = 0;
static uint32_t holdStart = 0;
static bool rearmedThisHold = false;

static bool readPlunger() {
  if (cfg.pinPlunger < 0) return false;
  return digitalRead(cfg.pinPlunger) == LOW;   // active low, INPUT_PULLUP
}

static bool readCover() {
  if (cfg.pinCover < 0) return true;           // no switch = always armed
  return digitalRead(cfg.pinCover) == HIGH;    // closed to GND = cover down
}

static void pollButtons() {
  uint32_t now = millis();
  bool p = readPlunger();
  bool c = readCover();

  if (c != coverOpen && now - lastDebounce > 120) {
    coverOpen = c;
    lastDebounce = now;
    Serial.printf("cover: %s\n", c ? "open" : "down");
    if (!gFired && state != SIGNING) {
      state = c ? ARMED : READY;
      c ? drawArmed() : drawReady();
    }
  }

  if (p && !plungerDown) {
    plungerDown = true;
    holdStart = now;
    rearmedThisHold = false;
  } else if (p && plungerDown && now - holdStart > 1500 && gFired) {
    // long hold clears the latched verdict and re-arms; the same hold must not
    // then fire on release, or a re-arm gesture would escape by accident
    gFired = false;
    rearmedThisHold = true;
    state = coverOpen ? ARMED : READY;
    coverOpen ? drawArmed() : drawReady();
    Serial.println("re-armed");
  } else if (!p && plungerDown) {
    plungerDown = false;
    if (rearmedThisHold) { rearmedThisHold = false; return; }
    if (gFired) return;                         // verdict on screen
    if (state == SIGNING) return;
    if (!coverOpen) {
      state = GUARD;
      drawGuard();
      Serial.println("panic: blocked by interlock");
    } else {
      fire();
    }
  }
}

// ───────────────────────────────────────────────────────────── console ──

static void printHelp() {
  Serial.println();
  Serial.println("panic button - serial provisioning");
  Serial.println("  set ssid <name>            wifi ssid");
  Serial.println("  set pass <secret>          wifi password");
  Serial.println("  set relay <url>            http://192.168.x.x:8787");
  Serial.println("  set account <near id>      account the relay watches");
  Serial.println("  set pins <cs,dc,rst,bl,mosi,sclk>");
  Serial.println("  set driver <ili9341|st7789|st7735>");
  Serial.println("  set size <w> <h>           panel size, e.g. 240 320");
  Serial.println("  set rot <0-3>              rotation");
  Serial.println("  set invert <0|1>           IPS panels are usually 1");
  Serial.println("  set buttons <plunger,cover>  -1 disables, cover -1 = no interlock");
  Serial.println("  test                       re-draw the screen with current config");
  Serial.println("  probe                      cycle driver/invert/size, label each attempt on screen");
  Serial.println("  frame                      draw a border, corner letters and a centre cross");
  Serial.println("  set offset <x> <y>         shift the memory window when the image is clipped");
  Serial.println("  key                        print this device's public key");
  Serial.println("  status                     print config and wifi state");
  Serial.println("  panic                      fire without the button");
  Serial.println("  save / reboot / factory");
  Serial.println();
}

// A blind panel is almost always a config mismatch, not dead hardware: the SPI
// bus is write-only, so `test` reports "init ok" even when nothing is wired.
// Cycle the plausible combinations, stamp the label on the panel, and let the
// person watching read back whichever one appears.
//
// ST7735 is deliberately absent: the sizes here cover the ILI9341 and ST7789
// modules this build is likely to meet, and an ST7735 panel needs its own
// offset/colstart tuning to show anything but a shifted mess. Add it only with a
// confirmed ST7735 module in hand.
static void probePanel() {
  const char *names[2] = {"ili9341", "st7789"};
  // each size entry is tried with both inversions, so 2 drivers x 4 sizes x 2 = 16
  const int ws[4] = {240, 135, 128, 240};
  const int hs[4] = {320, 240, 160, 240};
  const int bls[2] = {cfg.bl, -1};
  const uint16_t bg[2] = {0xF800, 0x07E0};

  int savedDrv = cfg.drv, savedW = cfg.w, savedH = cfg.h, savedInv = cfg.inv, savedBl = cfg.bl;
  int savedRot = cfg.rot;
  int n = 0, total = 16;

  for (int d = 0; d < 2; d++)
    for (int s = 0; s < 4; s++)
      for (int inv = 0; inv < 2; inv++) {
        n++;
        cfg.drv = d; cfg.inv = inv; cfg.w = ws[s]; cfg.h = hs[s]; cfg.bl = bls[inv]; cfg.rot = 0;
        tft.ready = false;
        tft.configure();
        Serial.printf("probe %d/%d %s %dx%d inv=%d bl=%d %s\n", n, total, names[d], ws[s], hs[s], inv,
                      bls[inv], tft.ready ? "init ok" : "init FAILED");
        if (!tft.ready) continue;
        int W = tft.width(), H = tft.height();
        tft.fillScreen(bg[d]);
        tft.fillRect(0, 0, W, H / 3, 0x0000);
        tft.setTextColor(0xFFFF, 0x0000);
        tft.setTextSize(3);
        tft.drawString(String(n).c_str(), 6, 6);
        tft.setTextSize(1);
        tft.drawString(names[d], 6, H / 3 + 8);
        tft.drawString(String(W) + "x" + String(H), 6, H / 3 + 22);
        tft.drawString("inv" + String(inv), 6, H / 3 + 36);
        tft.drawString(bls[inv] < 0 ? "bl none" : ("bl" + String(bls[inv])).c_str(), 6, H / 3 + 50);
        delay(2500);
      }

  cfg.drv = savedDrv; cfg.w = savedW; cfg.h = savedH; cfg.inv = savedInv; cfg.bl = savedBl; cfg.rot = savedRot;
  tft.ready = false;
  tft.configure();
  Serial.println("probe done, config restored");
}

// Draw a shape whose geometry is unambiguous from across the room: if the border
// closes and A/B/C/D sit in the right corners, coordinates are right. If letters
// are missing or the border runs off an edge, the memory window is offset.
static void drawFrame() {
  if (!tft.ready) { Serial.println("display not ready"); return; }
  int W = tft.width(), H = tft.height();
  tft.fillScreen(0x0000);
  tft.drawRect(0, 0, W, H, 0xFFFF);
  tft.drawRect(2, 2, W - 4, H - 4, 0xFFFF);
  tft.drawLine(0, H / 2, W, H / 2, 0xF800);
  tft.drawLine(W / 2, 0, W / 2, H, 0xF800);
  tft.setTextSize(3);
  tft.setTextColor(0x07E0, 0x0000);
  tft.setTextDatum(TL_DATUM); tft.drawString("A", 8, 8);
  tft.setTextDatum(TR_DATUM); tft.drawString("B", W - 8, 8);
  tft.setTextDatum(BL_DATUM); tft.drawString("C", 8, H - 8);
  tft.setTextDatum(BR_DATUM); tft.drawString("D", W - 8, H - 8);
  tft.setTextDatum(MC_DATUM);
  tft.setTextSize(2);
  tft.drawString(String(W) + "x" + String(H) + " rot" + String(cfg.rot), W / 2, H / 2 - 14);
  tft.setTextSize(1);
  tft.drawString("off " + String(cfg.offX) + "," + String(cfg.offY), W / 2, H / 2 + 12);
  Serial.printf("frame drawn %dx%d rot=%d off=%d,%d\n", W, H, cfg.rot, cfg.offX, cfg.offY);
}

static void printStatus() {
  Serial.printf("ssid=%s relay=%s account=%s\n", cfg.ssid.c_str(), cfg.relay.c_str(), cfg.account.c_str());
  Serial.printf("panel=%s %dx%d rot=%d invert=%d pins cs=%d dc=%d rst=%d bl=%d mosi=%d sclk=%d\n",
                cfg.drv == 0 ? "ili9341" : cfg.drv == 1 ? "st7789" : "st7735", cfg.w, cfg.h, cfg.rot,
                (int)cfg.inv, cfg.cs, cfg.dc, cfg.rst, cfg.bl, cfg.mosi, cfg.sclk);
  Serial.printf("buttons plunger=%d cover=%d wifi=%s ip=%s\n", cfg.pinPlunger, cfg.pinCover,
                WiFi.status() == WL_CONNECTED ? "up" : "down",
                WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString().c_str() : "-");
  Serial.printf("pubkey=%s\n", pubB58.c_str());
}

static bool applySet(const String &key, const String &value) {
  if (key == "ssid") cfg.ssid = value;
  else if (key == "pass") cfg.pass = value;
  else if (key == "relay") cfg.relay = value;
  else if (key == "account") cfg.account = value;
  else if (key == "driver") {
    if (value == "ili9341") { cfg.drv = 0; cfg.w = 240; cfg.h = 320; }
    else if (value == "st7789") { cfg.drv = 1; cfg.w = 240; cfg.h = 320; }
    else if (value == "st7735") { cfg.drv = 2; cfg.w = 128; cfg.h = 160; }
    else return false;
  } else if (key == "rot") cfg.rot = value.toInt();
  else if (key == "offset") {
    int a, b;
    if (sscanf(value.c_str(), "%d %d", &a, &b) != 2) return false;
    cfg.offX = a; cfg.offY = b;
  }
  else if (key == "invert") cfg.inv = value.toInt() != 0;
  else if (key == "pins") {
    int v[6];
    if (sscanf(value.c_str(), "%d,%d,%d,%d,%d,%d", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) return false;
    cfg.cs = v[0]; cfg.dc = v[1]; cfg.rst = v[2]; cfg.bl = v[3]; cfg.mosi = v[4]; cfg.sclk = v[5];
  } else if (key == "buttons") {
    int a, b;
    if (sscanf(value.c_str(), "%d,%d", &a, &b) != 2) return false;
    cfg.pinPlunger = a; cfg.pinCover = b;
  } else return false;
  return true;
}

static void handleLine(String line) {
  line.trim();
  if (!line.length()) return;
  int sp = line.indexOf(' ');
  String cmd = sp < 0 ? line : line.substring(0, sp);
  String rest = sp < 0 ? "" : line.substring(sp + 1);
  rest.trim();

  if (cmd == "help") printHelp();
  else if (cmd == "status") printStatus();
  else if (cmd == "key") Serial.println(pubB58);
  else if (cmd == "save") { saveCfg(); Serial.println("saved"); }
  else if (cmd == "reboot") { Serial.println("rebooting"); delay(120); ESP.restart(); }
  else if (cmd == "factory") {
    prefs.begin("panic", false); prefs.clear(); prefs.end();
    Serial.println("cleared, rebooting"); delay(120); ESP.restart();
  }
  else if (cmd == "panic") fire();
  else if (cmd == "probe") probePanel();
  else if (cmd == "frame") drawFrame();
  else if (cmd == "test") {
    tft.ready = false;
    tft.configure();
    Serial.printf("display init: %s\n", tft.ready ? "ok" : "FAILED");
    if (tft.ready) {
      int W = tft.width(), H = tft.height();
      tft.fillRect(0, 0, W / 3, H, 0xF800);
      tft.fillRect(W / 3, 0, W / 3, H, 0x07E0);
      tft.fillRect(2 * W / 3, 0, W / 3, H, 0x001F);
      tft.setTextColor(0xFFFF, 0x0000);
      tft.setTextSize(2);
      tft.drawString("PANIC", 8, 8);
      tft.setTextSize(1);
      tft.drawString(String(W).c_str(), 8, H - 24);
    }
  } else if (cmd == "set") {
    int sp2 = rest.indexOf(' ');
    String key = sp2 < 0 ? rest : rest.substring(0, sp2);
    String value = sp2 < 0 ? "" : rest.substring(sp2 + 1);
    value.trim();
    if (key == "size") {
      int w, h;
      if (sscanf(value.c_str(), "%d %d", &w, &h) == 2) { cfg.w = w; cfg.h = h; Serial.println("size set"); }
    } else if (applySet(key, value)) {
      Serial.printf("%s set\n", key.c_str());
    } else {
      Serial.printf("unknown or malformed: %s\n", key.c_str());
    }
  } else {
    Serial.printf("unknown command: %s (try help)\n", cmd.c_str());
  }
}

static String serialBuf;

static void pollSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      handleLine(serialBuf);
      serialBuf = "";
    } else if (serialBuf.length() < 200) {
      serialBuf += c;
    }
  }
}

// ──────────────────────────────────────────────────────────────── setup ──

static void connectWifi() {
  if (!cfg.ssid.length()) {
    state = NO_WIFI;
    drawNoWifi();
    return;
  }
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  Serial.printf("wifi: joining %s", cfg.ssid.c_str());
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("wifi: %s\n", WiFi.localIP().toString().c_str());
    refreshQuotes();
    state = readCover() ? ARMED : READY;
    state == ARMED ? drawArmed() : drawReady();
  } else {
    state = OFFLINE;
    gNote = "no wifi";
    drawReady();
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("\npanic button - boot");

  loadCfg();
  initKeys();
  pinMode(cfg.pinPlunger >= 0 ? cfg.pinPlunger : 0, INPUT_PULLUP);
  if (cfg.pinCover >= 0) pinMode(cfg.pinCover, INPUT_PULLUP);

  tft.configure();
  Serial.printf("display: %s (%dx%d)\n", tft.ready ? "ok" : "FAILED", cfg.w, cfg.h);
  if (tft.ready) {
    chrome("BOOT", C_DIM);
    centre("PANIC BUTTON", 70, 2, C_INK);
    centre("every chain, one press", 100, 1, C_DIM);
  }
  coverOpen = readCover();
  connectWifi();
  printHelp();
  printStatus();
}

void loop() {
  pollSerial();
  pollButtons();

  static uint32_t lastPoll = 0;
  if (millis() - lastPoll > 60000) {
    lastPoll = millis();
    if (WiFi.status() != WL_CONNECTED) {
      WiFi.reconnect();
    } else if (!gFired && state != SIGNING) {
      refreshQuotes();
      state = readCover() ? ARMED : READY;
      state == ARMED ? drawArmed() : drawReady();
    }
  }
  delay(20);
}
