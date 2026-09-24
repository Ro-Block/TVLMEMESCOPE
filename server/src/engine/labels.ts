import type { Db } from '../db.ts';
import { arkhamEnabled, lookup } from '../sources/arkham.ts';

const TTL = 7 * 86_400_000;
const HOURLY_MAX = Number(process.env.ARKHAM_HOURLY_LOOKUPS ?? 150);

/**
 * Wallet names from Arkham, cached in the local database for a week (including "no label"), so
 * each wallet costs at most one lookup per week. Only wallets the app actually shows are looked up.
 */
export class WalletLabels {
  private cache = new Map<string, { name: string | null; type?: string }>();
  private queue: string[] = [];
  private spentThisHour = 0;
  private hour = 0;
  stats = { lookups: 0, labelled: 0 };

  constructor(private db: Db) {
    db.exec('CREATE TABLE IF NOT EXISTS wallet_labels (wallet TEXT PRIMARY KEY, name TEXT, type TEXT, checked_at INTEGER NOT NULL)');
    const since = Date.now() - TTL;
    for (const r of db.prepare('SELECT wallet, name, type FROM wallet_labels WHERE checked_at >= ?').all(since) as { wallet: string; name: string | null; type: string | null }[]) {
      this.cache.set(r.wallet, { name: r.name, type: r.type ?? undefined });
    }
  }

  /** Cached name, or undefined (and queues a lookup when enabled). */
  get(wallet: string): string | undefined {
    const c = this.cache.get(wallet);
    if (c) return c.name ?? undefined;
    if (arkhamEnabled() && !this.queue.includes(wallet) && this.queue.length < 500) this.queue.push(wallet);
    return undefined;
  }

  start() {
    if (!arkhamEnabled()) return;
    const step = async () => {
      const h = Math.floor(Date.now() / 3_600_000);
      if (h !== this.hour) {
        this.hour = h;
        this.spentThisHour = 0;
      }
      for (let i = 0; i < 10 && this.queue.length && this.spentThisHour < HOURLY_MAX; i++) {
        const w = this.queue.shift()!;
        if (this.cache.has(w)) continue;
        this.spentThisHour++;
        const label = await lookup(w).catch(() => undefined);
        if (label === undefined) continue; // failed: try again another time
        this.stats.lookups++;
        if (label) this.stats.labelled++;
        this.cache.set(w, { name: label?.name ?? null, type: label?.type });
        this.db.prepare('INSERT OR REPLACE INTO wallet_labels (wallet, name, type, checked_at) VALUES (?, ?, ?, ?)').run(w, label?.name ?? null, label?.type ?? null, Date.now());
      }
    };
    setInterval(() => void step(), 30_000).unref();
  }
}
