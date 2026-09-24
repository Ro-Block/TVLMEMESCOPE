import { createPublicClient, formatUnits, http, parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import { BLOCK_MS, RPC } from '../config.ts';
import { sourceHealth } from '../http.ts';
import { nativeUsd } from '../sources/prices.ts';
import type { PairTracker, Trade } from './tracker.ts';

// Reads new pools and swaps straight from each chain over public RPC. Pool creation is found by
// event signature (PairCreated / PoolCreated are identical across Uniswap-style forks, so any DEX
// on the chain is covered); Uniswap v4 pools by the chain's PoolManager. The trader is tx.from.

export const EV = {
  pairCreated: parseAbiItem('event PairCreated(address indexed token0, address indexed token1, address pair, uint256)'),
  poolCreated: parseAbiItem('event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)'),
  v4Initialize: parseAbiItem('event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)'),
  v2Swap: parseAbiItem('event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'),
  v3Swap: parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)'),
  pcsV3Swap: parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint128 protocolFeesToken0, uint128 protocolFeesToken1)'),
  v4Swap: parseAbiItem('event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)'),
};
const decimalsAbi = [parseAbiItem('function decimals() view returns (uint8)')];

interface Quote {
  symbol: string;
  decimals: number;
  /** 'native' = priced at the chain's native asset, 'usd' = stablecoin. */
  price: 'native' | 'usd';
}

export interface EvmChainConfig {
  id: string;
  rpc: string;
  native: 'ethereum' | 'bnb' | 'hype';
  quotes: Record<string, Quote>; // lower-case address -> quote token
  v4PoolManager?: Address;
}

const ZERO = '0x0000000000000000000000000000000000000000';
const env = process.env;

export const EVM_CHAINS: EvmChainConfig[] = [
  {
    id: 'base',
    rpc: RPC.base,
    native: 'ethereum',
    quotes: {
      '0x4200000000000000000000000000000000000006': { symbol: 'WETH', decimals: 18, price: 'native' },
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { symbol: 'USDC', decimals: 6, price: 'usd' },
      [ZERO]: { symbol: 'ETH', decimals: 18, price: 'native' },
    },
    v4PoolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  },
  {
    id: 'bsc',
    rpc: RPC.bsc,
    native: 'bnb',
    quotes: {
      '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18, price: 'native' },
      '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18, price: 'usd' },
      '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18, price: 'usd' },
    },
  },
  {
    id: 'hyperevm',
    rpc: RPC.hyperevm,
    native: 'hype',
    quotes: {
      '0x5555555555555555555555555555555555555555': { symbol: 'WHYPE', decimals: 18, price: 'native' },
      '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb': { symbol: 'USDT0', decimals: 6, price: 'usd' },
    },
  },
  {
    id: 'robinhood',
    rpc: RPC.robinhood,
    native: 'ethereum',
    quotes: {
      [ZERO]: { symbol: 'ETH', decimals: 18, price: 'native' },
      ...(env.ROBINHOOD_WETH ? { [env.ROBINHOOD_WETH.toLowerCase()]: { symbol: 'WETH', decimals: 18, price: 'native' as const } } : {}),
    },
    v4PoolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  },
];

export type PoolKind = 'v2' | 'v3' | 'v4';

export interface TrackedPool {
  kind: PoolKind;
  key: string; // pool address, or v4 pool id
  base: string;
  baseIs0: boolean;
  quote: Quote;
}

/** From pool creation: which side is the new token, which is the quote. Null if neither/both are quotes. */
export function classifyPool(chain: EvmChainConfig, token0: string, token1: string): { base: string; baseIs0: boolean; quote: Quote } | null {
  const q0 = chain.quotes[token0.toLowerCase()];
  const q1 = chain.quotes[token1.toLowerCase()];
  if (!!q0 === !!q1) return null;
  return q0 ? { base: token1.toLowerCase(), baseIs0: false, quote: q0 } : { base: token0.toLowerCase(), baseIs0: true, quote: q1! };
}

/**
 * The trader's token deltas for one swap, in raw units (positive = trader received).
 * v2: in/out amounts from the pool; v3 (incl. PancakeSwap): pool's balance delta, so negate;
 * v4: amounts are from the swapper's side already (Uniswap's own v4 indexer negates them to get
 * the pool's side), so use as-is.
 */
export function traderDeltas(kind: PoolKind, args: Record<string, bigint>): [bigint, bigint] {
  if (kind === 'v2') return [args.amount0Out - args.amount0In, args.amount1Out - args.amount1In];
  if (kind === 'v3') return [-args.amount0, -args.amount1];
  return [args.amount0, args.amount1];
}

