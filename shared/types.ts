// Types shared by the API server and the web UI.

export type Ecosystem = 'Ethereum' | 'Solana' | 'Hyperliquid' | 'BNB' | 'Base' | 'Robinhood' | 'Other';

/** Fixed order — colour slots are assigned by this order, never by rank. */
export const ECOSYSTEMS: Ecosystem[] = ['Ethereum', 'Solana', 'Hyperliquid', 'BNB', 'Base', 'Robinhood', 'Other'];

export type DataSource = 'live' | 'demo';
export type FlowWindow = '24h' | '7d' | '30d';

export interface ChainNode {
  id: string;
  name: string;
  ecosystem: Ecosystem;
  tvl: number;
  tvlChange7d: number | null; // fraction, 0.05 = +5%
  inflow: number; // USD bridged in during the window
  outflow: number; // USD bridged out during the window
  net: number; // inflow - outflow
}

export interface Flow {
  from: string;
  to: string;
  usd: number; // net USD moved from -> to over the window
}

export interface FlowsResponse {
  window: FlowWindow;
  chains: ChainNode[];
  flows: Flow[];
  totals: { tvl: number; bridged: number };
  /** Per-chain in/out totals are measured; the chain-to-chain routing is modelled. */
  routing: 'gravity-estimate' | 'simulated';
  source: DataSource;
  updatedAt: number;
}

export interface ChainDetail {
  chain: ChainNode;
  tvlHistory: { t: number; v: number }[];
  flowHistory: { t: number; inflow: number; outflow: number }[];
  counterparts: { chain: string; name: string; ecosystem: Ecosystem; toHere: number; fromHere: number }[];
  bridges: { name: string; volume: number }[];
  topTokens: { symbol: string; inUsd: number; outUsd: number }[];
  source: DataSource;
  updatedAt: number;
}

export interface Pair {
  id: string; // `${chain}:${address}`
  chain: string;
  address: string;
  dex: string;
  name: string;
  baseSymbol: string;
  baseAddress: string;
  quoteSymbol: string;
  createdAt: number;
  priceUsd: number;
  mcap: number;
  liquidity: number;
  volume: { m5: number; h1: number; h24: number };
  txns: { h1: { buys: number; sells: number }; h24: { buys: number; sells: number } };
  change: { m5: number; h1: number; h24: number };
  trending: boolean;
  smartWallets: { wallet: string; usd: number; tier: TraderTier }[];
  url: string;
}

export type TraderTier = 'whale' | 'smart' | 'watch' | 'none';
export type TraderSource = 'ledger' | 'dune' | 'hyperliquid' | 'manual';

export interface TraderStats {
  wallet: string;
  chain: string;
  label?: string;
  source: TraderSource;
  roi: number; // fraction, 1.5 = +150%
  pnlUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  investedUsd: number;
  trades: number;
  tokens: number;
  wins: number;
  winRate: number;
  medianHoldMin: number | null;
  lastActive: number;
  legitScore: number; // 0-100
  flags: string[];
  tier: TraderTier;
  watched: boolean;
}

export interface Position {
  token: string;
  symbol: string;
  pool: string;
  investedUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  openQty: number;
  firstBuy: number;
  lastTrade: number;
  trades: number;
}

export interface WalletDetail {
  stats: TraderStats | null;
  positions: Position[];
  recent: TradeRow[];
}

export interface TradeRow {
  chain: string;
  pool: string;
  tx: string;
  wallet: string;
  kind: 'buy' | 'sell';
  token: string;
  symbol: string;
  qty: number;
  usd: number;
  ts: number;
}

export type AlertKind = 'whale_buy' | 'cluster';

export interface Alert {
  id: string;
  ts: number;
  kind: AlertKind;
  chain: string;
  pair: { id: string; name: string; symbol: string; address: string; ageMin: number; mcap: number; liquidity: number; url: string };
  wallets: { wallet: string; usd: number; roi: number; legitScore: number; tier: TraderTier; label?: string }[];
  usd: number;
  message: string;
}

export interface AlertSettings {
  chains: string[];
  minBuyUsd: number;
  maxPairAgeHours: number;
  minRoi: number; // fraction
  minLegitScore: number;
  minTokens: number;
  clusterSize: number;
  clusterWindowMin: number;
  includeWatchlist: boolean;
  telegram: boolean;
  discord: boolean;
}

export interface MemeChain {
  id: string;
  name: string;
  ecosystem: Ecosystem;
}

export interface StatusResponse {
  flows: DataSource;
  memescope: DataSource;
  chains: MemeChain[];
  roiWindowDays: number;
  ledger: { trades: number; wallets: number; pools: number; oldest: number | null };
  sources: Record<string, { ok: boolean; lastError?: string; lastOk?: number }>;
  notify: { telegram: boolean; discord: boolean };
}
