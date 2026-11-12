#!/usr/bin/env node
// Acts as the device: requests a challenge, signs it with the registered
// ed25519 key, and fires the panic. This is the same three calls the firmware
// makes over HTTPS.
import nacl from "tweetnacl";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RELAY = process.env.RELAY ?? "http://127.0.0.1:8787";
const MODE = process.env.MODE === "PANIC" ? "PANIC" : "DRILL";
const key = JSON.parse(readFileSync(join(process.cwd(), "data", "device-key.json"), "utf8"));
const secret = new Uint8Array(Buffer.from(key.secretKey, "base64"));

async function post(path, body) {
  const res = await fetch(`${RELAY}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const t0 = Date.now();
const ch = await post("/api/challenge", { mode: MODE });
if (ch.status !== 200) {
  console.error("challenge failed", ch.status, ch.body);
  process.exit(1);
}

const sig = nacl.sign.detached(new TextEncoder().encode(ch.body.message), secret);
const signature = Buffer.from(sig).toString("base64");

const out = await post("/api/panic", { challengeId: ch.body.challengeId, signature });
if (out.status !== 200) {
  console.error("panic rejected", out.status, JSON.stringify(out.body, null, 2));
  process.exit(1);
}

const p = out.body.panic;
const q = p.quotes;
console.log(`mode      ${p.mode}`);
console.log(`account   ${p.account}`);
console.log(`verdict   ${p.verdict}`);
console.log(`receipt   ${p.receipt}`);
console.log(`prices    ${q.priceSource} (${q.priceAgeSec}s old)`);
console.log(`fees      ${q.feeModel}`);
console.log("");
console.log("legs");
for (const l of q.legs) {
  console.log(
    `  ${l.chain.padEnd(9)} ${String(l.amount).padStart(12)} ${l.symbol.padEnd(6)} -> $${l.outAmount} USDC  fee $${(l.networkFeeUsd + l.protocolFeeUsd + l.slippageUsd).toFixed(2)}  ${l.etaSec}s  ${l.route}`,
  );
}
console.log("");
console.log(`value     $${q.totals.valueUsd}`);
console.log(`net       $${q.totals.netUsd}`);
console.log(`cost      $${q.totals.feeUsd} (${q.totals.effectiveBps} bps)`);
console.log(`eta       ${q.totals.etaSec}s across ${q.totals.chains} chain(s)`);
console.log(`wall      ${Date.now() - t0}ms`);
