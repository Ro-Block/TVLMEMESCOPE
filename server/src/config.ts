import type { AlertSettings, Ecosystem, MemeChain } from '../../shared/types.ts';

const env = process.env;

export type DataMode = 'live' | 'demo' | 'auto';
export const DATA_MODE = (env.DATA_MODE ?? 'auto') as DataMode;
export const PORT = Number(env.PORT ?? 8787);
export const ROI_WINDOW_DAYS = Number(env.ROI_WINDOW_DAYS ?? 60);
export const DB_PATH = env.DB_PATH ?? 'data/tvlmemescope.db';

export interface ChainMeta {
  id: string;
  name: string;
  ecosystem: Ecosystem;
  /** Names DefiLlama uses for this chain (TVL and bridge endpoints differ in places). */
  llama: string[];
  /** Native token ticker, shown next to the name. */
  ticker?: string;
  /** DefiLlama protocol slug to fall back on when the chain isn't listed as a chain (e.g. app-rollups). */
  protocol?: string;
  /** Wormhole chain id, for observed cross-chain routes (Wormholescan). */
  wormhole?: number;
  /** GeckoTerminal network id, for pool liquidity and short-window DEX volume. */
  gt?: string;
}

/** Chains shown on the liquidity map. */
export const FLOW_CHAINS: ChainMeta[] = [
  { id: 'ethereum', name: 'Ethereum', ecosystem: 'Ethereum', llama: ['Ethereum'], wormhole: 2, gt: 'eth' },
  { id: 'arbitrum', name: 'Arbitrum', ecosystem: 'Ethereum', llama: ['Arbitrum'], wormhole: 23, gt: 'arbitrum' },
  { id: 'optimism', name: 'OP Mainnet', ecosystem: 'Ethereum', llama: ['OP Mainnet', 'Optimism'], wormhole: 24, gt: 'optimism' },
  { id: 'base', name: 'Base', ecosystem: 'Base', llama: ['Base'], wormhole: 30, gt: 'base' },
  { id: 'robinhood', name: 'Robinhood Chain', ecosystem: 'Robinhood', llama: ['Robinhood', 'Robinhood Chain'], gt: env.GT_NETWORK_ROBINHOOD ?? 'robinhood' },
  { id: 'solana', name: 'Solana', ecosystem: 'Solana', llama: ['Solana'], wormhole: 1, gt: 'solana' },
  { id: 'bsc', name: 'BNB Chain', ecosystem: 'BNB', llama: ['BSC', 'Binance'], wormhole: 4, gt: 'bsc' },
  { id: 'lighter', name: 'Lighter', ticker: 'LIT', ecosystem: 'Ethereum', llama: ['Lighter', 'zkLighter'], protocol: 'lighter' },
  { id: 'hyperliquid', name: 'Hyperliquid', ecosystem: 'Hyperliquid', llama: ['Hyperliquid L1', 'Hyperliquid', 'HyperEVM'], wormhole: 47, gt: 'hyperevm' },
  { id: 'tron', name: 'Tron', ecosystem: 'Other', llama: ['Tron'], wormhole: 70, gt: 'tron' },
  { id: 'avalanche', name: 'Avalanche', ecosystem: 'Other', llama: ['Avalanche', 'AVAX'], wormhole: 6, gt: 'avax' },
  { id: 'polygon', name: 'Polygon', ecosystem: 'Other', llama: ['Polygon'], wormhole: 5, gt: 'polygon_pos' },
  { id: 'sui', name: 'Sui', ecosystem: 'Other', llama: ['Sui'], wormhole: 21, gt: 'sui-network' },
];

export interface MemeChainMeta extends MemeChain {
  /** GeckoTerminal network id. */
  gt: string;
  explorer: string; // address URL prefix
}

