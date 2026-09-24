import type { Pair } from '../../../shared/types.ts';
import { BLOCK_MS, MEME_CHAINS, ROI_WINDOW_DAYS } from '../config.ts';
import { fakeAddress, gauss, mulberry32, pick, type Rng } from '../rand.ts';
import type { AlertEngine } from './alerts.ts';
import type { TradeSink } from './scanner.ts';
import { detectLaunchpad } from '../launchpads.ts';
import type { Ledger } from './ledger.ts';
import type { LedgerTrade } from './roi.ts';

// A small synthetic memecoin market used when live APIs are unreachable (or DATA_MODE=demo).
// Wallets have a hidden skill; skilled wallets pick better pairs, enter earlier and exit near the top,
// so the ROI engine, legit scoring and alerts all have something real to find.

type Kind = 'whale' | 'smart' | 'retail' | 'bot' | 'sniper' | 'ring';
type RingStyle = 'dump' | 'hold' | 'mixed';
interface SimWallet {
  address: string;
  chain: string;
  kind: Kind;
  skill: number;
  size: number;
  label?: string;
  ring?: { id: number; style: RingStyle };
}
interface SimPool {
  pair: Pair;
  p0: number;
  peak: number; // peak multiple
  tPeak: number; // ms after creation
  life: number; // ms
  pending: (LedgerTrade & { tx: string })[];
  done: (LedgerTrade & { tx: string })[];
}

const SUPPLY = 1e9;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WORDS = ['PEPE', 'DOGE', 'CAT', 'FROG', 'MOON', 'BONK', 'WIF', 'CHAD', 'GIGA', 'NEIRO', 'TRUMP', 'MOG', 'BRETT', 'TOSHI', 'HOOD', 'STONK', 'APE', 'PUMP', 'HYPE', 'BASED', 'MEOW', 'SIGMA', 'CLANK', 'KEKW', 'GOAT', 'ZEREBRO', 'BULL', 'WAGMI', 'TENDIE', 'YOLO'];
const DEX: Record<string, string[]> = {
  solana: ['pumpswap', 'raydium', 'meteora'],
  base: ['uniswap-v4', 'aerodrome', 'zora'],
  bsc: ['pancakeswap-v3', 'four-meme'],
  hyperevm: ['hyperswap', 'projectx'],
  robinhood: ['uniswap-v3', 'synthra'],
};
const QUOTE: Record<string, string> = { solana: 'SOL', base: 'WETH', bsc: 'WBNB', hyperevm: 'WHYPE', robinhood: 'WETH' };
// Demo token art: an emoji that fits the name on a gradient, embedded as a data URI so it also
// works in the offline snapshot.
const ART: [RegExp, string][] = [
  [/PEPE|FROG|BRETT|KEK/, '🐸'], [/DOGE|WIF|NEIRO|BONK/, '🐶'], [/CAT|MEOW|TOSHI|MOG/, '🐱'], [/MOON/, '🌕'], [/TRUMP/, '🦅'],
  [/HOOD|STONK/, '📈'], [/APE/, '🦍'], [/PUMP/, '🚀'], [/HYPE/, '⚡'], [/BASED/, '🔵'], [/SIGMA|GIGA|CHAD/, '🗿'], [/GOAT/, '🐐'],
  [/BULL/, '🐂'], [/YOLO/, '🎲'], [/TENDIE/, '🍗'], [/CLANK/, '🤖'], [/ZEREBRO/, '🧠'], [/WAGMI/, '🤝'],
];
function tokenArt(sym: string, r: Rng): string {
  const emoji = ART.find(([re]) => re.test(sym))?.[1] ?? '🪙';
  const h1 = Math.floor(r() * 360);
  const h2 = (h1 + 40 + Math.floor(r() * 80)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h1},70%,55%)"/><stop offset="1" stop-color="hsl(${h2},70%,35%)"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><text x="32" y="44" font-size="34" text-anchor="middle">${emoji}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const HANDLES = ['cupsey', 'orangie', 'ansem.eth', 'frankdegods', 'cented', 'loopierr', 'daumen', 'waddles', 'jidn', 'euris', 'mitch', 'kev', 'gake', 'bastille', 'nach'];

export class DemoMarket {
  private rng: Rng = mulberry32(42);
  private wallets: SimWallet[] = [];
  private pools: SimPool[] = [];
  private txn = 0;

