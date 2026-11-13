import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { randomUUID } from "node:crypto";

import { Policy, PanicRecord, Chain, Holding } from "./types.ts";
import {
  newChallenge,
  verifySignature,
  receiptHash,
  safeHash,
  b58decode,
} from "./crypto.ts";
import { buildQuotes, PROTOCOL_BPS } from "./quotes.ts";
import { priceMeta, refreshPrices } from "./prices.ts";
import { chainPortfolio } from "./near.ts";
import { readEvm, readSolana, readBitcoin, holdingsFromBalances } from "./chainreaders.ts";
import {
  appendPanic,
  getPanic,
  getPolicy,
  listPanics,
  lastPanicAt,
  savePolicy,
} from "./store.ts";

const here = dirname(fileURLToPath(import.meta.url));
const webDist = join(here, "..", "..", "web");

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

interface Pending {
  account: string;
  mode: "PANIC" | "DRILL";
  message: string;
  expiresAt: number;
}
const pending = new Map<string, Pending>();
const subscribers = new Set<(evt: unknown) => void>();

function broadcast(evt: unknown) {
  for (const send of subscribers) {
    try {
      send(evt);
    } catch {
      subscribers.delete(send);
    }
  }
}

function redactPolicy(p: Policy) {
  return { ...p, devicePubKey: p.devicePubKey.slice(0, 6) + "…" + p.devicePubKey.slice(-4) };
}

app.get("/api/health", async () => ({
  ok: true,
  service: "panic-button-relay",
  version: "1.0.0",
  uptimeSec: Math.round(process.uptime()),
}));

app.get("/api/state", async () => {
  const policy = getPolicy();
  await refreshPrices();
  return {
    policy: policy ? redactPolicy(policy) : null,
    policyFull: policy,
    prices: priceMeta(),
    feeModel: { protocolBps: PROTOCOL_BPS },
    panics: listPanics(10),
    now: new Date().toISOString(),
  };
});

app.get("/api/prices", async () => {
  await refreshPrices(true);
  return priceMeta();
});

app.get("/api/quotes", async (req) => {
  const q = req.query as { account?: string };
  const policy = getPolicy();
  if (!policy) return { error: "no policy registered" };
  if (q.account && q.account !== policy.account) return { error: "unknown account" };
  return buildQuotes(policy);
});

app.get("/api/portfolio", async (req) => {
  const q = req.query as { account?: string };
  const policy = getPolicy();
  const account = q.account ?? policy?.account;
  if (!account) return { error: "no account" };
  return chainPortfolio(account);
});

const CHAINS: Chain[] = ["near", "base", "arbitrum", "ethereum", "solana", "bitcoin"];

function parseHoldings(input: unknown): Holding[] {
  if (!Array.isArray(input)) return [];
  const out: Holding[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const h = raw as Record<string, unknown>;
    const chain = String(h.chain ?? "") as Chain;
    if (!CHAINS.includes(chain)) continue;
    const amount = Number(h.amount);
    if (!Number.isFinite(amount) || amount < 0) continue;
    out.push({
      chain,
      symbol: String(h.symbol ?? "TOKEN").toUpperCase(),
      assetId: String(h.assetId ?? ""),
      amount,
      decimals: Number(h.decimals ?? 18),
    });
  }
  return out;
}

