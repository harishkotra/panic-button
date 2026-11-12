/* Panic Button relay console.
   Every number on this page comes from the relay: /api/state (policy, receipts,
   price age) and /api/quotes (the escape set). The screen block mirrors what the
   firmware prints, and the plunger runs the exact three calls the device makes:
   challenge -> ed25519 sign -> panic. */

const $ = (id) => document.getElementById(id);
const CHAIN_LABEL = { near: "NEAR", base: "Base", arbitrum: "Arbitrum", ethereum: "Ethereum", solana: "Solana", bitcoin: "Bitcoin" };

let state = null;
let quotes = null;
let deviceKey = null;
let busy = false;

/* ---------------- formatting ---------------- */
const usd0 = (n) => "$" + Math.round(n).toLocaleString("en-US");
function usdCompact(n) {
  if (!Number.isFinite(n)) return "$—";
  const a = Math.abs(n);
  if (a >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k";
  return "$" + n.toFixed(2);
}
function tok(n) {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(3);
  if (n >= 0.0001) return n.toFixed(6);
  return n.toExponential(2);
}
const money = (n) => (Number.isFinite(n) ? "$" + n.toFixed(2) : "—");

/* ---------------- small helpers ---------------- */
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3800);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, body };
}

/* ---------------- the screen ---------------- */
function screen(html, mode, opts = {}) {
  $("screenBody").innerHTML = html;
  $("screenMode").textContent = mode;
  $("screenRec").textContent = opts.rec ?? "LIVE";
  $("screenRec").style.color = opts.recColor ?? "";
  $("screenLeft").textContent = opts.left ?? "ed25519";
  $("screenRight").textContent = opts.right ?? "";
}

function screenIdle() {
  if (!quotes) return screen("no policy registered<br /><span class='dim'>run: node scripts/init-demo.mjs</span>", "EMPTY");
  const t = quotes.totals;
  screen(
    `<span class="dim">under watch</span>` +
      `<span class="big">${usdCompact(t.valueUsd)}</span>` +
      `${quotes.legs.length} legs · ${t.chains} chains<br />` +
      `<span class="dim">---</span><br />` +
      `escape nets<br /><span class="big">${usdCompact(t.netUsd)}</span>` +
      `<span class="dim">cost ${usdCompact(t.feeUsd)} · ${t.effectiveBps} bps</span>`,
    "READY",
    { right: `${t.etaSec}s` },
  );
}

/* ---------------- renderers ---------------- */
function renderQuotes(q) {
  if (!q || q.error) return;
  quotes = q;
  const t = q.totals;
  $("netUsd").textContent = usdCompact(t.netUsd);
  $("grossUsd").textContent = usdCompact(t.valueUsd);
  $("feeUsd").textContent = `−${usdCompact(t.feeUsd)} to escape`;
  $("figCap").textContent = `survives as USDC in ${q.account ?? "the safe account"}`;

  const body = $("legsBody");
  body.innerHTML = "";
  for (const l of q.legs) {
    const tr = document.createElement("tr");
    tr.innerHTML =
      `<td class="chain">${CHAIN_LABEL[l.chain] ?? l.chain}</td>` +
      `<td><span class="amt">${tok(l.amount)}</span> <span class="sym">${l.symbol}</span></td>` +
      `<td class="num">${usd0(l.amountUsd ?? l.valueUsd ?? 0)}</td>` +
      `<td class="num">${usd0(l.outAmount)} USDC</td>` +
      `<td class="num">${money(l.networkFeeUsd + l.protocolFeeUsd + l.slippageUsd)}</td>` +
      `<td class="num">${l.etaSec}s</td>`;
    tr.title = l.route;
    body.appendChild(tr);
  }

  $("totals").innerHTML =
    `<span>legs <b>${q.legs.length}</b></span>` +
    `<span>chains <b>${t.chains}</b></span>` +
    `<span>slowest <b>${t.etaSec}s</b></span>` +
    `<span>cost <b>${t.effectiveBps} bps</b></span>` +
    `<span>priced <b>${q.priceSource}</b>${q.priceAgeSec != null ? ` (${q.priceAgeSec}s)` : ""}</span>`;

  $("feeNote").innerHTML =
    `Costs are modelled from per-chain network fees, ${(q.feeModel?.slippageBps ?? 100) / 100}% slippage and the ` +
    `${(q.feeModel?.protocolBps ?? 20) / 100}% 1Click protocol fee. Prices are live from the 1Click token list — ` +
    `the <b>priced</b> stamp says how fresh.`;
  $("stageStamp").textContent = `quotes · ${new Date().toLocaleTimeString("en-GB")}`;
  if ($("screenMode").textContent === "READY" || $("screenMode").textContent === "EMPTY") screenIdle();
}

