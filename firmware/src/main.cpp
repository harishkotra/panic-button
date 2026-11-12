/*
 * Panic Button — device firmware (YD-ESP32-S3 N16R8 + ILI9341 240x320)
 *
 * The device is deliberately dumb, because dumb is auditable:
 *   1. GET  /api/state    -> what is under watch, and the cap
 *   2. GET  /api/quotes   -> the escape legs, as they will land
 *   3. POST /api/challenge-> server-issued nonce bound to account+safe+mode
 *   4. sign the message with the ed25519 key in NVS
 *   5. POST /api/panic    -> { challengeId, signature } -> receipt
 *   6. draw the receipt on the screen and keep it there
 *
 * The private key never leaves the S3. There is no "cancel" endpoint and no
 * wallet approval to click: the signature is the authorisation. That is the
 * whole product. If the relay is compromised it can refuse to route, but it
 * cannot forge a panic for a device it does not hold.
 *
 * HW: red plunger on GPIO4 (INPUT_PULLUP, pressed = LOW)
 *     flip cover reed switch on GPIO5 (INPUT_PULLUP, closed cover = LOW)
 *     YOLO slider on GPIO6 (INPUT_PULLUP, closed = LOW)
 */

#include <Arduino.h>
#include <vector>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <TFT_eSPI.h>
#include <mbedtls/base64.h>
#include "ed25519.h"

/* ------------------------- configure me ------------------------- */
static const char *WIFI_SSID = "YOUR_SSID";
static const char *WIFI_PASS = "YOUR_PASS";
static const char *RELAY = "https://panic.example.com";  // no trailing slash
static const char *ACCOUNT = "harishkotra.near";          // the NEAR account being guarded

/* ------------------------- pins ------------------------- */
static const int PIN_PLUNGER = 4;
static const int PIN_COVER = 5;
static const int PIN_YOLO = 6;

static TFT_eSPI tft = TFT_eSPI();
static Preferences nvs;

static uint8_t seed[32];
static uint8_t pub[32];
static char pubB58[64];

/* ------------------------- base58 ------------------------- */
static const char *B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

static String b58encode(const uint8_t *in, size_t len) {
  size_t zeros = 0;
  while (zeros < len && in[zeros] == 0) zeros++;
  std::vector<uint8_t> b(in, in + len);
  String out;
  size_t start = zeros;
  while (start < b.size()) {
    int carry = 0;
    for (size_t i = start; i < b.size(); i++) {
      carry = carry * 256 + b[i];
      b[i] = carry / 58;
      carry %= 58;
    }
    out = String(B58[carry]) + out;
    while (start < b.size() && b[start] == 0) start++;
  }
  for (size_t i = 0; i < zeros; i++) out = "1" + out;
  return out;
}

static String b64(const uint8_t *in, size_t len) {
  size_t outLen = 0;
  uint8_t buf[128];
  if (mbedtls_base64_encode(buf, sizeof(buf), &outLen, in, len) != 0) return "";
  String s;
  for (size_t i = 0; i < outLen; i++) s += (char)buf[i];
  return s;
}

/* ------------------------- screen ------------------------- */
static void screen(const String &mode, const String &body, uint16_t colour = TFT_GREEN) {
  tft.fillRect(0, 34, 240, 280, TFT_BLACK);
  tft.setTextColor(colour, TFT_BLACK);
  tft.setTextSize(2);
  tft.setCursor(10, 40);
  tft.print(mode);
  tft.drawFastHLine(0, 66, 240, TFT_DARKGREY);
  tft.setTextSize(1);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.setCursor(10, 74);
  tft.print(body);
}

static void boot() {
  tft.init();
  tft.setRotation(0);
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_RED, TFT_BLACK);
  tft.setTextSize(3);
  tft.setCursor(10, 8);
  tft.print("PANIC");
  tft.setTextColor(TFT_LIGHTGREY, TFT_BLACK);
  tft.setTextSize(1);
  tft.setCursor(10, 40);
  tft.print("relay console v1.0");
}

/* ------------------------- http ------------------------- */
static bool httpJSON(const String &method, const String &path, const String &body, JsonDocument &doc, int &code) {
  WiFiClientSecure client;
  client.setInsecure();  // demo build: pin the relay cert before shipping
  HTTPClient http;
  http.setTimeout(12000);
  if (!http.begin(client, String(RELAY) + path)) return false;
  http.addHeader("content-type", "application/json");
  int status = (method == "POST") ? http.POST(body) : http.GET();
  code = status;
  if (status <= 0) {
    http.end();
    return false;
  }
  DeserializationError err = deserializeJson(doc, http.getString());
  http.end();
  return !err;
}

/* ------------------------- key ------------------------- */
static void loadKey() {
  nvs.begin("panic", false);
  size_t n = nvs.getBytesLength("seed");
  if (n == 32) {
    nvs.getBytes("seed", seed, 32);
  } else {
    esp_fill_random(seed, 32);
    nvs.putBytes("seed", seed, 32);
  }
  ed25519_create_keypair(pub, seed);
  strncpy(pubB58, b58encode(pub, 32).c_str(), sizeof(pubB58) - 1);
  nvs.end();
  Serial.printf("device pubkey: %s\n", pubB58);
  Serial.printf("register with: curl -X POST %s/api/policy -H 'content-type: application/json' "
                "-d '{\"account\":\"%s\",\"devicePubKey\":\"%s\",...}'\n", RELAY, ACCOUNT, pubB58);
}