app.post("/api/policy", async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const account = String(body.account ?? "").trim();
  const devicePubKey = String(body.devicePubKey ?? "").trim();
  const safe = (body.safe ?? {}) as Record<string, string>;
  const holdings = parseHoldings(body.holdings);

  if (!/^([a-z0-9._-]{2,64})(\.near|\.testnet|\.tg)$/.test(account)) {
    return reply.code(400).send({ error: "account must be a NEAR account id" });
  }
  try {
    if (b58decode(devicePubKey).length !== 32) throw new Error("len");
  } catch {
    return reply.code(400).send({ error: "devicePubKey must be base58 ed25519 (32 bytes)" });
  }
  if (typeof safe.near !== "string" || safe.near.length < 4) {
    return reply.code(400).send({ error: "safe.near required (destination NEAR account)" });
  }
  for (const c of CHAINS) {
    if (safe[c] !== undefined && typeof safe[c] !== "string") {
      return reply.code(400).send({ error: `safe.${c} must be a string` });
    }
  }

  const policy: Policy = {
    account,
    devicePubKey,
    safe: {
      near: safe.near,
      base: safe.base ?? "",
      arbitrum: safe.arbitrum ?? "",
      ethereum: safe.ethereum ?? "",
      solana: safe.solana ?? "",
      bitcoin: safe.bitcoin ?? "",
    },
    holdings,
    maxUsdPerPanic: Number(body.maxUsdPerPanic ?? 25_000),
    cooldownSec: Number(body.cooldownSec ?? 30),
    createdAt: new Date().toISOString(),
  };
  savePolicy(policy);
  broadcast({ type: "policy", account: policy.account, at: policy.createdAt });
  return { ok: true, policy: redactPolicy(policy), safeHash: safeHash(policy.safe) };
});

app.post("/api/challenge", async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const policy = getPolicy();
  if (!policy) return reply.code(409).send({ error: "no policy registered" });

  const mode = body.mode === "DRILL" ? "DRILL" : "PANIC";
  if (mode === "PANIC") {
    const since = (Date.now() - lastPanicAt(policy.account)) / 1000;
    if (since < policy.cooldownSec) {
      return reply.code(429).send({
        error: "cooldown",
        retryInSec: Math.ceil(policy.cooldownSec - since),
      });
    }
  }

  const ch = newChallenge(policy.account, policy.safe, mode);
  const id = randomUUID();
  pending.set(id, {
    account: ch.account,
    mode: ch.mode,
    message: ch.message,
    expiresAt: Date.now() + 5 * 60_000,
  });
  return {
    challengeId: id,
    mode: ch.mode,
    message: ch.message,
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    signWith: "ed25519 detached over UTF-8 bytes of `message`",
  };
});

app.post("/api/panic", async (req, reply) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const policy = getPolicy();
  if (!policy) return reply.code(409).send({ error: "no policy registered" });

  const id = String(body.challengeId ?? "");
  const sig = String(body.signature ?? "");
  const ch = pending.get(id);
  if (!ch) return reply.code(404).send({ error: "unknown challenge" });
  if (Date.now() > ch.expiresAt) {
    pending.delete(id);
    return reply.code(410).send({ error: "challenge expired" });
  }

  const ok = verifySignature(ch.message, sig, policy.devicePubKey);
  if (!ok) {
    pending.delete(id);
    const bad: PanicRecord = {
      id: randomUUID(),
      account: policy.account,
      mode: ch.mode,
      challenge: ch.message,
      signature: sig,
      devicePubKey: policy.devicePubKey,
      quotes: await buildQuotes(policy),
      receipt: "",
      createdAt: new Date().toISOString(),
      verdict: "REJECTED",
      reason: "signature does not match registered device key",
    };
    appendPanic(bad);
    broadcast({ type: "panic", panic: bad });
    return reply.code(401).send({ error: "invalid device signature", panicId: bad.id });
  }

  pending.delete(id);
  const quotes = await buildQuotes(policy);

  if (quotes.totals.valueUsd > policy.maxUsdPerPanic) {
    const blocked: PanicRecord = {
      id: randomUUID(),
      account: policy.account,
      mode: ch.mode,
      challenge: ch.message,
      signature: sig,
      devicePubKey: policy.devicePubKey,
      quotes,
      receipt: "",
      createdAt: new Date().toISOString(),
      verdict: "REJECTED",
      reason: `portfolio $${quotes.totals.valueUsd} exceeds cap $${policy.maxUsdPerPanic}`,
    };
    appendPanic(blocked);
    broadcast({ type: "panic", panic: blocked });
    return reply.code(402).send({ error: blocked.reason, panicId: blocked.id });
  }

  const panicId = randomUUID();
  const receipt = receiptHash([
    panicId,
    policy.account,
    ch.mode,
    quotes.totals.valueUsd,
    quotes.totals.netUsd,
    sig.slice(0, 32),
    ch.message,
  ]);

  const record: PanicRecord = {
    id: panicId,
    account: policy.account,
    mode: ch.mode,
    challenge: ch.message,
    signature: sig,
    devicePubKey: policy.devicePubKey,
    quotes,
    receipt,
    createdAt: new Date().toISOString(),
    verdict: "ARMED",
  };
  appendPanic(record);
  broadcast({ type: "panic", panic: record });
  return { ok: true, panic: record };
});

