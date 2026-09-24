import * as helius from '../sources/helius.ts';
import { connectPumpPortal, metadataImage, type NewToken } from '../sources/pumpportal.ts';
import { nativeUsd } from '../sources/prices.ts';
import type { PairTracker, Trade } from './tracker.ts';

const QUOTE_MINTS = new Set([helius.WSOL, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

interface Cursor {
  newest?: string; // newest signature already fetched
  backfilled: boolean;
  lastPoll: number;
}

/**
 * Solana: launches from PumpPortal (free), trades from Helius on promoted tokens and on watched /
 * smart wallets, within the daily credit budget.
 */
export class SolanaFeed {
  private cursors = new Map<string, Cursor>(); // mint or wallet -> cursor
  private queue: { sig: string; mints?: Set<string> }[] = [];
  private queuedAt = 0;
  private creates = new Map<string, string>(); // mint -> create signature
  stats = { launches: 0, parsedTxs: 0, trades: 0, walletChecks: 0 };

  constructor(
    private tracker: PairTracker,
    /** Watched + qualifying Solana wallets, most important first. */
    private wallets: () => string[],
  ) {}

  start() {
    connectPumpPortal((t) => this.onLaunch(t));
    if (!helius.heliusEnabled()) {
      console.warn('[solana] no HELIUS_API_KEY in .env: launches and pair stats work, wallet trades need a free Helius key');
      return;
    }
    const loop = () => void this.tick().catch((e) => console.warn(`[solana] ${(e as Error).message}`)).finally(() => setTimeout(loop, 15_000).unref());
    loop();
  }

  private async onLaunch(t: NewToken) {
    this.stats.launches++;
    this.creates.set(t.mint, t.signature);
    const c = this.tracker.add({
      chain: 'solana',
      token: t.mint,
      pool: t.mint,
      createdAt: t.receivedAt,
      dex: t.pool === 'bonk' ? 'letsbonk' : 'pumpfun',
      launchpad: t.pool === 'bonk' ? 'letsbonk.fun' : 'pump.fun',
      symbol: t.symbol,
      name: t.name,
      quoteSymbol: 'SOL',
      creator: t.creator,
      resolveImage: () => metadataImage(t.uri),
    });
    // The creator's buy inside the create transaction is the first trade of the launch.
    if (t.solAmount > 0 && t.initialBuy > 0) {
      const sol = await nativeUsd('solana');
      if (sol > 0) {
        this.tracker.record('solana', c.pool, [{ tx: t.signature, chain: 'solana', pool: c.pool, wallet: t.creator, token: t.mint, kind: 'buy', qty: t.initialBuy, usd: t.solAmount * sol, ts: t.receivedAt }]);
      }
    }
    if (this.creates.size > 50_000) this.creates.clear();
  }

  private async tick() {
    const now = Date.now();
    // 1. Newly promoted tokens: backfill from their first trade so snipers and bundles are visible.
    for (const c of this.tracker.promoted('solana')) {
      const cur = this.cursors.get(c.token) ?? { backfilled: false, lastPoll: 0 };
      this.cursors.set(c.token, cur);
      if (cur.backfilled) continue;
      if (!(await this.backfill(c.token, cur))) break; // out of budget for now
    }

    // 2. Watched / smart wallets: what did they trade since we last looked?
    for (const w of this.wallets().slice(0, 25)) {
      const cur = this.cursors.get(w) ?? { backfilled: true, lastPoll: 0 };
      this.cursors.set(w, cur);
      if (now - cur.lastPoll < 10 * 60_000) continue;
      const first = !cur.newest;
      const sigs = await helius.signatures(w, { limit: first ? 1 : 50, until: cur.newest }).catch(() => null);
      if (!sigs) break;
      cur.lastPoll = now;
      this.stats.walletChecks++;
      if (sigs.length) cur.newest = sigs[0].signature;
      // The first look at a wallet only records where it is; alerts are about what it does next.
      if (first) continue;
      for (const s of sigs) this.enqueue(s.signature);
    }

    // 3. Active promoted tokens: new trades since the last poll, busiest first.
    const active = this.tracker
      .promoted('solana')
      .filter((c) => c.pair)
      .sort((a, b) => (b.pair!.volume.h1 || 0) - (a.pair!.volume.h1 || 0));
    for (const c of active.slice(0, 20)) {
      const cur = this.cursors.get(c.token);
      if (!cur?.backfilled || now - cur.lastPoll < 90_000) continue;
      const sigs = await helius.signatures(c.token, { limit: 100, until: cur.newest }).catch(() => null);
      if (!sigs) break;
      cur.lastPoll = now;
      if (sigs.length) cur.newest = sigs[0].signature;
      for (const s of sigs) this.enqueue(s.signature, new Set([c.token]));
    }

    await this.flush(now);
  }

  /** Pages back to the token's first trade (≤3 pages), then parses the opening and latest trades. */
  private async backfill(mint: string, cur: Cursor): Promise<boolean> {
    const create = this.creates.get(mint);
    const all: helius.SigInfo[] = [];
    let before: string | undefined;
    for (let page = 0; page < 3; page++) {
      const sigs = await helius.signatures(mint, { limit: 1000, before }).catch(() => null);
      if (!sigs) return false;
      all.push(...sigs);
      if (sigs.length < 1000 || (create && sigs.some((s) => s.signature === create))) break;
      before = sigs.at(-1)!.signature;
    }
    cur.backfilled = true;
    cur.lastPoll = Date.now();
    if (all.length) cur.newest = all[0].signature;
    const oldest = all.slice(-100).reverse();
    const newest = all.length > 100 ? all.slice(0, 100) : [];
    for (const s of [...oldest, ...newest]) this.enqueue(s.signature, new Set([mint]));
    return true;
  }

  private enqueue(sig: string, mints?: Set<string>) {
    if (!this.queue.length) this.queuedAt = Date.now();
    this.queue.push({ sig, mints });
  }

  /** Parses queued signatures 100 at a time (one call each), when full or after 45 s. */
  private async flush(now: number) {
    while (this.queue.length >= 100 || (this.queue.length && now - this.queuedAt > 45_000)) {
      const batch = this.queue.splice(0, 100);
      this.queuedAt = now;
      const parsed = await helius.parse(batch.map((b) => b.sig)).catch(() => null);
      if (!parsed) {
        this.queue.unshift(...batch); // over budget: try again later
        return;
      }
      this.stats.parsedTxs += parsed.length;
      const sol = await nativeUsd('solana');
      if (!sol) return;
      const wanted = new Map(batch.map((b) => [b.sig, b.mints]));
      for (const tx of parsed) {
        // Wallet-sourced transactions: every non-quote token the signer's balance changed in.
        const mints = wanted.get(tx.signature) ?? new Set((tx.accountData ?? []).flatMap((a) => (a.tokenBalanceChanges ?? []).filter((c) => c.userAccount === tx.feePayer).map((c) => c.mint)).filter((m) => !QUOTE_MINTS.has(m)));
        for (const t of helius.tradesFromParsed(tx, mints, sol)) this.deliver(t);
      }
    }
  }

  private deliver(t: helius.SolTrade) {
    let c = this.tracker.get('solana', t.mint);
    // A tracked wallet traded a token we didn't know yet (e.g. a Raydium or Meteora pair).
    // Its creation time is unknown here (0); DexScreener fills it in, so the wallet isn't mistaken for a sniper.
    if (!c) c = this.tracker.add({ chain: 'solana', token: t.mint, pool: t.mint, createdAt: 0, dex: 'solana', quoteSymbol: 'SOL' });
    const trade: Trade = { tx: t.tx, chain: 'solana', pool: c.pool, wallet: t.wallet, token: t.mint, kind: t.kind, qty: t.qty, usd: t.usd, ts: t.ts, block: t.block };
    this.stats.trades++;
    this.tracker.record('solana', c.pool, [trade]);
  }
}
