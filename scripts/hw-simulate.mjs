#!/usr/bin/env node
// Replays exactly what the firmware does, over the same bytes:
//   register device pubkey -> GET challenge -> ed25519 sign UTF-8 message -> POST panic
//
// This exists so the protocol can be tested without a soldering iron. It is not
// hardware proof: the private key here is on the laptop, which is the opposite of
// what the device guarantees. See firmware/HARDWARE.md for the real run.
import nacl from "tweetnacl";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8787";
const ACCOUNT = process.env.ACCOUNT ?? "intents.near";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (bytes) => {
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
};

const kp = nacl.sign.keyPair();
const devicePubKey = b58(kp.publicKey);

const portfolio = await (await fetch(`${RELAY}/api/portfolio?account=${ACCOUNT}`)).json();
const b = portfolio.balances ?? {};
const holdings = [];
if (b.NEAR > 0) holdings.push({ chain: "near", symbol: "NEAR", assetId: "nep141:wrap.near", amount: b.NEAR, decimals: 24 });
if (b["USDC.e"] > 0)
  holdings.push({
    chain: "near",
    symbol: "USDC",
    assetId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    amount: b["USDC.e"],
    decimals: 6,
  });

const policy = await fetch(`${RELAY}/api/policy`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    account: ACCOUNT,
    devicePubKey,
    safe: { near: ACCOUNT, base: "", arbitrum: "", ethereum: "", solana: "", bitcoin: "" },
    holdings,
    maxUsdPerPanic: Number(process.env.CAP ?? 25000),
    cooldownSec: 0,
  }),
});
console.log("policy:", policy.status, "device key:", devicePubKey);

const ch = await (await fetch(`${RELAY}/api/challenge`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ mode: "PANIC" }),
})).json();
console.log("challenge:", ch.challengeId, "message bytes:", Buffer.byteLength(ch.message, "utf8"));

const sig = nacl.sign.detached(new TextEncoder().encode(ch.message), kp.secretKey);
const signature = Buffer.from(sig).toString("base64");

const res = await fetch(`${RELAY}/api/panic`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ challengeId: ch.challengeId, signature }),
});
const body = await res.json();
if (res.status === 200) {
  console.log("VERDICT: ESCAPED");
  console.log("  net:", body.panic.quotes.totals.netUsd, "of", body.panic.quotes.totals.valueUsd);
  console.log("  receipt:", body.panic.receipt);
  console.log("  legs:", body.panic.quotes.legs.length);
} else {
  console.log("VERDICT:", res.status === 402 ? "REFUSED" : "ERROR", res.status);
  console.log("  reason:", body.error);
}
