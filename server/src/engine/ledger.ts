import type { AlertSettings, Pair, TradeRow, TraderStats, WalletDetail } from '../../../shared/types.ts';
import type { Db } from '../db.ts';
import { tx } from '../db.ts';
import { legitScore, tierFor, walletStats, type LedgerTrade } from './roi.ts';

export const normWallet = (chain: string, w: string) => (chain === 'solana' ? w : w.toLowerCase());
const key = (chain: string, wallet: string) => `${chain}:${wallet}`;

export interface SeedStats extends Partial<TraderStats> {
  wallet: string;
  chain: string;
}

/** Trade store + rolling-window trader statistics. */
export class Ledger {
  private cache: { at: number; stats: TraderStats[]; byKey: Map<string, TraderStats> } | null = null;
  private watch = new Map<string, { label?: string }>();
  /** Lets the demo simulator run on its own clock. */
  now: () => number = Date.now;
  /** Extra per-wallet flags from other engines (e.g. `sniper`). */
  extraFlags: (chain: string, wallet: string) => string[] = () => [];

  constructor(
    private db: Db,
    private windowDays: number,
    private settings: () => AlertSettings,
  ) {
    for (const r of db.prepare('SELECT wallet, chain, label FROM watchlist').all() as any[]) this.watch.set(key(r.chain, r.wallet), { label: r.label ?? undefined });
  }

  // ---------- pools ----------

  upsertPools(pairs: Pair[]) {
    const stmt = this.db.prepare(`INSERT INTO pools (id, chain, address, token, symbol, created_at, price_usd, trending, updated_at, json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET price_usd = excluded.price_usd, trending = MAX(pools.trending, excluded.trending), updated_at = excluded.updated_at, json = excluded.json`);
    tx(this.db, () => {
      for (const p of pairs) stmt.run(p.id, p.chain, p.address, p.baseAddress, p.baseSymbol, p.createdAt, p.priceUsd, p.trending ? 1 : 0, this.now(), JSON.stringify(p));
    });
  }

