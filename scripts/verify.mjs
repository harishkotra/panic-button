#!/usr/bin/env node
/**
 * Panic Button — end-to-end verification.
 *
 *   node scripts/verify.mjs            # spawns its own relay on port 8899
 *   BASE=http://127.0.0.1:8787 node scripts/verify.mjs   # test a running relay
 *
 * Prints one PASS/FAIL line per check and exits non-zero if anything failed.
 * No network access to third-party chains is required: balances come from the
 * policy, prices from the 1Click token list (falls back to the bundled snapshot).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";

const PORT = 8899;
const OWN_SERVER = !process.env.BASE;
const BASE = process.env.BASE ?? `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), "panic-verify-"));

/* ---------- base58 (no dependency) ---------- */
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (const d of digits) out = ALPHA[d] + out;
  for (const byte of bytes) {
    if (byte === 0) out = "1" + out;
    else break;
  }
  return out;
}

/* ---------- tiny test harness ---------- */
let pass = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${detail ? "  ·  " + detail : ""}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? "  ·  " + detail : ""}`);
  }
}
const post = async (path, body) => {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, body: json };
};
const get = async (path) => {
  const r = await fetch(BASE + path);
  let json = null;
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, body: json };
};
const waitHealthy = async (tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await get("/api/health");
      if (r.status === 200) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
};

/* ---------- device key + policy ---------- */
const kp = nacl.sign.keyPair();
const devicePubKey = b58encode(kp.publicKey);
const sign = (msg) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(msg), kp.secretKey)).toString("base64");

const policy = {
  account: "verify-demo.near",
  devicePubKey,
  safe: {
    near: "safe-verify.near",
    base: "0x2527d02599ba641c19fea793cd0f167589a0f10d",
    arbitrum: "",
    ethereum: "",
    solana: "",
    bitcoin: "",
  },
  holdings: [
    { chain: "near", symbol: "NEAR", assetId: "nep141:wrap.near", amount: 120, decimals: 24 },
    { chain: "base", symbol: "USDC", assetId: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near", amount: 2500, decimals: 6 },
  ],
  maxUsdPerPanic: 1_000_000,
  cooldownSec: 0,
};

/* ---------- boot ---------- */
console.log(`Panic Button verification · relay ${BASE}${OWN_SERVER ? " (spawned)" : " (external)"}`);
let child = null;
if (OWN_SERVER) {
  child = spawn("node", ["--import", "tsx", "server/src/index.ts"], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEMO: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (d) => process.env.VERBOSE && process.stderr.write(d));
}

const cleanup = () => {
  if (child && !child.killed) child.kill("SIGTERM");
  try {
    rmSync(DATA, { recursive: true, force: true });
  } catch {}
};

try {
  if (!(await waitHealthy())) throw new Error(`relay did not become healthy on ${BASE}`);

  /* 1 — health */
  const health = await get("/api/health");
  check("relay answers /api/health", health.status === 200, `status ${health.status}`);

  /* 2 — policy validation */
  const badAccount = await post("/api/policy", { ...policy, account: "not an account" });
  check("rejects a non-NEAR account id", badAccount.status === 400, `status ${badAccount.status}`);

  const badKey = await post("/api/policy", { ...policy, devicePubKey: "AAAA" });
  check("rejects a malformed device key", badKey.status === 400, `status ${badKey.status}`);

  const saved = await post("/api/policy", policy);
  check(
    "registers a policy and returns its safe hash",
    saved.status === 200 && saved.body?.ok === true && /^[0-9a-f]{64}$/.test(saved.body?.safeHash ?? ""),
    `status ${saved.status}`,
  );

  /* 3 — quotes */
  const q = await get("/api/quotes");
  const legs = q.body?.legs ?? [];
  const allUsdc = legs.length > 0 && legs.every((l) => l.outSymbol === "USDC");
  const netsound = q.body?.totals?.netUsd > 0 && q.body.totals.netUsd < q.body.totals.valueUsd;
  check("quotes every attached holding", q.status === 200 && legs.length === 2, `${legs.length} legs`);
  check("every leg lands as USDC", allUsdc, legs.map((l) => `${l.symbol}→${l.outSymbol}`).join(", "));
  check("net proceeds are below gross", netsound, `net $${q.body?.totals?.netUsd} of $${q.body?.totals?.valueUsd}`);
  check(
    "cost breakdown is populated",
    q.body?.totals?.feeUsd > 0 && q.body?.totals?.effectiveBps > 0 && q.body?.feeModel?.protocolBps === 20,
    `${q.body?.totals?.effectiveBps} bps`,
  );

  /* 4 — a bad signature must not arm anything */
  const chBad = await post("/api/challenge", { mode: "PANIC" });
  const badSig = await post("/api/panic", { challengeId: chBad.body?.challengeId, signature: "AAAA" });
  check("rejects a forged device signature", badSig.status === 401, `status ${badSig.status}`);

  /* 5 — the real thing */
  const ch = await post("/api/challenge", { mode: "PANIC" });
  const msg = ch.body?.message ?? "";
  check(
    "issue a challenge bound to account, mode and safe hash",
    ch.status === 200 && msg.includes("account:verify-demo.near") && msg.includes("mode:PANIC") && /safe:[0-9a-f]{64}/.test(msg),
    msg.split("\n")[0],
  );

  const armed = await post("/api/panic", { challengeId: ch.body.challengeId, signature: sign(msg) });
  const rec = armed.body?.panic;
  check("arm a signed panic", armed.status === 200 && rec?.verdict === "ARMED", `status ${armed.status}`);
  check("mint a 64-hex receipt", /^[0-9a-f]{64}$/.test(rec?.receipt ?? ""), (rec?.receipt ?? "").slice(0, 16) + "…");
  check(
    "receipt carries the escaped amounts",
    rec?.quotes?.totals?.netUsd > 0 && rec?.quotes?.legs?.length === 2,
    `net $${rec?.quotes?.totals?.netUsd}`,
  );

  /* 6 — replay */
  const replay = await post("/api/panic", { challengeId: ch.body.challengeId, signature: sign(msg) });
  check("refuses a replayed challenge", replay.status === 404, `status ${replay.status}`);

  /* 7 — the cap is a real ceiling */
  const capped = await post("/api/policy", { ...policy, maxUsdPerPanic: 1 });
  const ch2 = await post("/api/challenge", { mode: "PANIC" });
  const blocked = await post("/api/panic", { challengeId: ch2.body?.challengeId, signature: sign(ch2.body?.message ?? "") });
  check(
    "refuses a panic above the per-panic cap",
    capped.status === 200 && blocked.status === 402,
    `status ${blocked.status}`,
  );

  /* 8 — receipts are readable afterwards */
  const state = await get("/api/state");
  const kinds = (state.body?.panics ?? []).map((p) => p.verdict);
  check(
    "state exposes the receipt trail",
    kinds.includes("ARMED") && kinds.includes("REJECTED"),
    kinds.join(" → "),
  );
} catch (err) {
  failures.push("harness");
  console.log("FAIL  harness  ·  " + err.message);
} finally {
  cleanup();
}

const total = pass + failures.length;
console.log(`\nRESULT: ${pass}/${total} checks passed${failures.length ? " · failed: " + failures.join(", ") : ""}`);
process.exit(failures.length ? 1 : 0);
