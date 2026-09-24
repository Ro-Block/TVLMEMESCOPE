// Types shared by the API server and the web UI.

export type Ecosystem = 'Ethereum' | 'Solana' | 'Hyperliquid' | 'BNB' | 'Base' | 'Robinhood' | 'Other';

/** Fixed order — colour slots are assigned by this order, never by rank. */
export const ECOSYSTEMS: Ecosystem[] = ['Ethereum', 'Solana', 'Hyperliquid', 'BNB', 'Base', 'Robinhood', 'Other'];

export type DataSource = 'live' | 'demo';
/** Live windows (5m / 1h / 6h) and trend windows (1d / 3d / 7d). */
export type FlowWindow = '5m' | '1h' | '6h' | '1d' | '3d' | '7d';
export const LIVE_WINDOWS: FlowWindow[] = ['5m', '1h', '6h'];
export const TREND_WINDOWS: FlowWindow[] = ['1d', '3d', '7d'];

export interface ChainNode {
  id: string;
  name: string;
  ticker?: string;
  ecosystem: Ecosystem;
  tvl: number;
  tvlChange7d: number | null; // fraction, 0.05 = +5%
  inflow: number; // USD bridged in during the window (observed routes)
  outflow: number; // USD bridged out during the window (observed routes)
  /**
   * Net liquidity for the window: stablecoin supply change for trend windows (captures every
   * bridge and mint), observed bridged in − out for live windows.
   */
  net: number;
  /** Stablecoins on the chain now (USD). */
  stablecoins: number | null;
  /** Stablecoin supply change over the window (trend windows only). */
  stableChange: number | null;
  /** DEX volume in the window. */
  dexVolume: number | null;
  /** Liquidity in the chain's most active DEX pools. */
  poolLiquidity: number | null;
}

export interface SourceStatus {
  name: string;
  ok: boolean;
  updatedAt: number | null;
  note?: string;
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
  totals: { tvl: number; bridged: number; stablecoins: number; dexVolume: number };
  /** Observed = real chain-pair volumes (Wormholescan). */
  routing: 'observed' | 'simulated';
  /** Window the routes cover (5m uses the latest hour: route data is hourly). */
  routesWindow: FlowWindow;
  sources: SourceStatus[];
  source: DataSource;
  updatedAt: number;
}

export interface ChainDetail {
  chain: ChainNode;
  tvlHistory: { t: number; v: number }[];
  flowHistory: { t: number; inflow: number; outflow: number }[];
  stableHistory: { t: number; v: number }[];
  dexHistory: { t: number; v: number }[];
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
  /** Token logo, when the source has one. */
  imageUrl?: string;
  /** Tried when `imageUrl` is missing or fails to load (DexScreener's image CDN). */
  imageFallbackUrl?: string;
  /** Launchpad that minted the token (pump.fun, four.meme, Clanker…), if recognised. */
  launchpad?: string;
  createdAt: number;
  priceUsd: number;
  mcap: number;
  liquidity: number;
  volume: { m5: number; h1: number; h6?: number; h24: number };
  txns: { h1: { buys: number; sells: number }; h24: { buys: number; sells: number } };
  change: { m5: number; h1: number; h24: number };
  trending: boolean;
  snipe?: LaunchSummary;
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

export type AlertKind = 'whale_buy' | 'cluster' | 'ring';

export interface Alert {
  id: string;
  ts: number;
  kind: AlertKind;
  chain: string;
  pair: { id: string; name: string; symbol: string; address: string; ageMin: number; mcap: number; liquidity: number; url: string; imageUrl?: string; launchpad?: string };
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
  /** A buy this many seconds (or fewer) after pair creation counts as a snipe. */
  sniperWindowSec: number;
  /** Keep sniper/bundler wallets out of smart-money alerts and columns. */
  excludeSnipers: boolean;
  /** Alert when members of a known sniper ring hit the same new pair. */
  ringAlerts: boolean;
  ringMinMembers: number;
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
  /** Live scanner progress (null on simulated data). */
  scanner: { cycles: number; lastCycleAt: number; pairsSeen: number; tradesSeen: number; errors: { at: number; msg: string }[] } | null;
}

// ---------- live flow events (solar map effects) ----------

export type FlowEventKind = 'super-comet' | 'supernova';

export interface FlowEvent {
  id: string;
  ts: number;
  kind: FlowEventKind;
  /** super-comet: the source chain; supernova: the chain liquidity is leaving. */
  chain: string;
  /** super-comet destination. Estimated when the source only reports one side. */
  to?: string;
  estimatedRoute?: boolean;
  usd: number;
  token?: string;
  bridge?: string;
  txHash?: string;
  message: string;
}

// ---------- snipers & bundles ----------

export interface LaunchSummary {
  snipers: number;
  bundled: number;
  /** Share of first-5-minute buy volume that came from snipers. */
  share: number;
  rings: number;
  dumped: boolean;
}

export interface SniperBuy {
  wallet: string;
  delaySec: number;
  block: number | null;
  usd: number;
  bundled: boolean;
  ringId?: string;
  /** Fraction of the bought tokens sold in the first hour. */
  soldPct: number;
  exitMin: number | null;
}

export interface Launch extends LaunchSummary {
  pair: Pair;
  launchBlock: number | null;
  sniperUsd: number;
  buys: SniperBuy[];
  ringIds: string[];
}

export type RingIntention = 'coordinated-dump' | 'coordinated-hold' | 'mixed';

export interface SniperProfile {
  wallet: string;
  chain: string;
  label?: string;
  launches: number;
  medianDelaySec: number;
  bundleRate: number;
  dumpRate: number;
  medianExitMin: number | null;
  avgUsd: number;
  roi: number | null;
  pnlUsd: number | null;
  ringId?: string;
  watched: boolean;
  lastSeen: number;
}

export interface SniperRing {
  id: string;
  name: string;
  chain: string;
  members: string[];
  sharedLaunches: number;
  sameBlockRate: number;
  /** Fraction of shared launches where members exited (or held) together. */
  cohesion: number;
  intention: RingIntention;
  medianExitSpreadMin: number | null;
  pnlUsd: number;
  lastSeen: number;
  recent: { pairId: string; symbol: string; ts: number }[];
}

export interface SniperLink {
  chain: string;
  a: string;
  b: string;
  shared: number;
  sameBlock: number;
  jaccard: number;
}

export interface SnipersResponse {
  windowSec: number;
  launches: Launch[];
  profiles: SniperProfile[];
  rings: SniperRing[];
  links: SniperLink[];
  watchlist: { chain: string; wallet: string; label?: string }[];
}

/** One buy/sell by a tracked wallet, streamed for the laser view. */
export interface Shot {
  id: string;
  ts: number;
  chain: string;
  wallet: string;
  kind: 'buy' | 'sell';
  usd: number;
  pairId: string;
  symbol: string;
  dex: string;
  token: string;
  imageUrl?: string;
  delaySec: number;
  sniper: boolean;
  ringId?: string;
}