  constructor(
    private ledger: Ledger,
    private alerts: AlertEngine,
    private onTrades: TradeSink,
    /** Runs derived analyses (sniper rings) once history exists, before live ticks. */
    private warm: () => void = () => {},
  ) {}

  private priceAt(p: SimPool, t: number): number {
    const dt = t - p.pair.createdAt;
    if (dt <= 0) return p.p0;
    if (dt <= p.tPeak) return p.p0 * (1 + (p.peak - 1) * Math.pow(dt / p.tPeak, 1.6));
    const decay = Math.exp((-3 * (dt - p.tPeak)) / Math.max(p.life - p.tPeak, 1));
    return p.p0 * Math.max(0.03, p.peak * decay);
  }

  private makeWallets() {
    const plan: [Kind, number][] = [['whale', 6], ['smart', 14], ['retail', 90], ['bot', 6], ['sniper', 8]];
    let h = 0;
    for (const c of MEME_CHAINS) {
      for (const [kind, n] of plan) {
        for (let i = 0; i < n; i++) {
          const skill = kind === 'whale' ? 0.75 + this.rng() * 0.2 : kind === 'smart' ? 0.6 + this.rng() * 0.3 : kind === 'sniper' ? 0.5 : kind === 'bot' ? 0.4 : this.rng() * 0.5;
          const size = kind === 'whale' ? 3_000 + this.rng() * 22_000 : kind === 'smart' ? 800 + this.rng() * 4_000 : kind === 'bot' ? 150 : kind === 'sniper' ? 400 : 40 + this.rng() * 600;
          this.wallets.push({
            address: fakeAddress(this.rng, c.id),
            chain: c.id,
            kind,
            skill,
            size,
            label: kind === 'whale' && h < HANDLES.length ? HANDLES[h++] : undefined,
          });
        }
      }
      // Sniper rings: wallets that bundle into the launch block together, then exit by style.
      const styles: [RingStyle, number][] = [['dump', 5], ['dump', 3], ['hold', 4], ['mixed', 3]];
      styles.forEach(([style, size], k) => {
        for (let i = 0; i < size; i++) {
          this.wallets.push({ address: fakeAddress(this.rng, c.id), chain: c.id, kind: 'ring', skill: 0.5, size: 300 + this.rng() * 1_700, ring: { id: k, style } });
        }
      });
    }
  }

  private makePool(chain: string, createdAt: number, compressed: boolean): SimPool {
    const r = this.rng;
    const sym = pick(r, WORDS) + (r() < 0.4 ? pick(r, WORDS).slice(0, 3) : '');
    const address = fakeAddress(r, chain);
    let token = fakeAddress(r, chain);
    const dex = pick(r, DEX[chain] ?? ['dex']);
    // Launchpads grind vanity suffixes into their mints: pump.fun …pump, letsbonk …bonk, four.meme …4444.
    if (chain === 'solana') token = token.slice(0, -4) + (r() < 0.65 ? 'pump' : r() < 0.5 ? 'bonk' : token.slice(-4));
    if (chain === 'bsc' && dex === 'four-meme') token = token.slice(0, -4) + '4444';
    // Heavy-tailed outcome: most pairs die, a few run 10-100x.
    const peak = Math.max(1.05, Math.exp(0.2 + gauss(r) * 1.1));
    const life = (compressed ? 20 * 60_000 + r() * 90 * 60_000 : 6 * HOUR + r() * 60 * HOUR);
    const tPeak = life * (0.08 + r() * 0.35);
    const p0 = 5e-5 * (0.5 + r()); // ~$25-75K launch mcap
    const pair: Pair = {
      id: `${chain}:${address}`, chain, address, dex, name: `${sym} / ${QUOTE[chain] ?? 'USD'}`,
      baseSymbol: sym, baseAddress: token, imageUrl: r() < 0.85 ? tokenArt(sym, r) : undefined, launchpad: detectLaunchpad(chain, dex, token), quoteSymbol: QUOTE[chain] ?? 'USD', createdAt, priceUsd: p0, mcap: p0 * SUPPLY,
      liquidity: p0 * SUPPLY * 0.12, volume: { m5: 0, h1: 0, h24: 0 }, txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
      change: { m5: 0, h1: 0, h24: 0 }, trending: false, smartWallets: [], url: '',
    };
    const pool: SimPool = { pair, p0, peak, tPeak, life, pending: [], done: [] };
    this.schedule(pool);
    return pool;
  }