export function swapToTrade(pool: TrackedPool, args: Record<string, bigint>, baseDecimals: number, quoteUsd: number): { kind: 'buy' | 'sell'; qty: number; usd: number } | null {
  const [d0, d1] = traderDeltas(pool.kind, args);
  const [dBase, dQuote] = pool.baseIs0 ? [d0, d1] : [d1, d0];
  if (dBase === 0n || dQuote === 0n || (dBase > 0n) === (dQuote > 0n)) return null; // not a clean swap
  const abs = (x: bigint) => (x < 0n ? -x : x);
  // formatUnits keeps full precision; plain Number(bigint) / 10**d drifts on 18-decimal amounts.
  const qty = Number(formatUnits(abs(dBase), baseDecimals));
  const usd = Number(formatUnits(abs(dQuote), pool.quote.decimals)) * quoteUsd;
  if (!(usd >= 1)) return null;
  return { kind: dBase > 0n ? 'buy' : 'sell', qty, usd };
}

const LOOKBACK_MS = 90_000; // start a little behind head on boot
const MAX_RANGE = 400; // blocks per getLogs call

/** One chain's indexer loop. */
export class EvmFeed {
  private client: PublicClient;
  private last = 0n;
  private pools = new Map<string, TrackedPool>(); // key (lower) -> pool
  private decimals = new Map<string, number>();
  stats = { head: 0, pools: 0, swaps: 0, trades: 0, errors: 0 };

  constructor(
    private cfg: EvmChainConfig,
    private tracker: PairTracker,
  ) {
    this.client = createPublicClient({ transport: http(cfg.rpc, { batch: { batchSize: 40 }, timeout: 20_000, retryCount: 1 }) }) as PublicClient;
  }

  private get blockMs() {
    return BLOCK_MS[this.cfg.id] ?? 1_000;
  }

  start() {
    const loop = () =>
      void this.tick()
        .then(() => {
          sourceHealth[`rpc-${this.cfg.id}`] = { ok: true, lastOk: Date.now() };
        })
        .catch((e) => {
          this.stats.errors++;
          // viem's message is generic; `details` carries the actual reason (status, timeout, RPC error).
          const err = e as { shortMessage?: string; details?: string; message?: string };
          const why = [err.shortMessage ?? String(err.message).split('\n')[0], err.details].filter(Boolean).join(': ');
          sourceHealth[`rpc-${this.cfg.id}`] = { ...sourceHealth[`rpc-${this.cfg.id}`], ok: false, lastError: why.slice(0, 200) };
        })
        .finally(() => setTimeout(loop, 15_000).unref());
    loop();
  }

  private async decimalsOf(token: string): Promise<number> {
    const have = this.decimals.get(token);
    if (have !== undefined) return have;
    const d = Number(await this.client.readContract({ address: token as Address, abi: decimalsAbi, functionName: 'decimals' }).catch(() => 18));
    this.decimals.set(token, d);
    return d;
  }

