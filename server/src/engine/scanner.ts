import type { Pair } from '../../../shared/types.ts';
import { MEME_CHAINS, SCAN, type MemeChainMeta } from '../config.ts';
import * as dune from '../sources/dune.ts';
import * as gt from '../sources/geckoterminal.ts';
import * as hl from '../sources/hyperliquid.ts';
import type { AlertEngine } from './alerts.ts';
import type { Ledger, SeedStats } from './ledger.ts';

export function toPair(p: gt.GtPool, chain: MemeChainMeta, trending: boolean): Pair {
  return {
    id: `${chain.id}:${p.address}`,
    chain: chain.id,
    address: p.address,
    dex: p.dex,
    name: p.name,
    baseSymbol: p.baseSymbol,
    baseAddress: p.baseAddress,
    quoteSymbol: p.quoteSymbol,
    createdAt: p.createdAt,
    priceUsd: p.priceUsd,
    mcap: p.mcap,
    liquidity: p.liquidity,
    volume: p.volume,
    txns: p.txns,
    change: p.change,
    trending,
    smartWallets: [],
    url: gt.pairUrl(chain.gt, p.address),
  };
}

const DUNE_CHAIN: Record<string, string> = { bnb: 'bsc', base: 'base', solana: 'solana', robinhood: 'robinhood', hyperevm: 'hyperevm' };

/** Polls GeckoTerminal for new/trending pairs and their trades, feeding the ledger and the alert engine. */
export class LiveScanner {
  private lastPolled = new Map<string, number>();
  private cycle = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private ledger: Ledger,
    private alerts: AlertEngine,
  ) {}

  /** Returns false if GeckoTerminal is unreachable. Warns about configured networks GT doesn't list. */
  static async probe(): Promise<boolean> {
    try {
      const nets = new Set(await gt.networks());
      for (const c of MEME_CHAINS) if (!nets.has(c.gt)) console.warn(`[scanner] GeckoTerminal network "${c.gt}" (${c.name}) not on page 1 of /networks — set GT_NETWORK_${c.id.toUpperCase()} if the id differs`);
      return true;
    } catch (e) {
      console.warn(`[scanner] GeckoTerminal unreachable: ${(e as Error).message}`);
      return false;
    }
  }

  start() {
    const run = () =>
      this.tick()
        .catch((e) => console.warn('[scanner]', e.message))
        .finally(() => (this.timer = setTimeout(run, SCAN.intervalMs)));
    void this.refreshSeeds();
    setInterval(() => void this.refreshSeeds(), 6 * 3_600_000).unref();
    setInterval(() => this.ledger.prune(), 3_600_000).unref();
    run();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  private async tick() {
    this.cycle++;
    const withTrending = this.cycle % 5 === 1;
    await Promise.all(
      MEME_CHAINS.map(async (c) => {
        try {
          const pairs = (await gt.newPools(c.gt)).map((p) => toPair(p, c, false));
          if (withTrending) pairs.push(...(await gt.trendingPools(c.gt, '1h')).map((p) => toPair(p, c, true)));
          this.ledger.upsertPools(pairs);
        } catch (e) {
          console.warn(`[scanner] ${c.id}: ${(e as Error).message}`);
        }
      }),
    );

    // Poll trades on the most active recent pools, favouring ones we haven't looked at for a while.
    const now = Date.now();
    const candidates = this.ledger.pools({ sinceCreated: now - 48 * 3_600_000, limit: 500 }).filter((p) => p.trending || now - p.createdAt < 24 * 3_600_000);
    const ranked = candidates
      .map((p) => ({ p, prio: Math.log1p(p.volume.h1 + p.volume.m5 * 6) * Math.min(30, (now - (this.lastPolled.get(p.id) ?? 0)) / 60_000) }))
      .sort((a, b) => b.prio - a.prio)
      .slice(0, SCAN.poolsPerCycle);

    for (const { p } of ranked) {
      const chain = MEME_CHAINS.find((c) => c.id === p.chain)!;
      try {
        const trades = await gt.poolTrades(chain.gt, p.address, p.baseAddress);
        this.lastPolled.set(p.id, Date.now());
        const fresh = this.ledger.insertTrades(trades.map((t) => ({ ...t, chain: p.chain, pool: p.address })));
        if (fresh.length) this.alerts.onTrades(p, fresh);
      } catch (e) {
        console.warn(`[scanner] trades ${p.id}: ${(e as Error).message}`);
      }
    }
  }

  private async refreshSeeds() {
    if (MEME_CHAINS.some((c) => c.id === 'hyperevm')) {
      try {
        const rows = await hl.leaderboard();
        const seeds: SeedStats[] = rows.map((r) => ({
          wallet: r.wallet,
          chain: 'hyperevm',
          label: r.label ? `HL: ${r.label}` : undefined,
          roi: r.monthRoi,
          pnlUsd: r.monthPnl,
          investedUsd: r.accountValue,
          legitScore: Math.min(95, 60 + Math.round(Math.log10(Math.max(r.monthPnl, 1)) * 5)),
          flags: ['hl-perps-30d'],
          tier: r.accountValue > 1_000_000 ? 'whale' : 'smart',
          lastActive: Date.now(),
        }));
        this.ledger.replaceSeeds('hyperliquid', seeds);
        console.log(`[seeds] hyperliquid leaderboard: ${seeds.length} wallets`);
      } catch (e) {
        console.warn(`[seeds] hyperliquid: ${(e as Error).message}`);
      }
    }
    if (dune.duneEnabled()) {
      try {
        const rows = await dune.topTraders();
        const seeds: SeedStats[] = rows
          .filter((r) => DUNE_CHAIN[r.chain])
          .map((r) => ({
            wallet: r.wallet,
            chain: DUNE_CHAIN[r.chain],
            roi: r.investedUsd > 0 ? (r.returnedUsd - r.investedUsd) / r.investedUsd : 0,
            pnlUsd: r.returnedUsd - r.investedUsd,
            realizedUsd: r.returnedUsd - r.investedUsd,
            investedUsd: r.investedUsd,
            trades: r.trades,
            tokens: r.tokens,
            wins: r.wins,
            winRate: r.tokens ? r.wins / r.tokens : 0,
            lastActive: r.lastActive,
          }));
        this.ledger.replaceSeeds('dune', seeds);
        console.log(`[seeds] dune: ${seeds.length} wallets`);
      } catch (e) {
        console.warn(`[seeds] dune: ${(e as Error).message}`);
      }
    }
  }
}
