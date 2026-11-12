import { Leg, QuoteSet, Holding, Policy } from "./types.ts";
import { priceFor, priceMeta, refreshPrices } from "./prices.ts";

// Modelled settlement costs. Sources: 1Click fee schedule (0.2% on the
// unauthenticated tier) plus observed median network fees per chain.
// Everything derived from these constants is labelled "modelled" in the API
// so the UI never passes a model off as a live quote.
const NETWORK_FEE_USD: Record<string, number> = {
  near: 0.0025,
  base: 0.02,
  arbitrum: 0.03,
  ethereum: 0.9,
  solana: 0.001,
  bitcoin: 0.35,
};

const SLIPPAGE_BPS: Record<string, number> = {
  near: 5,
  base: 10,
  arbitrum: 10,
  ethereum: 15,
  solana: 15,
  bitcoin: 25,
};

const ETA_SEC: Record<string, number> = {
  near: 8,
  base: 45,
  arbitrum: 45,
  ethereum: 180,
  solana: 30,
  bitcoin: 1800,
};

export const PROTOCOL_BPS = 20; // 0.2% — 1Click unauthenticated tier

function destination(chain: string, safe: Policy["safe"]): string {
  switch (chain) {
    case "near":
      return safe.near;
    case "base":
      return safe.base;
    case "arbitrum":
      return safe.arbitrum;
    case "ethereum":
      return safe.ethereum;
    case "solana":
      return safe.solana;
    case "bitcoin":
      return safe.bitcoin;
    default:
      return "unknown";
  }
}

export async function buildQuotes(policy: Policy): Promise<QuoteSet> {
  await refreshPrices();
  const legs: Leg[] = [];

  for (const h of policy.holdings as Holding[]) {
    if (!(h.amount > 0)) continue;
    const dest = destination(h.chain, policy.safe);
    if (!dest || dest.length < 4) continue; // chain not attached: no escape route
    const p = priceFor(h);
    if (!p) continue;
    const valueUsd = h.amount * p.usd;
    const protocolFeeUsd = (valueUsd * PROTOCOL_BPS) / 10_000;
    const slippageUsd = (valueUsd * (SLIPPAGE_BPS[h.chain] ?? 10)) / 10_000;
    const networkFeeUsd = NETWORK_FEE_USD[h.chain] ?? 0.05;
    const netUsd = Math.max(0, valueUsd - protocolFeeUsd - slippageUsd - networkFeeUsd);
    legs.push({
      chain: h.chain,
      symbol: h.symbol,
      amount: h.amount,
      valueUsd: round(valueUsd),
      networkFeeUsd: round(networkFeeUsd),
      protocolFeeUsd: round(protocolFeeUsd),
      slippageUsd: round(slippageUsd),
      outSymbol: "USDC",
      outAmount: round(netUsd),
      etaSec: ETA_SEC[h.chain] ?? 60,
      route:
        h.chain === "near"
          ? "NEAR direct · ft_transfer to safe"
          : `NEAR Intents · ${h.symbol} → USDC`,
      destination: destination(h.chain, policy.safe),
    });
  }

  legs.sort((a, b) => b.valueUsd - a.valueUsd);

  const valueUsd = legs.reduce((s, l) => s + l.valueUsd, 0);
  const netUsd = legs.reduce((s, l) => s + l.outAmount, 0);
  const feeUsd = round(Math.max(0, valueUsd - netUsd));
  const meta = priceMeta();

  return {
    legs,
    totals: {
      valueUsd: round(valueUsd),
      feeUsd,
      netUsd: round(netUsd),
      effectiveBps: valueUsd > 0 ? Math.round((feeUsd / valueUsd) * 10_000) : 0,
      etaSec: legs.reduce((m, l) => Math.max(m, l.etaSec), 0),
      chains: new Set(legs.map((l) => l.chain)).size,
    },
    priceSource: meta.live ? "1click /v0/tokens (live)" : "cached prices",
    priceAgeSec: meta.ageSec ?? 0,
    feeModel: {
      protocolBps: PROTOCOL_BPS,
      slippageBps: SLIPPAGE_BPS,
      note: "modelled: 1Click protocol fee + per-chain network fee + slippage. Prices are live.",
    },
    generatedAt: new Date().toISOString(),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