  private async tick() {
    const head = await this.client.getBlockNumber();
    this.stats.head = Number(head);
    if (!this.last) this.last = head - BigInt(Math.ceil(LOOKBACK_MS / this.blockMs));
    const from = this.last + 1n;
    if (from > head) return;
    const to = head - from > BigInt(MAX_RANGE) ? from + BigInt(MAX_RANGE) : head;
    const tsOf = (block: bigint) => Date.now() - Number(head - block) * this.blockMs;

    // 1. New pools on any Uniswap-style factory, plus v4 pools on the PoolManager.
    const created = await this.client.getLogs({ events: [EV.pairCreated, EV.poolCreated], fromBlock: from, toBlock: to });
    for (const log of created) {
      const a = log.args as { token0?: string; token1?: string; pair?: string; pool?: string };
      if (!a.token0 || !a.token1) continue;
      const cls = classifyPool(this.cfg, a.token0, a.token1);
      const addr = (a.pair ?? a.pool)?.toLowerCase();
      if (!cls || !addr) continue;
      this.addPool({ kind: log.eventName === 'PairCreated' ? 'v2' : 'v3', key: addr, ...cls }, tsOf(log.blockNumber!), log.eventName === 'PairCreated' ? 'v2' : 'v3');
    }
    if (this.cfg.v4PoolManager) {
      const inits = await this.client.getLogs({ address: this.cfg.v4PoolManager, event: EV.v4Initialize, fromBlock: from, toBlock: to });
      for (const log of inits) {
        const a = log.args as { id?: Hex; currency0?: string; currency1?: string };
        if (!a.id || !a.currency0 || !a.currency1) continue;
        const cls = classifyPool(this.cfg, a.currency0, a.currency1);
        if (cls) this.addPool({ kind: 'v4', key: a.id.toLowerCase(), ...cls }, tsOf(log.blockNumber!), 'uniswap-v4');
      }
    }

    // Keep only pools the tracker still cares about.
    const live = new Set([...this.tracker.unpromoted(this.cfg.id), ...this.tracker.promoted(this.cfg.id)].map((c) => c.pool));
    for (const k of this.pools.keys()) if (!live.has(k)) this.pools.delete(k);
    this.stats.pools = this.pools.size;

    // 2. Swaps on tracked pools.
    const swaps: { pool: TrackedPool; args: Record<string, bigint>; hash: Hex; block: bigint }[] = [];
    const v23 = [...this.pools.values()].filter((p) => p.kind !== 'v4');
    for (let i = 0; i < v23.length; i += 150) {
      const chunk = v23.slice(i, i + 150);
      const byAddr = new Map(chunk.map((p) => [p.key, p]));
      const logs = await this.client.getLogs({ address: chunk.map((p) => p.key as Address), events: [EV.v2Swap, EV.v3Swap, EV.pcsV3Swap], fromBlock: from, toBlock: to });
      for (const l of logs) {
        const p = byAddr.get(l.address.toLowerCase());
        if (p) swaps.push({ pool: { ...p, kind: l.eventName === 'Swap' && 'amount0In' in (l.args as object) ? 'v2' : 'v3' }, args: l.args as Record<string, bigint>, hash: l.transactionHash!, block: l.blockNumber! });
      }
    }
    const v4 = [...this.pools.values()].filter((p) => p.kind === 'v4');
    if (this.cfg.v4PoolManager && v4.length) {
      for (let i = 0; i < v4.length; i += 100) {
        const chunk = v4.slice(i, i + 100);
        const byId = new Map(chunk.map((p) => [p.key, p]));
        const logs = await this.client.getLogs({ address: this.cfg.v4PoolManager, event: EV.v4Swap, args: { id: chunk.map((p) => p.key as Hex) }, fromBlock: from, toBlock: to });
        for (const l of logs) {
          const p = byId.get(String(l.args.id).toLowerCase());
          if (p) swaps.push({ pool: p, args: l.args as unknown as Record<string, bigint>, hash: l.transactionHash!, block: l.blockNumber! });
        }
      }
    }
    this.stats.swaps += swaps.length;

    // 3. Price, attribute to the transaction's signer, deliver.
    if (swaps.length) {
      const nativePrice = await nativeUsd(this.cfg.native);
      const hashes = [...new Set(swaps.map((s) => s.hash))].slice(0, 300);
      const froms = new Map<string, string>();
      await Promise.all(
        hashes.map(async (h) => {
          const t = await this.client.getTransaction({ hash: h }).catch(() => null);
          if (t) froms.set(h, t.from.toLowerCase());
        }),
      );
      const byPool = new Map<string, Trade[]>();
      for (const s of swaps) {
        const wallet = froms.get(s.hash);
        const quoteUsd = s.pool.quote.price === 'usd' ? 1 : nativePrice;
        if (!wallet || !quoteUsd) continue;
        const t = swapToTrade(s.pool, s.args, await this.decimalsOf(s.pool.base), quoteUsd);
        if (!t) continue;
        const trade: Trade = { tx: `${s.hash}:${s.pool.key}`, chain: this.cfg.id, pool: s.pool.key, wallet, token: s.pool.base, kind: t.kind, qty: t.qty, usd: t.usd, ts: tsOf(s.block), block: Number(s.block) };
        byPool.set(s.pool.key, [...(byPool.get(s.pool.key) ?? []), trade]);
      }
      for (const [pool, trades] of byPool) {
        this.stats.trades += trades.length;
        this.tracker.record(this.cfg.id, pool, trades);
      }
    }
    this.last = to;
  }

  private addPool(p: TrackedPool, createdAt: number, dex: string) {
    if (this.pools.has(p.key)) return;
    this.pools.set(p.key, p);
    this.tracker.add({ chain: this.cfg.id, token: p.base, pool: p.key, createdAt, dex, quoteSymbol: p.quote.symbol });
  }
}