/* ------------------------- panic ------------------------- */
static void fire(bool yolo) {
  screen("ARMING", "requesting challenge...", TFT_YELLOW);

  JsonDocument chReq;
  chReq["mode"] = "PANIC";
  String req;
  serializeJson(chReq, req);

  JsonDocument ch;
  int code = 0;
  if (!httpJSON("POST", "/api/challenge", req, ch, code)) {
    screen("FAULT", "challenge failed\ncheck wifi + relay");
    return;
  }
  const char *msg = ch["message"] | "";
  String id = ch["challengeId"] | "";
  if (!*msg || id.isEmpty()) {
    screen("FAULT", "relay returned no challenge");
    return;
  }

  screen("SIGNING", "ed25519 over challenge", TFT_YELLOW);
  uint8_t sig[64];
  uint8_t sk[64];
  memcpy(sk, seed, 32);
  memcpy(sk + 32, pub, 32);
  ed25519_sign(sig, (const uint8_t *)msg, strlen(msg), pub, sk);

  JsonDocument panicReq;
  panicReq["challengeId"] = id;
  panicReq["signature"] = b64(sig, 64);
  String body;
  serializeJson(panicReq, body);

  unsigned long t0 = millis();
  JsonDocument out;
  if (!httpJSON("POST", "/api/panic", body, out, code) || code != 200) {
    const char *err = out["error"] | "panic refused";
    screen("REFUSED", String(err) + "\nnothing moved.", TFT_RED);
    return;
  }

  JsonObject q = out["panic"]["quotes"].as<JsonObject>();
  JsonObject totals = q["totals"];
  float net = totals["netUsd"] | 0.0f;
  int legs = q["legs"].size();
  const char *receipt = out["panic"]["receipt"] | "";

  String lines = "";
  char buf[64];
  snprintf(buf, sizeof(buf), "escaped  %d legs\nnet      $%.0f\nfee      $%.0f\n", legs, net,
           (double)(totals["feeUsd"] | 0.0f));
  lines += buf;
  snprintf(buf, sizeof(buf), "in       %lums\n", millis() - t0);
  lines += buf;
  lines += "receipt  " + String(receipt).substring(0, 16) + "\n";
  if (yolo) lines += "\nYOLO: $1 to the dumbest\nthing on the board.\n";
  screen("ESCAPED", lines, TFT_GREEN);
  Serial.println(lines);
}

/* ------------------------- loop ------------------------- */
static bool lastPressed = false;
static unsigned long lastPoll = 0;

void setup() {
  Serial.begin(115200);
  pinMode(PIN_PLUNGER, INPUT_PULLUP);
  pinMode(PIN_COVER, INPUT_PULLUP);
  pinMode(PIN_YOLO, INPUT_PULLUP);
  boot();
  loadKey();

  screen("BOOT", String("wifi ") + WIFI_SSID);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 60 && WiFi.status() != WL_CONNECTED; i++) delay(500);

  if (WiFi.status() != WL_CONNECTED) {
    screen("OFFLINE", "no wifi\nlast panic still works\nif the relay is up", TFT_RED);
    return;
  }

  JsonDocument state;
  int code = 0;
  if (httpJSON("GET", "/api/state", "", state, code) && code == 200) {
    JsonObject p = state["policy"];
    String acct = p["account"] | "no policy";
    String body = "guarding " + acct + "\n";
    body += "device  " + String(pubB58).substring(0, 12) + "...\n";
    body += "ready. lift cover to arm.";
    screen("READY", body, TFT_GREEN);
  } else {
    screen("READY", "relay unreachable\npress still signs", TFT_YELLOW);
  }
}

void loop() {
  bool pressed = digitalRead(PIN_PLUNGER) == LOW;
  bool coverClosed = digitalRead(PIN_COVER) == LOW;
  bool yolo = digitalRead(PIN_YOLO) == LOW;

  if (pressed && !lastPressed) {
    if (coverClosed) {
      screen("GUARD", "cover is down.\nlift it first.", TFT_YELLOW);
    } else {
      fire(yolo);
    }
  }
  lastPressed = pressed;

  if (millis() - lastPoll > 60000 && WiFi.status() == WL_CONNECTED) {
    lastPoll = millis();
    JsonDocument q;
    int code = 0;
    if (httpJSON("GET", "/api/quotes", "", q, code) && code == 200) {
      char buf[96];
      snprintf(buf, sizeof(buf), "watch   $%.0f\nescape  $%.0f nets\n%d legs / %d chains",
               (double)(q["totals"]["valueUsd"] | 0.0f), (double)(q["totals"]["netUsd"] | 0.0f),
               q["legs"].size(), (int)(q["totals"]["chains"] | 0));
      screen("READY", buf, TFT_GREEN);
    }
  }
  delay(50);
}