  private schedule(p: SimPool) {
    const r = this.rng;
    const chain = p.pair.chain;
    const quality = Math.log(p.peak + 1); // what skilled wallets can "see"
    // One decision per ring per launch, so members act together.
    const plans = new Map<number, { join: boolean; delay: number; exit: number }>();
    for (let k = 0; k < 4; k++) plans.set(k, { join: r() < 0.3, delay: 300 + r() * 2_200, exit: 60_000 + r() * 180_000 });
    for (const w of this.wallets) {
      if (w.chain !== chain) continue;
      if (w.ring) {
        const plan = plans.get(w.ring.id)!;
        if (!plan.join || r() > 0.85) continue;
        const exit =
          w.ring.style === 'dump' ? plan.exit + gauss(r) * 10_000 : w.ring.style === 'hold' ? 70 * 60_000 + plan.exit * 20 + gauss(r) * 60_000 : 60_000 + r() * 120 * 60_000;
        this.pushTrades(p, w, [
          { t: plan.delay, kind: 'buy', frac: 1 },
          { t: Math.max(plan.delay + 5_000, exit), kind: 'sell', frac: w.ring.style === 'mixed' ? 0.3 + r() * 0.7 : 1 },
        ]);
        continue;
      }
      const base = w.kind === 'retail' ? 0.12 : w.kind === 'bot' ? 0.6 : w.kind === 'sniper' ? 0.5 : 0.1;
      const pickiness = w.kind === 'whale' || w.kind === 'smart' ? Math.pow(quality / 2.2, 3 * w.skill) : 1;
      if (r() > base * pickiness) continue;

      const trades: { t: number; kind: 'buy' | 'sell'; frac: number }[] = [];
      if (w.kind === 'bot') {
        // Round-trips with near-zero hold: lots of trades, ~flat PnL.
        const n = 6 + Math.floor(r() * 10);
        for (let i = 0; i < n; i++) {
          const t = r() * p.life * 0.8;
          trades.push({ t, kind: 'buy', frac: 1 }, { t: t + 5_000 + r() * 20_000, kind: 'sell', frac: 1 });
        }
      } else if (w.kind === 'sniper') {
        // Solo sniper: in within ~3s of the pair going live, out within a minute or two.
        const t = 400 + r() * 2_600;
        trades.push({ t, kind: 'buy', frac: 1 }, { t: t + 20_000 + r() * 70_000, kind: 'sell', frac: 1 });
      } else {
        const tb = w.skill > 0.55 ? p.tPeak * (1 - w.skill) * r() : p.tPeak * (0.4 + r() * 0.9);
        const exitNoise = (1 - w.skill) * p.life * 0.5;
        const ts = Math.max(tb + 60_000, p.tPeak + gauss(r) * exitNoise * 0.5 + (w.skill > 0.55 ? 0 : exitNoise));
        trades.push({ t: tb, kind: 'buy', frac: 1 });
        if (r() < 0.35) trades.push({ t: tb + (ts - tb) * 0.3, kind: 'buy', frac: 0.5 });
        if (r() < 0.85) {
          trades.push({ t: ts, kind: 'sell', frac: 0.6 });
          trades.push({ t: ts + r() * p.life * 0.2, kind: 'sell', frac: 1 });
        }
      }
      this.pushTrades(p, w, trades);
    }
    p.pending.sort((a, b) => a.ts - b.ts);
  }

  private pushTrades(p: SimPool, w: SimWallet, trades: { t: number; kind: 'buy' | 'sell'; frac: number }[]) {
    const r = this.rng;
    const chain = p.pair.chain;
    {
      trades.sort((a, b) => a.t - b.t);
      let held = 0;
      for (const tr of trades) {
        const at = p.pair.createdAt + tr.t;
        const px = this.priceAt(p, at) * (1 + gauss(r) * 0.03);
        let qty: number;
        let usd: number;
        if (tr.kind === 'buy') {
          usd = w.size * tr.frac * (0.6 + r() * 0.8);
          qty = usd / px;
          held += qty;
        } else {
          qty = held * tr.frac;
          if (qty <= 0) continue;
          usd = qty * px;
          held -= qty;
        }
        const ts = Math.round(at);
        p.pending.push({ tx: `sim${++this.txn}`, chain, pool: p.pair.address, wallet: w.address, token: p.pair.baseAddress, kind: tr.kind, qty, usd, ts, block: Math.floor(ts / (BLOCK_MS[chain] ?? 1_000)) });
      }
    }
  }