const ALL_MEME_CHAINS: MemeChainMeta[] = [
  { id: 'solana', name: 'Solana', ecosystem: 'Solana', gt: env.GT_NETWORK_SOLANA ?? 'solana', explorer: 'https://solscan.io/account/' },
  { id: 'base', name: 'Base', ecosystem: 'Base', gt: env.GT_NETWORK_BASE ?? 'base', explorer: 'https://basescan.org/address/' },
  { id: 'robinhood', name: 'Robinhood', ecosystem: 'Robinhood', gt: env.GT_NETWORK_ROBINHOOD ?? 'robinhood', explorer: 'https://explorer.chain.robinhood.com/address/' },
  { id: 'bsc', name: 'BNB Chain', ecosystem: 'BNB', gt: env.GT_NETWORK_BSC ?? 'bsc', explorer: 'https://bscscan.com/address/' },
  { id: 'hyperevm', name: 'HyperEVM', ecosystem: 'Hyperliquid', gt: env.GT_NETWORK_HYPEREVM ?? 'hyperevm', explorer: 'https://hyperevmscan.io/address/' },
];

const wanted = (env.MEME_CHAINS ?? 'solana,base,robinhood,bsc,hyperevm').split(',').map((s) => s.trim());
export const MEME_CHAINS = ALL_MEME_CHAINS.filter((c) => wanted.includes(c.id));
export const memeChain = (id: string) => ALL_MEME_CHAINS.find((c) => c.id === id);

/** Typical block / slot time, used by the simulator to assign block numbers. */
export const BLOCK_MS: Record<string, number> = { solana: 400, base: 2_000, bsc: 750, hyperevm: 1_000, robinhood: 250 };

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  chains: MEME_CHAINS.map((c) => c.id),
  minBuyUsd: 1_000,
  maxPairAgeHours: 24,
  minRoi: 1, // +100% over the window
  minLegitScore: 65,
  minTokens: 5,
  clusterSize: 3,
  clusterWindowMin: 30,
  includeWatchlist: true,
  sniperWindowSec: 3,
  excludeSnipers: true,
  ringAlerts: true,
  ringMinMembers: 2,
  telegram: true,
  discord: true,
};

export const NOTIFY = {
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramChat: env.TELEGRAM_CHAT_ID || '',
  discordWebhook: env.DISCORD_WEBHOOK_URL || '',
};

/** Thresholds for the solar map's live effects. */
export const FLOW_EVENTS = {
  superCometUsd: Number(env.SUPER_COMET_USD ?? 10_000_000),
  supernovaUsd: Number(env.SUPERNOVA_USD ?? 50_000_000),
  /** A day whose outflow is this many times the chain's recent median also counts as a supernova. */
  supernovaSpike: Number(env.SUPERNOVA_SPIKE ?? 3),
};

/** Solana trades via Helius (free plan: 1M credits/month, 10 req/s). Key lives only in .env. */
export const HELIUS = {
  apiKey: env.HELIUS_API_KEY || '',
  /** Daily spend cap; 30k/day keeps the free 1M/month plan safe. */
  dailyCredits: Number(env.HELIUS_DAILY_CREDITS ?? 30_000),
};

/** Public RPCs used to read swaps straight from each EVM chain. Override in .env. */
export const RPC: Record<string, string> = {
  base: env.RPC_BASE || 'https://base-rpc.publicnode.com',
  bsc: env.RPC_BSC || 'https://bsc-rpc.publicnode.com',
  hyperevm: env.RPC_HYPEREVM || 'https://rpc.hyperliquid.xyz/evm',
  robinhood: env.RPC_ROBINHOOD || 'https://rpc.mainnet.chain.robinhood.com',
};

/** When a new token is worth tracking (checked against DexScreener pair stats). */
export const PROMOTE = {
  minTxnsH1: Number(env.PROMOTE_MIN_TXNS_H1 ?? 25),
  minVolumeH1: Number(env.PROMOTE_MIN_VOLUME_H1 ?? 3_000),
  minLiquidity: Number(env.PROMOTE_MIN_LIQUIDITY ?? 5_000),
};

/** Optional wallet labels (fund / exchange / KOL names). Key lives only in .env. */
export const ARKHAM = { apiKey: env.ARKHAM_API_KEY || '' };

export const DUNE = {
  apiKey: env.DUNE_API_KEY || '',
  queryId: env.DUNE_QUERY_ID || '',
};

/** Scanner budget. GeckoTerminal's free tier allows ~30 req/min. */
export const SCAN = {
  intervalMs: Number(env.SCAN_INTERVAL_MS ?? 60_000),
  gtPerMinute: Number(env.GT_RATE_PER_MIN ?? 25),
  poolsPerCycle: Number(env.POOLS_PER_CYCLE ?? 12),
};
