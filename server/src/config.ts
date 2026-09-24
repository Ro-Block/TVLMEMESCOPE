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
}

/** Chains shown on the liquidity map. */
export const FLOW_CHAINS: ChainMeta[] = [
  { id: 'ethereum', name: 'Ethereum', ecosystem: 'Ethereum', llama: ['Ethereum'] },
  { id: 'arbitrum', name: 'Arbitrum', ecosystem: 'Ethereum', llama: ['Arbitrum'] },
  { id: 'optimism', name: 'OP Mainnet', ecosystem: 'Ethereum', llama: ['OP Mainnet', 'Optimism'] },
  { id: 'base', name: 'Base', ecosystem: 'Base', llama: ['Base'] },
  { id: 'robinhood', name: 'Robinhood Chain', ecosystem: 'Robinhood', llama: ['Robinhood', 'Robinhood Chain'] },
  { id: 'solana', name: 'Solana', ecosystem: 'Solana', llama: ['Solana'] },
  { id: 'bsc', name: 'BNB Chain', ecosystem: 'BNB', llama: ['BSC', 'Binance'] },
  { id: 'hyperliquid', name: 'Hyperliquid', ecosystem: 'Hyperliquid', llama: ['Hyperliquid L1', 'Hyperliquid', 'HyperEVM'] },
  { id: 'tron', name: 'Tron', ecosystem: 'Other', llama: ['Tron'] },
  { id: 'avalanche', name: 'Avalanche', ecosystem: 'Other', llama: ['Avalanche', 'AVAX'] },
  { id: 'polygon', name: 'Polygon', ecosystem: 'Other', llama: ['Polygon'] },
  { id: 'sui', name: 'Sui', ecosystem: 'Other', llama: ['Sui'] },
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
