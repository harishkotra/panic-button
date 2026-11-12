import { Holding } from "./types.ts";

const TOKENS_URL = "https://1click.chaindefuser.com/v0/tokens";
const TTL_MS = 60_000;

export interface TokenRow {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price: number;
  priceUpdatedAt: string;
}

interface Cache {
  at: number;
  rows: Map<string, TokenRow>;
  bySymbol: Map<string, TokenRow[]>;
  live: boolean;
  error?: string;
}

let cache: Cache = {
  at: 0,
  rows: new Map(),
  bySymbol: new Map(),
  live: false,
};

export async function refreshPrices(force = false): Promise<Cache> {
  if (!force && Date.now() - cache.at < TTL_MS && cache.rows.size) return cache;
  try {
    const res = await fetch(TOKENS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`tokens ${res.status}`);
    const rows = (await res.json()) as TokenRow[];
    const map = new Map<string, TokenRow>();
    const bySymbol = new Map<string, TokenRow[]>();
    for (const r of rows) {
      if (!r.assetId) continue;
      map.set(r.assetId, r);
      const key = r.symbol.toUpperCase();
      bySymbol.set(key, [...(bySymbol.get(key) ?? []), r]);
    }
    cache = { at: Date.now(), rows: map, bySymbol, live: true };
    return cache;
  } catch (err) {
    cache = {
      ...cache,
      live: false,
      error: err instanceof Error ? err.message : String(err),
    };
    return cache;
  }
}

export function priceFor(h: Holding): { usd: number; source: string } | null {
  const direct = cache.rows.get(h.assetId);
  if (direct && typeof direct.price === "number") {
    return { usd: direct.price, source: "1click:assetId" };
  }
  const sym = h.symbol.toUpperCase();
  const candidates = cache.bySymbol.get(sym) ?? [];
  const sameChain = candidates.find((c) => c.blockchain === h.chain);
  const pick = sameChain ?? candidates[0];
  if (pick && typeof pick.price === "number") {
    return { usd: pick.price, source: "1click:symbol" };
  }
  if (["USDC", "USDT", "DAI", "USDE"].includes(sym)) {
    return { usd: 1, source: "stable-peg" };
  }
  return null;
}

export function priceMeta() {
  return {
    live: cache.live,
    ageSec: cache.at ? Math.round((Date.now() - cache.at) / 1000) : null,
    tokens: cache.rows.size,
    error: cache.error,
    url: TOKENS_URL,
  };
}

export function assetRow(assetId: string): TokenRow | undefined {
  return cache.rows.get(assetId);
}
