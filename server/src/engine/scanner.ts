import type { AlertSettings } from '../../../shared/types.ts';
import { HELIUS, MEME_CHAINS } from '../config.ts';
import { EVM_CHAINS, EvmFeed } from '../feeds/evm.ts';
import { SolanaFeed } from '../feeds/solana.ts';
import { PairTracker, type TradeSink } from '../feeds/tracker.ts';
import * as ds from '../sources/dexscreener.ts';
import * as dune from '../sources/dune.ts';
import * as helius from '../sources/helius.ts';
import * as hl from '../sources/hyperliquid.ts';
import type { Ledger, SeedStats } from './ledger.ts';

export type { TradeSink } from '../feeds/tracker.ts';

const DUNE_CHAIN: Record<string, string> = { bnb: 'bsc', base: 'base', solana: 'solana', robinhood: 'robinhood', hyperevm: 'hyperevm' };

/**
 * Live memescope data, all from the chains themselves:
 * - Solana: launches from PumpPortal (free), trades from Helius (free key, credit-budgeted)
 * - Base, BNB, HyperEVM, Robinhood: pools and swaps over public RPC
 * - DexScreener for pair stats (price, liquidity, volume) and logos
 */
export class LiveScanner {
  static stats = {
    cycles: 0,
    lastCycleAt: 0,
    pairsSeen: 0,
    tradesSeen: 0,
    errors: [] as { at: number; msg: string }[],
    feeds: {} as Record<string, unknown>,
  };
  private tracker: PairTracker;
  private solana?: SolanaFeed;
  private evm: EvmFeed[] = [];
  private imageTried = new Map<string, number>();

  constructor(
    private ledger: Ledger,
    private onTrades: TradeSink,
    private settings: () => AlertSettings,
  ) {
    const sink: TradeSink = (pair, fresh, now) => {
      LiveScanner.stats.tradesSeen += fresh.length;
      this.onTrades(pair, fresh, now);
    };
    this.tracker = new PairTracker(ledger, sink, (chain, wallet) => this.ledger.qualifies(this.ledger.get(chain, wallet), this.settings()));
  }

  private note(msg: string) {
    console.warn(`[scanner] ${msg}`);
    LiveScanner.stats.errors = [{ at: Date.now(), msg: msg.slice(0, 200) }, ...LiveScanner.stats.errors].slice(0, 8);
  }

  /** Auto mode: live if DexScreener answers (it backs every chain's pair stats). */
  static async probe(): Promise<boolean> {
    try {
      await ds.latestProfiles();
      return true;
    } catch (e) {
      console.warn(`[scanner] DexScreener unreachable: ${(e as Error).message}`);
      return false;
    }
  }

  /** Solana wallets worth watching: your watchlist first, then the best qualifying traders. */
  private solanaWallets = () => {
    const st = this.settings();
    return this.ledger
      .allStats()
      .filter((s) => s.chain === 'solana' && (s.watched || this.ledger.qualifies(s, st)))
      .sort((a, b) => Number(b.watched) - Number(a.watched) || b.legitScore - a.legitScore)
      .map((s) => s.wallet);
  };

  start() {
    const chains = new Set(MEME_CHAINS.map((c) => c.id));
    if (chains.has('solana')) {
      this.solana = new SolanaFeed(this.tracker, this.solanaWallets);
      this.solana.start();
    }
    for (const cfg of EVM_CHAINS) {
      if (!chains.has(cfg.id)) continue;
      const f = new EvmFeed(cfg, this.tracker);
      f.start();
      this.evm.push(f);
    }
    const cycle = async () => {
      LiveScanner.stats.cycles++;
      LiveScanner.stats.lastCycleAt = Date.now();
      await this.tracker.refresh().catch((e) => this.note(`pair stats: ${(e as Error).message}`));
      await this.enrichImages().catch((e) => this.note(`logos: ${(e as Error).message}`));
      LiveScanner.stats.pairsSeen = this.tracker.stats.promoted;
      LiveScanner.stats.feeds = {
        tracker: this.tracker.stats,
        solana: this.solana ? { ...this.solana.stats, helius: helius.heliusEnabled() ? { spentToday: helius.budget.spentToday, dailyCap: HELIUS.dailyCredits, availableNow: Math.round(helius.budget.available()) } : 'no HELIUS_API_KEY' } : undefined,
        ...Object.fromEntries(this.evm.map((f, i) => [EVM_CHAINS.filter((c) => chains.has(c.id))[i].id, f.stats])),
      };
    };
    const loop = () => void cycle().finally(() => setTimeout(loop, 20_000).unref());
    loop();
    void this.refreshSeeds();
    setInterval(() => void this.refreshSeeds(), 6 * 3_600_000).unref();
    setInterval(() => this.ledger.prune(), 3_600_000).unref();
  }

  /** Creator logos from DexScreener profiles for shown pairs that still have none. */
  private async enrichImages() {
    const now = Date.now();
    const dsToOurs = new Map(MEME_CHAINS.map((c) => [ds.dsChain(c.id), c.id]));
    for (const p of await ds.latestProfiles().catch(() => [])) {
      const chain = dsToOurs.get(p.chain);
      if (chain) this.ledger.setTokenImage(chain, p.token, p.icon);
    }
    const missing = this.ledger
      .pools({ sinceCreated: now - 24 * 3_600_000, limit: 500 })
      .filter((p) => !p.imageUrl && !this.ledger.hasTokenImage(p.chain, p.baseAddress) && now - (this.imageTried.get(p.id) ?? 0) > 20 * 60_000);
    const byChain = new Map<string, string[]>();
    for (const p of missing) {
      this.imageTried.set(p.id, now);
      byChain.set(p.chain, [...(byChain.get(p.chain) ?? []), p.baseAddress]);
    }
    let calls = 0;
    for (const [chain, tokens] of byChain) {
      for (let i = 0; i < tokens.length && calls < 3; i += 30, calls++) {
        for (const [token, url] of await ds.tokenImages(chain, tokens.slice(i, i + 30))) this.ledger.setTokenImage(chain, token, url);
      }
    }
    if (this.imageTried.size > 20_000) this.imageTried.clear();
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
        this.note(`hyperliquid leaderboard: ${(e as Error).message}`);
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
        this.note(`dune: ${(e as Error).message}`);
      }
    }
  }
}
