export interface Keypair {
  publicKey: string;
  secretKey: string;
}

export type Chain =
  | "near"
  | "base"
  | "arbitrum"
  | "ethereum"
  | "solana"
  | "bitcoin";

export interface Holding {
  chain: Chain;
  symbol: string;
  assetId: string; // 1Click asset id where one exists
  amount: number; // human units
  decimals: number;
  priced?: boolean; // false = price comes from the live feed or is treated as stable
}

export interface SafeMap {
  near: string;
  base: string;
  arbitrum: string;
  ethereum: string;
  solana: string;
  bitcoin: string;
  [chain: string]: string;
}

export interface Policy {
  account: string;
  devicePubKey: string; // base58 ed25519, 32 bytes
  safe: SafeMap;
  holdings: Holding[];
  maxUsdPerPanic: number;
  cooldownSec: number;
  createdAt: string;
}

export interface Leg {
  chain: Chain;
  symbol: string;
  amount: number;
  valueUsd: number;
  networkFeeUsd: number;
  protocolFeeUsd: number;
  slippageUsd: number;
  outSymbol: string;
  outAmount: number;
  etaSec: number;
  route: string;
  destination: string;
}

export interface QuoteSet {
  legs: Leg[];
  totals: {
    valueUsd: number;
    feeUsd: number;
    netUsd: number;
    effectiveBps: number;
    etaSec: number;
    chains: number;
  };
  priceSource: string;
  priceAgeSec: number;
  feeModel: {
    protocolBps: number;
    slippageBps: Record<string, number>;
    note: string;
  };
  generatedAt: string;
}

export interface PanicRecord {
  id: string;
  account: string;
  mode: "PANIC" | "DRILL";
  challenge: string;
  signature: string;
  devicePubKey: string;
  quotes: QuoteSet;
  receipt: string;
  createdAt: string;
  verdict: "ARMED" | "REJECTED";
  reason?: string;
}