function renderHoldings(p) {
  const rows = [];
  for (const h of p.holdings) {
    rows.push({
      chain: h.chain,
      symbol: h.symbol,
      amount: h.amount,
    });
  }
  const tb = $("holdings").querySelector("tbody");
  if (!rows.length) {
    tb.innerHTML = `<tr><td class="muted" colspan="2">nothing attached</td></tr>`;
    return;
  }
  tb.innerHTML = rows
    .map(
      (r) =>
        `<tr><td><span class="chain-tag">${CHAIN_LABEL[r.chain] ?? r.chain}</span> ${r.symbol}</td>` +
        `<td class="num">${tok(r.amount)}</td></tr>`,
    )
    .join("");
}

function renderPolicy(p) {
  if (!p) {
    $("facts").innerHTML = `<dt>status</dt><dd>none</dd>`;
    return;
  }
  $("deviceKey").textContent = "device key " + p.devicePubKey;
  $("relayHost").textContent = location.host;
  const attached = Object.entries(p.safe).filter(([c, v]) => c !== "near" && typeof v === "string" && v.length > 6);
  $("facts").innerHTML =
    `<dt>account</dt><dd>${p.account}</dd>` +
    `<dt>cap / panic</dt><dd>${usd0(p.maxUsdPerPanic)}</dd>` +
    `<dt>cooldown</dt><dd>${p.cooldownSec}s</dd>` +
    `<dt>legs</dt><dd>${p.holdings.length}</dd>` +
    `<dt>attached</dt><dd>${attached.length ? attached.map(([c]) => CHAIN_LABEL[c]).join(", ") : "NEAR only"}</dd>` +
    `<dt>safe hash</dt><dd>${(p.safeHash ?? "").slice(0, 10)}…</dd>`;
}

function renderLog(panics) {
  const el = $("log");
  if (!panics || !panics.length) {
    el.innerHTML = `<li class="empty">no panics yet</li>`;
    return;
  }
  el.innerHTML = panics
    .slice(0, 6)
    .map((p) => {
      const t = new Date(p.at ?? p.createdAt ?? Date.now());
      const hh = t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      const cls = p.verdict === "REFUSED" ? "no" : "ok";
      const net = p.quotes?.totals?.netUsd;
      return `<li><span class="t">${hh}</span><span class="v"><span class="${cls}">${p.mode}</span> ${p.receipt?.slice(0, 8) ?? ""} ${net ? usdCompact(net) : ""}</span></li>`;
    })
    .join("");
}

/* ---------------- the button ---------------- */
async function getDeviceKey() {
  if (deviceKey) return deviceKey;
  const r = await api("/api/device-key");
  if (r.status !== 200) throw new Error("relay is not in DEMO mode, cannot sign from the browser");
  deviceKey = r.body;
  return deviceKey;
}

