import { Chain, Holding } from "./types.ts";

const EVM: Record<string, { rpc: string[]; usdc: string; native: string }> = {
  base: {
    rpc: ["https://mainnet.base.org", "https://base.publicnode.com"],
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    native: "ETH",
  },
  arbitrum: {
    rpc: ["https://arb1.arbitrum.io/rpc", "https://arbitrum.publicnode.com"],
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    native: "ETH",
  },
  ethereum: {
    rpc: ["https://eth.llamarpc.com", "https://cloudflare-eth.com"],
    usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    native: "ETH",
  },
};

async function evmCall(rpcList: string[], method: string, params: unknown[]): Promise<string | null> {
  for (const rpc of rpcList) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(9000),
      });
      const body = (await res.json()) as { result?: string };
      if (typeof body.result === "string") return body.result;
    } catch {
      continue;
    }
  }
  return null;
}

function padAddress(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export async function readEvm(chain: "base" | "arbitrum" | "ethereum", address: string) {
  const cfg = EVM[chain];
  const [nativeHex, usdcHex] = await Promise.all([
    evmCall(cfg.rpc, "eth_getBalance", [address, "latest"]),
    evmCall(cfg.rpc, "eth_call", [{ to: cfg.usdc, data: `0x70a08231${padAddress(address)}` }, "latest"]),
  ]);
  const native = nativeHex ? Number(BigInt(nativeHex)) / 1e18 : null;
  const usdc = usdcHex && usdcHex !== "0x" ? Number(BigInt(usdcHex)) / 1e6 : null;
  return { chain, address, balances: { [cfg.native]: native, USDC: usdc } };
}

export async function readSolana(address: string) {
  try {
    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] }),
      signal: AbortSignal.timeout(9000),
    });
    const body = (await res.json()) as { result?: { value: number } };
    return { chain: "solana" as Chain, address, balances: { SOL: (body.result?.value ?? 0) / 1e9 } };
  } catch {
    return { chain: "solana" as Chain, address, balances: { SOL: null as number | null } };
  }
}

export async function readBitcoin(address: string) {
  try {
    const res = await fetch(`https://mempool.space/api/address/${address}`, {
      signal: AbortSignal.timeout(9000),
    });
    const body = (await res.json()) as {
      chain_stats?: { funded_txo_sum: number; spent_txo_sum: number };
    };
    const s = body.chain_stats;
    const sats = s ? s.funded_txo_sum - s.spent_txo_sum : 0;
    return { chain: "bitcoin" as Chain, address, balances: { BTC: sats / 1e8 } };
  } catch {
    return { chain: "bitcoin" as Chain, address, balances: { BTC: null as number | null } };
  }
}

const NATIVE_ASSET: Record<string, { symbol: string; assetId: string; decimals: number }> = {
  ETH: { symbol: "ETH", assetId: "nep141:eth.omft.near", decimals: 18 },
  SOL: { symbol: "SOL", assetId: "nep141:sol.omft.near", decimals: 9 },
  BTC: { symbol: "BTC", assetId: "nep141:btc.omft.near", decimals: 8 },
};

export function holdingsFromBalances(
  chain: Chain,
  balances: Record<string, number | null>,
): Holding[] {
  const out: Holding[] = [];
  for (const [symbol, amount] of Object.entries(balances)) {
    if (!amount || amount <= 0) continue;
    const meta = NATIVE_ASSET[symbol] ?? { symbol, assetId: "", decimals: 6 };
    out.push({
      chain,
      symbol,
      assetId: meta.assetId,
      amount,
      decimals: meta.decimals,
    });
  }
  return out;
}