app.get("/api/panic/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const record = getPanic(id);
  if (!record) return reply.code(404).send({ error: "not found" });
  return record;
});

app.get("/api/panics", async (req) => {
  const q = req.query as { limit?: string };
  return listPanics(Number(q.limit ?? 50));
});

app.get("/api/feed", (req, reply) => {
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
  });
  reply.raw.write(`event: hello\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`);
  const send = (evt: unknown) => {
    reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
  };
  subscribers.add(send);
  req.raw.on("close", () => subscribers.delete(send));
});

app.post("/api/attach", async (req, reply) => {
  const policy = getPolicy();
  if (!policy) return reply.code(409).send({ error: "no policy registered" });
  const body = (req.body ?? {}) as { chain?: Chain; address?: string };
  const chain = body.chain;
  const address = String(body.address ?? "").trim();
  if (!chain || !CHAINS.includes(chain)) return reply.code(400).send({ error: "bad chain" });
  if (address.length < 20) return reply.code(400).send({ error: "bad address" });

  let read: { balances: Record<string, number | null> };
  if (chain === "base" || chain === "arbitrum" || chain === "ethereum") {
    read = await readEvm(chain, address);
  } else if (chain === "solana") {
    read = await readSolana(address);
  } else if (chain === "bitcoin") {
    read = await readBitcoin(address);
  } else {
    return reply.code(400).send({ error: "attach not supported for near (rename the account instead)" });
  }

  const fresh = holdingsFromBalances(chain, read.balances);
  policy.holdings = [...policy.holdings.filter((h) => h.chain !== chain), ...fresh];
  policy.safe[chain] = address;
  savePolicy(policy);
  broadcast({ type: "policy", account: policy.account, at: policy.createdAt });
  return { ok: true, chain, address, balances: read.balances, holdings: policy.holdings };
});

app.get("/api/device-profile", async () => {
  const policy = getPolicy();
  if (!policy) return { error: "no policy" };
  return {
    account: policy.account,
    devicePubKey: policy.devicePubKey,
    safeHash: safeHash(policy.safe),
    cap: policy.maxUsdPerPanic,
    cooldownSec: policy.cooldownSec,
  };
});

app.get("/api/device-key", async (req, reply) => {
  // DEMO ONLY: the browser signs on behalf of the device so the flow can be
  // shown without hardware. On real hardware the key never leaves the S3.
  if (process.env.DEMO !== "1") return reply.code(403).send({ error: "DEMO=1 not set" });
  const policy = getPolicy();
  if (!policy) return reply.code(409).send({ error: "no policy" });
  const { readFileSync } = await import("node:fs");
  const key = JSON.parse(readFileSync(join(process.cwd(), "data", "device-key.json"), "utf8"));
  return { publicKey: key.publicKey, secretKey: key.secretKey, warning: "demo key, browser-held" };
});

if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) return reply.code(404).send({ error: "not found" });
    return reply.sendFile("index.html");
  });
}

const port = Number(process.env.PORT ?? 8787);

// the address the device should be pointed at with `set relay`
function lanIP(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}
// 0.0.0.0 so the device on the LAN can reach the relay; set HOST=127.0.0.1 to
// keep it loopback-only when you are only using the browser console.
await app.listen({ port, host: process.env.HOST ?? "0.0.0.0" });
console.log(`panic-button relay on http://127.0.0.1:${port} (LAN: http://${lanIP()}:${port})`);