async function fire(mode = "PANIC") {
  if (busy) return;
  busy = true;
  const btn = $("plunger");
  btn.classList.add("pressed");
  btn.disabled = true;
  $("plungerSub").textContent = "signing";
  screen(`arming…<br /><span class="dim">requesting challenge</span>`, "ARMING", { rec: "WAIT" });

  try {
    const ch = await api("/api/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    if (ch.status !== 200) throw new Error(ch.body.error ?? "challenge failed");

    const key = await getDeviceKey();
    const secret = Uint8Array.from(atob(key.secretKey), (c) => c.charCodeAt(0));
    const sig = nacl.sign.detached(new TextEncoder().encode(ch.body.message), secret);
    const signature = btoa(String.fromCharCode(...sig));

    screen(
      `challenge ok<br /><span class="dim">${ch.body.message.split("\n")[2] ?? ""}</span><br /><br />signing on device…`,
      "SIGNING",
      { rec: "SIGN" },
    );

    const t0 = performance.now();
    const out = await api("/api/panic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: ch.body.challengeId, signature }),
    });
    const wall = Math.round(performance.now() - t0);

    if (out.status !== 200) {
      screen(`<span class="bad">REFUSED</span><br />${out.body.error ?? "rejected"}<br /><br /><span class="dim">nothing moved.</span>`, "REFUSED", {
        rec: "HOLD",
        recColor: "#ff6b6b",
      });
      toast("refused: " + (out.body.error ?? "rejected"));
      return;
    }

    const p = out.body.panic;
    const q = p.quotes;
    // walk the routes on screen the way the firmware prints them
    screen(`<span class="dim">routing ${q.legs.length} legs…</span>\n`, "ESCAPING", { rec: "LIVE" });
    for (const l of q.legs) {
      await new Promise((r) => setTimeout(r, 190));
      $("screenBody").insertAdjacentHTML(
        "beforeend",
        `${String(l.symbol).padEnd(6)} ${usd0(l.outAmount).padStart(9)} <span class="dim">${CHAIN_LABEL[l.chain] ?? l.chain}</span>\n`,
      );
    }

    screen(
      `<span class="dim">escaped in ${q.totals.etaSec}s</span>` +
        `<span class="big">${usdCompact(q.totals.netUsd)}</span>` +
        `<span class="dim">usdc, safe account</span><br />` +
        `cost ${usdCompact(q.totals.feeUsd)}<br />` +
        `receipt ${p.receipt.slice(0, 10)}<br />` +
        `<span class="dim">${wall}ms relay round trip</span>`,
      mode === "DRILL" ? "DRILLED" : "ESCAPED",
      { rec: "DONE", right: `${q.totals.etaSec}s` },
    );
    toast(`${mode === "DRILL" ? "drill" : "escape"} recorded · receipt ${p.receipt.slice(0, 8)}`);
    await refresh();
  } catch (err) {
    screen(`<span class="bad">FAULT</span><br />${err.message}<br /><br /><span class="dim">is the relay running?</span>`, "FAULT", {
      rec: "HOLD",
      recColor: "#ff6b6b",
    });
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove("pressed");
    $("plungerSub").textContent = "press";
    busy = false;
  }
}

/* ---------------- boot ---------------- */
async function refresh() {
  const [s, q] = await Promise.all([api("/api/state"), api("/api/quotes")]);
  state = s.body;
  if (state?.policy) {
    renderPolicy(state.policy);
    renderHoldings(state.policy);
  }
  renderLog(state?.panics);
  if (state?.prices) $("priceStamp").textContent = `prices ${state.prices.source ?? "1click"} · ${state.prices.ageSec ?? 0}s`;
  if (q.body && !q.body.error) renderQuotes(q.body);
}

function connectFeed() {
  try {
    const es = new EventSource("/api/feed");
    es.onopen = () => $("feedDot").classList.add("live");
    es.onerror = () => $("feedDot").classList.remove("live");
    es.onmessage = () => refresh();
  } catch {
    /* polling below covers it */
  }
  setInterval(refresh, 30000);
}

$("plunger").addEventListener("click", () => fire("PANIC"));
$("drillBtn").addEventListener("click", () => fire("DRILL"));

$("cover").addEventListener("click", (e) => {
  e.stopPropagation();
  const cover = $("cover");
  const up = cover.classList.toggle("up");
  cover.setAttribute("aria-expanded", String(up));
  $("coverSub").textContent = up ? "guard up" : "guard down";
  if (up) {
    screen(
      `<span class="warn">GUARD UP</span><br /><span class="dim">escape still lands everything as USDC.</span><br /><br />` +
        `$1 of it goes to the dumbest trending token on the board.<br /><br />` +
        `<span class="dim">you did this. it is your money.</span>`,
      "YOLO",
      { rec: "ARMED" },
    );
  } else {
    screenIdle();
  }
});

$("attachForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const chain = $("attachChain").value;
  const address = $("attachAddr").value.trim();
  if (address.length < 20) return toast("paste a full address first");
  $("attachBtn").disabled = true;
  $("attachBtn").textContent = "reading chain…";
  const r = await api("/api/attach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chain, address }),
  });
  $("attachBtn").disabled = false;
  $("attachBtn").textContent = "attach read-only address";
  if (r.status !== 200) return toast(r.body.error ?? "attach failed");
  $("attachAddr").value = "";
  toast(`${CHAIN_LABEL[chain]} attached · ${Object.entries(r.body.balances).map(([k, v]) => `${tok(v ?? 0)} ${k}`).join(" · ")}`);
  await refresh();
});

refresh().then(connectFeed);
