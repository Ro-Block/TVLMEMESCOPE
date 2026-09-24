import type { Pair } from '../../../shared/types.ts';
import { PROMOTE } from '../config.ts';
import * as ds from '../sources/dexscreener.ts';
import type { Ledger } from '../engine/ledger.ts';
import type { LedgerTrade } from '../engine/roi.ts';

export type TradeSink = (pair: Pair, fresh: LedgerTrade[], now?: number) => void;
export type Trade = LedgerTrade & { tx: string };

/** A newly created token/pool we know about but haven't shown yet. */
export interface Candidate {
  chain: string;
  token: string; // base token address / mint
  pool: string; // Pair.address: the mint on Solana, the pool address (or v4 pool id) on EVM chains
  /** Creation time; 0 when unknown (e.g. found through a wallet's trade), filled from DexScreener. */
  createdAt: number;
  addedAt: number;
  dex: string;
  launchpad?: string;
  symbol?: string;
  name?: string;
  quoteSymbol: string;
  creator?: string;
  imageUrl?: string;
  /** Resolves the token logo on promotion (e.g. launchpad metadata). */
  resolveImage?: () => Promise<string | undefined>;
  buffered: Trade[];
  lastChecked: number;
  promoted: boolean;
  pair?: Pair;
}

const CANDIDATE_TTL = 2 * 3_600_000;
const BUFFER_MAX = 400;

export function pairFromStats(c: Candidate, s: ds.DsPairStats | undefined): Pair {
  return {
    id: `${c.chain}:${c.pool}`,
    chain: c.chain,
    address: c.pool,
    dex: s?.dexId || c.dex,
    name: `${s?.baseToken.symbol ?? c.symbol ?? '?'} / ${s?.quoteToken.symbol ?? c.quoteSymbol}`,
    baseSymbol: s?.baseToken.symbol ?? c.symbol ?? '?',
    baseAddress: c.token,
    quoteSymbol: s?.quoteToken.symbol ?? c.quoteSymbol,
    imageUrl: s?.imageUrl ?? c.imageUrl,
    imageFallbackUrl: ds.cdnImage(c.chain, c.token),
    launchpad: c.launchpad,
    createdAt: c.createdAt || s?.pairCreatedAt || 0,
    priceUsd: s?.priceUsd ?? 0,
    mcap: s?.marketCap ?? 0,
    liquidity: s?.liquidityUsd ?? 0,
    volume: s?.volume ?? { m5: 0, h1: 0, h6: 0, h24: 0 },
    txns: { h1: s?.txns.h1 ?? { buys: 0, sells: 0 }, h24: s?.txns.h24 ?? { buys: 0, sells: 0 } },
    change: s?.change ?? { m5: 0, h1: 0, h24: 0 },
    trending: (s?.volume.h1 ?? 0) > 50_000,
    smartWallets: [],
    url: s?.url || `https://dexscreener.com/${ds.dsChain(c.chain)}/${c.token}`,
  };
}

export function shouldPromote(s: ds.DsPairStats | undefined): boolean {
  if (!s) return false;
  const txns = s.txns.h1.buys + s.txns.h1.sells;
  return txns >= PROMOTE.minTxnsH1 || s.volume.h1 >= PROMOTE.minVolumeH1 || s.liquidityUsd >= PROMOTE.minLiquidity;
}

/**
 * Holds new tokens as candidates, checks them against DexScreener, and only promotes the ones with
 * real activity (or smart-money buys) into the ledger, replaying the trades seen so far so launch
 * analysis still sees the opening seconds.
 */
export class PairTracker {
  private cands = new Map<string, Candidate>();
  stats = { candidates: 0, promoted: 0, dropped: 0, dsCalls: 0 };

  constructor(
    private ledger: Ledger,
    private sink: TradeSink,
    /** Is this wallet one whose buy should promote a token right away? */
    private important: (chain: string, wallet: string) => boolean,
  ) {}

  private key = (chain: string, pool: string) => `${chain}:${pool}`;

  get(chain: string, pool: string) {
    return this.cands.get(this.key(chain, pool));
  }

