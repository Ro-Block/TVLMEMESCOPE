import type { Alert, AlertSettings, Pair } from '../../../shared/types.ts';
import { ROI_WINDOW_DAYS } from '../config.ts';
import type { Db } from '../db.ts';
import { notify } from '../notify.ts';
import type { Ledger } from './ledger.ts';
import type { LedgerTrade } from './roi.ts';

type Listener = (a: Alert) => void;

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;
const usd = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${n.toFixed(0)}`);

export class AlertEngine {
  private listeners = new Set<Listener>();
  private recent = new Map<string, number>(); // dedupe key -> ts
  /** Demo backfill runs with delivery off so replayed history doesn't spam Telegram. */
  deliver = true;

  constructor(
    private db: Db,
    private ledger: Ledger,
    private settings: () => AlertSettings,
  ) {}

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list(limit = 200): Alert[] {
    return (this.db.prepare('SELECT json FROM alerts ORDER BY ts DESC LIMIT ?').all(limit) as { json: string }[]).map((r) => JSON.parse(r.json));
  }

  private seen(k: string, ttlMs: number, now: number) {
    const at = this.recent.get(k);
    if (at !== undefined && now - at < ttlMs) return true;
    this.recent.set(k, now);
    if (this.recent.size > 5_000) for (const [kk, t] of this.recent) if (now - t > 86_400_000) this.recent.delete(kk);
    return false;
  }

  /** Call with the trades that were new in this poll for one pair. */
  onTrades(pair: Pair, fresh: LedgerTrade[], now = Date.now()): Alert[] {
    const st = this.settings();
    if (!st.chains.includes(pair.chain)) return [];
    const ageMin = (now - pair.createdAt) / 60_000;
    if (ageMin > st.maxPairAgeHours * 60) return [];

    const out: Alert[] = [];
    const buys = new Map<string, number>();
    for (const t of fresh) if (t.kind === 'buy') buys.set(t.wallet, (buys.get(t.wallet) ?? 0) + t.usd);

    const pairInfo = { id: pair.id, name: pair.name, symbol: pair.baseSymbol, address: pair.baseAddress, ageMin, mcap: pair.mcap, liquidity: pair.liquidity, url: pair.url, imageUrl: pair.imageUrl ?? pair.imageFallbackUrl, launchpad: pair.launchpad };

    for (const [wallet, amount] of buys) {
      if (amount < st.minBuyUsd) continue;
      const s = this.ledger.get(pair.chain, wallet);
      if (!this.ledger.qualifies(s, st) || this.seen(`w:${pair.id}:${wallet}`, 6 * 3_600_000, now)) continue;
      const who = s!.label ?? short(wallet);
      out.push({
        id: `${now}-w-${pair.id}-${wallet}`,
        ts: now,
        kind: 'whale_buy',
        chain: pair.chain,
        pair: pairInfo,
        wallets: [{ wallet, usd: amount, roi: s!.roi, legitScore: s!.legitScore, tier: s!.tier, label: s!.label }],
        usd: amount,
        message: `${s!.tier === 'whale' ? '🐋' : '🧠'} ${who} (${s!.source === 'hyperliquid' ? 'HL 30d' : `${ROI_WINDOW_DAYS}d`} ROI ${(s!.roi * 100).toFixed(0)}%, score ${s!.legitScore}) bought ${usd(amount)} of ${pair.baseSymbol} on ${pair.chain} — pair ${Math.round(ageMin)}m old, mcap ${usd(pair.mcap)}`,
      });
    }

    if (buys.size) {
      const since = now - st.clusterWindowMin * 60_000;
      const rows = this.db
        .prepare("SELECT wallet, SUM(usd) usd FROM trades WHERE chain = ? AND pool = ? AND kind = 'buy' AND ts >= ? GROUP BY wallet")
        .all(pair.chain, pair.address, since) as { wallet: string; usd: number }[];
      const smart = rows
        .map((r) => ({ r, s: this.ledger.get(pair.chain, r.wallet) }))
        // Dust buys don't make a wallet part of a cluster.
        .filter(({ r, s }) => r.usd >= st.minBuyUsd && this.ledger.qualifies(s, st));
      if (smart.length >= st.clusterSize && !this.seen(`c:${pair.id}`, st.clusterWindowMin * 60_000, now)) {
        const total = smart.reduce((a, x) => a + x.r.usd, 0);
        out.push({
          id: `${now}-c-${pair.id}`,
          ts: now,
          kind: 'cluster',
          chain: pair.chain,
          pair: pairInfo,
          wallets: smart.map(({ r, s }) => ({ wallet: r.wallet, usd: r.usd, roi: s!.roi, legitScore: s!.legitScore, tier: s!.tier, label: s!.label })).sort((a, b) => b.usd - a.usd),
          usd: total,
          message: `🚨 ${smart.length} smart wallets bought ${pair.baseSymbol} on ${pair.chain} within ${st.clusterWindowMin}m (${usd(total)} total) — pair ${Math.round(ageMin)}m old`,
        });
      }
    }

    for (const a of out) this.emit(a);
    return out;
  }

  emit(a: Alert) {
    this.db.prepare('INSERT OR REPLACE INTO alerts (id, ts, json) VALUES (?, ?, ?)').run(a.id, a.ts, JSON.stringify(a));
    for (const l of this.listeners) l(a);
    if (this.deliver) notify(a, this.settings()).catch((e) => console.warn('[notify]', e.message));
  }
}
