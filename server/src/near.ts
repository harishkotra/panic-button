const RPC = "https://rpc.mainnet.near.org";

interface RpcResponse<T> {
  result?: T;
  error?: { cause?: { name?: string }; message?: string };
}

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(12_000),
  });
  const body = (await res.json()) as RpcResponse<T>;
  if (body.error || body.result === undefined) {
    throw new Error(body.error?.message ?? "rpc error");
  }
  return body.result;
}

export async function nearBalance(account: string): Promise<{ near: number; block: number }> {
  const out = await rpc<{ amount: string; block_height: number }>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: account,
  });
  return { near: Number(out.amount) / 1e24, block: out.block_height };
}

const FUNGIBLE: Record<string, { contract: string; decimals: number }> = {
  "USDC.e": { contract: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", decimals: 6 },
  USDT: { contract: "usdt.tether-token.near", decimals: 6 },
  wNEAR: { contract: "wrap.near", decimals: 24 },
};

export async function ftBalance(
  account: string,
  symbol: keyof typeof FUNGIBLE | string,
): Promise<number | null> {
  const meta = FUNGIBLE[symbol];
  if (!meta) return null;
  const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
  try {
    const out = await rpc<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "final",
      account_id: meta.contract,
      method_name: "ft_balance_of",
      args_base64: args,
    });
    const json = Buffer.from(out.result).toString("utf8");
    const parsed = JSON.parse(json) as string;
    return Number(parsed) / 10 ** meta.decimals;
  } catch {
    return null;
  }
}

export async function chainPortfolio(account: string) {
  const [bal, usdc, usdt, wnear] = await Promise.all([
    nearBalance(account).catch(() => null),
    ftBalance(account, "USDC.e"),
    ftBalance(account, "USDT"),
    ftBalance(account, "wNEAR"),
  ]);
  return {
    account,
    source: "NEAR mainnet RPC (read-only)",
    block: bal?.block ?? null,
    balances: {
      NEAR: bal?.near ?? null,
      "USDC.e": usdc,
      USDT: usdt,
      wNEAR: wnear,
    },
  };
}