  pools(opts: { chains?: string[]; sinceCreated?: number; limit?: number } = {}): Pair[] {
    const chains = opts.chains?.length ? opts.chains : null;
    const rows = this.db
      .prepare(`SELECT json, trending FROM pools WHERE created_at >= ? ${chains ? `AND chain IN (${chains.map(() => '?').join(',')})` : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(opts.sinceCreated ?? 0, ...(chains ?? []), opts.limit ?? 300) as { json: string; trending: number }[];
    return rows.map((r) => ({ ...(JSON.parse(r.json) as Pair), trending: r.trending === 1 }));
  }

  pool(id: string): Pair | null {
    const r = this.db.prepare('SELECT json FROM pools WHERE id = ?').get(id) as { json: string } | undefined;
    return r ? (JSON.parse(r.json) as Pair) : null;
  }

  // ---------- trades ----------

  /** Inserts trades, returning only the ones not seen before. */
  insertTrades(trades: (LedgerTrade & { tx: string })[]): (LedgerTrade & { tx: string })[] {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO trades (chain, pool, tx, wallet, kind, token, qty, usd, ts, block) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const fresh: (LedgerTrade & { tx: string })[] = [];
    tx(this.db, () => {
      for (const t of trades) {
        const w = normWallet(t.chain, t.wallet);
        const r = stmt.run(t.chain, t.pool, t.tx, w, t.kind, t.token, t.qty, t.usd, t.ts, t.block ?? null);
        if (r.changes) fresh.push({ ...t, wallet: w });
      }
    });
    // Stats are allowed to be up to 30s stale; a wallet's history barely moves per poll.
    return fresh;
  }

  prune() {
    const cutoff = this.now() - (this.windowDays + 1) * 86_400_000;
    this.db.prepare('DELETE FROM trades WHERE ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM pools WHERE created_at < ?').run(cutoff);
    this.db.prepare('DELETE FROM alerts WHERE ts < ?').run(cutoff);
  }

  counts() {
    const t = this.db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT wallet) w, MIN(ts) oldest FROM trades').get() as any;
    const p = this.db.prepare('SELECT COUNT(*) n FROM pools').get() as any;
    return { trades: Number(t.n), wallets: Number(t.w), pools: Number(p.n), oldest: t.oldest ?? null };
  }

  // ---------- seeds (Dune backfill, Hyperliquid leaderboard) ----------

  replaceSeeds(source: string, seeds: SeedStats[]) {
    tx(this.db, () => {
      this.db.prepare('DELETE FROM seeds WHERE source = ?').run(source);
      const stmt = this.db.prepare('INSERT OR REPLACE INTO seeds (wallet, chain, source, label, json, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const s of seeds) stmt.run(normWallet(s.chain, s.wallet), s.chain, source, s.label ?? null, JSON.stringify(s), this.now());
    });
    this.cache = null;
  }

  // ---------- watchlist ----------

  addWatch(chain: string, wallet: string, label?: string) {
    const w = normWallet(chain, wallet);
    this.db.prepare('INSERT OR REPLACE INTO watchlist (wallet, chain, label, added_at) VALUES (?, ?, ?, ?)').run(w, chain, label ?? null, Date.now());
    this.watch.set(key(chain, w), { label });
    this.cache = null;
  }

  removeWatch(chain: string, wallet: string) {
    const w = normWallet(chain, wallet);
    this.db.prepare('DELETE FROM watchlist WHERE wallet = ? AND chain = ?').run(w, chain);
    this.watch.delete(key(chain, w));
    this.cache = null;
  }

  watchlist(): { chain: string; wallet: string; label?: string }[] {
    return [...this.watch].map(([k, v]) => ({ chain: k.slice(0, k.indexOf(':')), wallet: k.slice(k.indexOf(':') + 1), label: v.label }));
  }

  // ---------- stats ----------

  private prices(): { px: Map<string, number>; sym: Map<string, string> } {
    const rows = this.db.prepare('SELECT token, symbol, price_usd FROM pools ORDER BY updated_at ASC').all() as any[];
    return { px: new Map(rows.filter((r) => r.price_usd > 0).map((r) => [r.token, r.price_usd])), sym: new Map(rows.map((r) => [r.token, r.symbol])) };
  }

  /** All trader stats over the rolling window, recomputed at most every 30s. */
  allStats(): TraderStats[] {
    if (this.cache && this.now() - this.cache.at < 30_000) return this.cache.stats;
    const since = this.now() - this.windowDays * 86_400_000;
    const { px, sym } = this.prices();
    const minLegit = this.settings().minLegitScore;
    const rows = this.db
      .prepare('SELECT wallet, chain, pool, token, kind, qty, usd, ts FROM trades WHERE ts >= ? ORDER BY wallet, chain, ts')
      .all(since) as unknown as LedgerTrade[];

    const out = new Map<string, TraderStats>();
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j < rows.length && rows[j].wallet === rows[i].wallet && rows[j].chain === rows[i].chain) j++;
      const group = rows.slice(i, j);
      i = j;
      if (!group.some((t) => t.kind === 'buy')) continue;
      const { stats, positions } = walletStats(group[0].wallet, group[0].chain, group, (t) => px.get(t), sym);
      const top = Math.max(0, ...positions.map((p) => p.realizedUsd + p.unrealizedUsd));
      const { score, flags } = legitScore(stats, top);
      flags.push(...this.extraFlags(stats.chain, stats.wallet));
      const k = key(stats.chain, stats.wallet);
      const s: TraderStats = { ...stats, legitScore: score, flags, source: 'ledger', tier: 'none', watched: this.watch.has(k), label: this.watch.get(k)?.label };
      s.tier = tierFor(s, minLegit);
      out.set(k, s);
    }

    for (const r of this.db.prepare('SELECT wallet, chain, source, label, json FROM seeds').all() as any[]) {
      const k = key(r.chain, r.wallet);
      const seed = JSON.parse(r.json) as SeedStats;
      const have = out.get(k);
      // Ledger history wins once it has seen at least as many tokens as the seed claims.
      if (have && have.tokens >= (seed.tokens ?? 0)) continue;
      const base: TraderStats = {
        roi: 0, pnlUsd: 0, realizedUsd: 0, unrealizedUsd: 0, investedUsd: 0, trades: 0, tokens: 0, wins: 0, winRate: 0,
        medianHoldMin: null, lastActive: 0, legitScore: 0, flags: [], tier: 'none', ...seed,
        wallet: r.wallet, chain: r.chain, source: r.source, label: this.watch.get(k)?.label ?? r.label ?? seed.label, watched: this.watch.has(k),
      };
      if (r.source === 'dune') {
        const { score, flags } = legitScore(base);
        base.legitScore = score;
        base.flags = flags;
      }
      base.tier = seed.tier ?? tierFor(base, minLegit);
      out.set(k, base);
    }

    // Watchlisted wallets we have no trades for yet still need a row.
    for (const [k, v] of this.watch) {
      if (out.has(k)) {
        out.get(k)!.tier = out.get(k)!.tier === 'none' ? 'watch' : out.get(k)!.tier;
        continue;
      }
      const [chain, ...rest] = k.split(':');
      out.set(k, {
        wallet: rest.join(':'), chain, label: v.label, source: 'manual', roi: 0, pnlUsd: 0, realizedUsd: 0, unrealizedUsd: 0,
        investedUsd: 0, trades: 0, tokens: 0, wins: 0, winRate: 0, medianHoldMin: null, lastActive: 0, legitScore: 0,
        flags: ['manual'], tier: 'watch', watched: true,
      });
    }

    const stats = [...out.values()];
    this.cache = { at: this.now(), stats, byKey: out };
    return stats;
  }

  get(chain: string, wallet: string): TraderStats | undefined {
    this.allStats();
    return this.cache!.byKey.get(key(chain, normWallet(chain, wallet)));
  }

  /** Is this wallet one whose buys should raise alerts under the current settings? */
  qualifies(s: TraderStats | undefined, st: AlertSettings): boolean {
    if (!s) return false;
    if (s.watched && st.includeWatchlist) return true;
    if (s.flags.includes('bot-like')) return false;
    if (st.excludeSnipers && s.flags.includes('sniper')) return false;
    // Hyperliquid seeds are vetted by the leaderboard filter and have no meme-token sample.
    if (s.source === 'hyperliquid') return s.legitScore >= st.minLegitScore;
    return s.legitScore >= st.minLegitScore && s.roi >= st.minRoi && s.tokens >= st.minTokens;
  }

  walletDetail(chain: string, wallet: string): WalletDetail {
    const w = normWallet(chain, wallet);
    const since = this.now() - this.windowDays * 86_400_000;
    const trades = this.db
      .prepare('SELECT wallet, chain, pool, tx, token, kind, qty, usd, ts FROM trades WHERE wallet = ? AND chain = ? AND ts >= ? ORDER BY ts')
      .all(w, chain, since) as unknown as (LedgerTrade & { tx: string })[];
    const { px, sym } = this.prices();
    const { positions } = walletStats(w, chain, trades, (t) => px.get(t), sym);
    const recent: TradeRow[] = trades
      .slice(-50)
      .reverse()
      .map((t) => ({ ...t, symbol: sym.get(t.token) ?? '?' }));
    return { stats: this.get(chain, w) ?? null, positions, recent };
  }

  /** Smart-money buyers per pool, for the memescope cards. */
  smartBuyers(poolIds: string[], st: AlertSettings): Map<string, Pair['smartWallets']> {
    const res = new Map<string, Pair['smartWallets']>();
    if (!poolIds.length) return res;
    const stmt = this.db.prepare("SELECT wallet, SUM(usd) usd FROM trades WHERE chain = ? AND pool = ? AND kind = 'buy' GROUP BY wallet");
    for (const id of poolIds) {
      const [chain, pool] = id.split(/:(.*)/s);
      const list: Pair['smartWallets'] = [];
      for (const r of stmt.all(chain, pool) as any[]) {
        const s = this.get(chain, r.wallet);
        if (this.qualifies(s, st)) list.push({ wallet: r.wallet, usd: r.usd, tier: s!.tier === 'none' ? 'smart' : s!.tier });
      }
      res.set(id, list.sort((a, b) => b.usd - a.usd));
    }
    return res;
  }
}