  add(c: Omit<Candidate, 'buffered' | 'lastChecked' | 'promoted' | 'addedAt'>): Candidate {
    const k = this.key(c.chain, c.pool);
    const have = this.cands.get(k);
    if (have) return have;
    const cand: Candidate = { ...c, addedAt: Date.now(), buffered: [], lastChecked: 0, promoted: false };
    this.cands.set(k, cand);
    this.stats.candidates = this.cands.size;
    return cand;
  }

  promoted(chain?: string): Candidate[] {
    return [...this.cands.values()].filter((c) => c.promoted && (!chain || c.chain === chain));
  }

  unpromoted(chain?: string): Candidate[] {
    return [...this.cands.values()].filter((c) => !c.promoted && (!chain || c.chain === chain));
  }

  /** Trades for a pool: stored immediately once promoted, buffered before. */
  record(chain: string, pool: string, trades: Trade[]) {
    const c = this.cands.get(this.key(chain, pool));
    if (!c || !trades.length) return;
    if (c.promoted && c.pair) {
      const fresh = this.ledger.insertTrades(trades);
      if (fresh.length) this.sink(c.pair, fresh);
      return;
    }
    c.buffered.push(...trades);
    if (c.buffered.length > BUFFER_MAX) c.buffered.splice(0, c.buffered.length - BUFFER_MAX);
    if (trades.some((t) => t.kind === 'buy' && this.important(chain, t.wallet))) void this.promote(c, undefined);
  }

  private async promote(c: Candidate, stats: ds.DsPairStats | undefined) {
    if (c.promoted) return;
    c.promoted = true;
    if (!stats?.imageUrl && !c.imageUrl && c.resolveImage) c.imageUrl = await c.resolveImage().catch(() => undefined);
    c.pair = pairFromStats(c, stats);
    this.ledger.upsertPools([c.pair]);
    this.stats.promoted++;
    const buffered = c.buffered.sort((a, b) => a.ts - b.ts);
    c.buffered = [];
    const fresh = this.ledger.insertTrades(buffered);
    if (fresh.length) this.sink(c.pair, fresh);
  }

  /**
   * One pass: refresh DexScreener stats for promoted pairs (every 2 min) and check unpromoted
   * candidates (every 45 s), at most `maxCalls` calls of 30 tokens.
   */
  async refresh(maxCalls = 6) {
    const now = Date.now();
    for (const [k, c] of this.cands) {
      const old = now - c.addedAt > CANDIDATE_TTL;
      if (!c.promoted && old) {
        this.cands.delete(k);
        this.stats.dropped++;
      } else if (c.promoted && now - c.addedAt > 24 * 3_600_000) this.cands.delete(k);
    }
    this.stats.candidates = this.cands.size;

    const due = [...this.cands.values()]
      .filter((c) => now - c.lastChecked > (c.promoted ? 120_000 : 45_000) && now - c.addedAt > 20_000)
      .sort((a, b) => Number(a.promoted) - Number(b.promoted) || a.lastChecked - b.lastChecked);
    const byChain = new Map<string, Candidate[]>();
    for (const c of due) byChain.set(c.chain, [...(byChain.get(c.chain) ?? []), c]);

    let calls = 0;
    for (const [chain, list] of byChain) {
      for (let i = 0; i < list.length && calls < maxCalls; i += 30, calls++) {
        const batch = list.slice(i, i + 30);
        for (const c of batch) c.lastChecked = now;
        const stats = await ds.pairsForTokens(chain, [...new Set(batch.map((c) => c.token))]).catch(() => null);
        this.stats.dsCalls++;
        if (!stats) continue;
        for (const c of batch) {
          const mine = stats.filter((s) => s.baseToken.address.toLowerCase() === c.token.toLowerCase());
          const s = mine.find((x) => x.pairAddress.toLowerCase() === c.pool.toLowerCase()) ?? mine[0];
          if (c.promoted && c.pair) {
            c.pair = { ...pairFromStats(c, s), createdAt: c.pair.createdAt || s?.pairCreatedAt || 0, imageUrl: s?.imageUrl ?? c.pair.imageUrl };
            this.ledger.upsertPools([c.pair]);
          } else if (shouldPromote(s)) await this.promote(c, s);
        }
      }
    }
  }
}
