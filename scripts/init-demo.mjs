#!/usr/bin/env node
// Registers the demo policy: a real NEAR account, a real ed25519 device key,
// and the holdings the relay can actually read onchain.
import nacl from "tweetnacl";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8787";
const ACCOUNT = process.env.ACCOUNT ?? "harishkotra.near";
const KEYFILE = join(process.cwd(), "data", "device-key.json");

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  return "1".repeat(zeros) + digits.reverse().map((d) => B58[d]).join("");
}

function loadOrCreateKey() {
  if (existsSync(KEYFILE)) return JSON.parse(readFileSync(KEYFILE, "utf8"));
  const kp = nacl.sign.keyPair();
  const out = {
    publicKey: b58encode(kp.publicKey),
    secretKey: Buffer.from(kp.secretKey).toString("base64"),
  };
  mkdirSync(dirname(KEYFILE), { recursive: true });
  writeFileSync(KEYFILE, JSON.stringify(out, null, 2));
  return out;
}

const key = process.env.DEVICE_PUBKEY
  ? { publicKey: process.env.DEVICE_PUBKEY.trim(), secretKey: "" }
  : loadOrCreateKey();
if (process.env.DEVICE_PUBKEY) {
  console.log("registering hardware device key:", key.publicKey, "(no secret on this machine)");
}

const portfolio = await (await fetch(`${RELAY}/api/portfolio?account=${ACCOUNT}`)).json();
const b = portfolio.balances ?? {};
const holdings = [];
if (b.NEAR > 0) holdings.push({ chain: "near", symbol: "NEAR", assetId: "nep141:wrap.near", amount: b.NEAR, decimals: 24 });
if (b["USDC.e"] > 0) holdings.push({ chain: "near", symbol: "USDC", assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", amount: b["USDC.e"], decimals: 6 });
if (b.USDT > 0) holdings.push({ chain: "near", symbol: "USDT", assetId: "nep141:usdt.tether-token.near", amount: b.USDT, decimals: 6 });
if (b.wNEAR > 0) holdings.push({ chain: "near", symbol: "wNEAR", assetId: "nep141:wrap.near", amount: b.wNEAR, decimals: 24 });

const safe = {
  near: ACCOUNT,
  base: process.env.SAFE_BASE ?? "",
  arbitrum: process.env.SAFE_ARB ?? "",
  ethereum: process.env.SAFE_ETH ?? "",
  solana: process.env.SAFE_SOL ?? "",
  bitcoin: process.env.SAFE_BTC ?? "",
};

const res = await fetch(`${RELAY}/api/policy`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    account: ACCOUNT,
    devicePubKey: key.publicKey,
    safe,
    holdings,
    maxUsdPerPanic: Number(process.env.CAP ?? 25000),
    cooldownSec: Number(process.env.COOLDOWN ?? 30),
  }),
});
const body = await res.json();
console.log("policy:", res.status, JSON.stringify(body, null, 2));
console.log("device key:", key.publicKey);
console.log("onchain balances:", JSON.stringify(b));