  private refreshPair(p: SimPool, now: number) {
    const pr = p.pair;
    const vol = (ms: number) => p.done.filter((t) => t.ts > now - ms).reduce((s, t) => s + t.usd, 0);
    const cnt = (ms: number, k: 'buy' | 'sell') => p.done.filter((t) => t.ts > now - ms && t.kind === k).length;
    const px = this.priceAt(p, now);
    const ch = (ms: number) => px / this.priceAt(p, now - ms) - 1;
    pr.priceUsd = px;
    pr.mcap = px * SUPPLY;
    pr.liquidity = Math.max(2_000, pr.mcap * 0.1);
    pr.volume = { m5: vol(5 * 60_000), h1: vol(HOUR), h24: vol(DAY) };
    pr.txns = { h1: { buys: cnt(HOUR, 'buy'), sells: cnt(HOUR, 'sell') }, h24: { buys: cnt(DAY, 'buy'), sells: cnt(DAY, 'sell') } };
    pr.change = { m5: ch(5 * 60_000), h1: ch(HOUR), h24: ch(DAY) };
    pr.trending = pr.volume.h1 > 40_000;
  }

  private flush(p: SimPool, now: number, withAlerts: boolean) {
    let i = 0;
    while (i < p.pending.length && p.pending[i].ts <= now) i++;
    if (!i) return;
    const due = p.pending.splice(0, i);
    p.done.push(...due);
    const fresh = this.ledger.insertTrades(due);
    this.refreshPair(p, now);
    this.ledger.upsertPools([p.pair]);
    if (withAlerts && fresh.length) this.onTrades(p.pair, fresh, now);
  }

  /** Builds ~60 days of history, then keeps the market ticking in real time. */
  start() {
    const t0 = Date.now();
    this.makeWallets();
    // Named whales stand in for KOL wallets a user would add to their watchlist by hand.
    for (const w of this.wallets) if (w.label) this.ledger.addWatch(w.chain, w.address, w.label);
    const now = Date.now();
    for (const c of MEME_CHAINS) {
      for (let d = ROI_WINDOW_DAYS; d >= 0; d--) {
        const n = 3 + Math.floor(this.rng() * 3);
        for (let i = 0; i < n; i++) {
          const createdAt = now - d * DAY - this.rng() * DAY;
          if (createdAt > now - HOUR) continue;
          this.pools.push(this.makePool(c.id, createdAt, false));
        }
      }
    }
    this.alerts.deliver = false;
    for (const p of this.pools) this.flush(p, now, false);
    this.warm();
    // A few fresh pairs so the memescope and alert feed aren't empty on first load.
    for (const c of MEME_CHAINS) for (let i = 0; i < 3; i++) this.pools.push(this.makePool(c.id, now - this.rng() * 45 * 60_000, true));
    for (const p of this.pools.slice(-MEME_CHAINS.length * 3)) this.flush(p, now, true);
    this.alerts.deliver = true;

    // Demo-only seeds so the HyperEVM column shows the Hyperliquid-leaderboard path.
    const hl = this.wallets.filter((w) => w.chain === 'hyperevm' && w.kind === 'whale').slice(0, 3);
    this.ledger.replaceSeeds(
      'hyperliquid',
      hl.map((w, i) => ({ wallet: w.address, chain: 'hyperevm', label: `HL: perp-whale-${i + 1}`, roi: 0.4 + i * 0.2, pnlUsd: 2e6 / (i + 1), investedUsd: 6e6, legitScore: 88 - i * 4, flags: ['hl-perps-30d'], tier: 'whale', lastActive: now, tokens: 0 })),
    );
    const c = this.ledger.counts();
    console.log(`[demo] simulated ${c.pools} pairs, ${c.trades} trades, ${c.wallets} wallets in ${Date.now() - t0}ms`);

    setInterval(() => this.tick(), 3_000).unref();
  }

  private tick() {
    const now = Date.now();
    if (this.rng() < 0.18) this.pools.push(this.makePool(pick(this.rng, MEME_CHAINS).id, now, true));
    for (const p of this.pools) if (p.pending.length) this.flush(p, now, true);
    // Keep memory bounded; the ledger holds the history.
    if (this.pools.length > 2_000) this.pools = this.pools.filter((p) => p.pending.length || now - p.pair.createdAt < 2 * DAY);
    for (const p of this.pools) if (now - p.pair.createdAt < DAY && !p.pending.length) p.done = p.done.filter((t) => t.ts > now - DAY);
  }
}
