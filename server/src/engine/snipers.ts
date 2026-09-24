import type { AlertSettings, Launch, LaunchSummary, Pair, Shot, SniperProfile, SniperRing, SnipersResponse } from '../../../shared/types.ts';
import type { Db } from '../db.ts';
import type { AlertEngine } from './alerts.ts';
import type { Ledger } from './ledger.ts';
import type { LedgerTrade } from './roi.ts';
import { analyzeLaunch, buildProfiles, findRings, type ProfileCalc, type RingCalc } from './sniper-analysis.ts';

const LOOKBACK_DAYS = 30;
const RING_NAMES = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

interface Snapshot {
  at: number;
  windowSec: number;
  launches: Launch[];
  byPool: Map<string, Launch>;
  profiles: ProfileCalc[];
  profileByKey: Map<string, ProfileCalc>;
  rings: (RingCalc & { name: string })[];
  ringOf: Map<string, string>; // chain:wallet -> ring id
  links: SnipersResponse['links'];
}

const key = (chain: string, wallet: string) => `${chain}:${wallet}`;

/** Sniper / bundler / ring detection over the first hour of every launch, plus the live "shot" stream. */
export class SniperEngine {
  private snap: Snapshot | null = null;
  private listeners = new Set<(s: Shot) => void>();
  private shots: Shot[] = [];
  /** pair id -> wallets already covered by a ring alert on that pair */
  private ringAlerted = new Map<string, Set<string>>();
  now: () => number = Date.now;

  constructor(
    private db: Db,
    private ledger: Ledger,
    private alerts: AlertEngine,
    private settings: () => AlertSettings,
  ) {}

  subscribe(fn: (s: Shot) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recentShots() {
    return this.shots;
  }

  /** Recomputes at most every 20s (or when the window setting changes). */
  compute(): Snapshot {
    const windowSec = this.settings().sniperWindowSec;
    if (this.snap && this.snap.windowSec === windowSec && this.now() - this.snap.at < 20_000) return this.snap;

    const since = this.now() - LOOKBACK_DAYS * 86_400_000;
    const pools = new Map<string, Pair>();
    for (const p of this.ledger.pools({ sinceCreated: since, limit: 100_000 })) pools.set(`${p.chain}:${p.address}`, p);
    const rows = this.db
      .prepare(
        `SELECT t.chain, t.pool, t.wallet, t.kind, t.token, t.qty, t.usd, t.ts, t.block FROM trades t
         JOIN pools p ON p.chain = t.chain AND p.address = t.pool
         WHERE p.created_at >= ? AND t.ts <= p.created_at + 3600000
         ORDER BY t.chain, t.pool, t.ts`,
      )
      .all(since) as unknown as LedgerTrade[];

    const launches: Launch[] = [];
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j < rows.length && rows[j].pool === rows[i].pool && rows[j].chain === rows[i].chain) j++;
      const pair = pools.get(`${rows[i].chain}:${rows[i].pool}`);
      if (pair) {
        const l = analyzeLaunch({ pair, trades: rows.slice(i, j) }, windowSec);
        if (l.snipers) launches.push(l);
      }
      i = j;
    }

    const profiles = buildProfiles(launches);
    const { links, rings: ringCalcs } = findRings(launches);
    const perChain = new Map<string, number>();
    const rings = ringCalcs.map((r) => {
      const n = perChain.get(r.chain) ?? 0;
      perChain.set(r.chain, n + 1);
      return { ...r, name: `Ring ${RING_NAMES[n % RING_NAMES.length]}${n >= RING_NAMES.length ? Math.floor(n / RING_NAMES.length) : ''}` };
    });
    const ringOf = new Map<string, string>();
    for (const r of rings) for (const m of r.members) ringOf.set(key(r.chain, m), r.id);
    for (const l of launches) {
      for (const b of l.buys) b.ringId = ringOf.get(key(l.pair.chain, b.wallet));
      l.ringIds = [...new Set(l.buys.map((b) => b.ringId).filter((x): x is string => !!x))];
      l.rings = l.ringIds.length;
    }
    launches.sort((a, b) => b.pair.createdAt - a.pair.createdAt);

    this.snap = {
      at: this.now(),
      windowSec,
      launches,
      byPool: new Map(launches.map((l) => [l.pair.id, l])),
      profiles,
      profileByKey: new Map(profiles.map((p) => [key(p.chain, p.wallet), p])),
      rings,
      ringOf,
      links,
    };
    return this.snap;
  }

  /** Uses the last snapshot only, so the ledger can call it without recursion. */
  isSniper(chain: string, wallet: string): boolean {
    const p = this.snap?.profileByKey.get(key(chain, wallet));
    return !!p && p.launches >= 3 && p.medianDelaySec <= this.snap!.windowSec;
  }

  summary(pairId: string): LaunchSummary | undefined {
    const l = this.compute().byPool.get(pairId);
    return l && { snipers: l.snipers, bundled: l.bundled, share: l.share, rings: l.rings, dumped: l.dumped };
  }

  response(opts: { chains: string[]; limit?: number }): SnipersResponse {
    const s = this.compute();
    const inChain = (c: string) => !opts.chains.length || opts.chains.includes(c);
    const profiles: SniperProfile[] = s.profiles
      .filter((p) => p.launches >= 2 && inChain(p.chain))
      .sort((a, b) => b.launches - a.launches || a.medianDelaySec - b.medianDelaySec)
      .slice(0, 300)
      .map((p) => {
        const st = this.ledger.get(p.chain, p.wallet);
        return { ...p, label: st?.label, roi: st ? st.roi : null, pnlUsd: st ? st.pnlUsd : null, ringId: s.ringOf.get(key(p.chain, p.wallet)), watched: !!st?.watched };
      });
    const rings: SniperRing[] = s.rings
      .filter((r) => inChain(r.chain))
      .map((r) => ({ ...r, pnlUsd: r.members.reduce((sum, m) => sum + (this.ledger.get(r.chain, m)?.pnlUsd ?? 0), 0) }));
    return {
      windowSec: s.windowSec,
      launches: s.launches.filter((l) => inChain(l.pair.chain)).slice(0, opts.limit ?? 150),
      profiles,
      rings,
      links: s.links.filter((l) => inChain(l.chain)),
      watchlist: this.ledger.watchlist().filter((w) => inChain(w.chain)),
    };
  }

  /** Called with each poll's new trades: streams shots and raises ring alerts. */
  onTrades(pair: Pair, fresh: LedgerTrade[], now = Date.now()) {
    const st = this.settings();
    const s = this.compute();
    for (const t of fresh) {
      const delaySec = Math.max(0, (t.ts - pair.createdAt) / 1000);
      const ringId = s.ringOf.get(key(pair.chain, t.wallet));
      const sniper = t.kind === 'buy' && delaySec <= st.sniperWindowSec;
      const tracked = ringId || this.isSniper(pair.chain, t.wallet) || this.ledger.get(pair.chain, t.wallet)?.watched;
      if (!sniper && !tracked) continue;
      const shot: Shot = {
        id: `${t.ts}-${t.wallet}-${t.kind}-${Math.round(t.usd)}`,
        ts: t.ts,
        chain: pair.chain,
        wallet: t.wallet,
        kind: t.kind,
        usd: t.usd,
        pairId: pair.id,
        symbol: pair.baseSymbol,
        dex: pair.dex,
        token: pair.baseAddress,
        delaySec,
        sniper,
        ringId,
      };
      this.shots.push(shot);
      if (this.shots.length > 400) this.shots.splice(0, this.shots.length - 400);
      for (const l of this.listeners) l(shot);
    }

    if (!st.ringAlerts || !st.chains.includes(pair.chain)) return;
    const openers = this.db
      .prepare("SELECT wallet, SUM(usd) usd FROM trades WHERE chain = ? AND pool = ? AND kind = 'buy' AND ts <= ? GROUP BY wallet")
      .all(pair.chain, pair.address, pair.createdAt + st.sniperWindowSec * 1000) as { wallet: string; usd: number }[];
    const byRing = new Map<string, { wallet: string; usd: number }[]>();
    for (const o of openers) {
      const r = s.ringOf.get(key(pair.chain, o.wallet));
      if (r) byRing.set(r, [...(byRing.get(r) ?? []), o]);
    }
    for (const [ringId, members] of byRing) {
      // Ring ids can shift as membership is re-learned, so dedupe on the wallets themselves.
      const done = this.ringAlerted.get(pair.id) ?? new Set<string>();
      if (members.length < st.ringMinMembers || members.filter((m) => !done.has(m.wallet)).length < st.ringMinMembers) continue;
      for (const m of members) done.add(m.wallet);
      this.ringAlerted.set(pair.id, done);
      const ring = s.rings.find((r) => r.id === ringId)!;
      const total = members.reduce((a, m) => a + m.usd, 0);
      const intent = ring.intention === 'coordinated-dump' ? 'usually dumps together' : ring.intention === 'coordinated-hold' ? 'usually holds together' : 'mixed exits';
      this.alerts.emit({
        id: `${now}-r-${pair.id}-${ringId}`,
        ts: now,
        kind: 'ring',
        chain: pair.chain,
        pair: { id: pair.id, name: pair.name, symbol: pair.baseSymbol, address: pair.baseAddress, ageMin: (now - pair.createdAt) / 60_000, mcap: pair.mcap, liquidity: pair.liquidity, url: pair.url },
        wallets: members.map((m) => {
          const w = this.ledger.get(pair.chain, m.wallet);
          return { wallet: m.wallet, usd: m.usd, roi: w?.roi ?? 0, legitScore: w?.legitScore ?? 0, tier: w?.tier ?? 'none', label: w?.label };
        }),
        usd: total,
        message: `🎯 ${ring.name} (${members.length}/${ring.members.length} wallets, ${intent}, seen together on ${ring.sharedLaunches} launches) sniped ${pair.baseSymbol} on ${pair.chain} within ${st.sniperWindowSec}s — $${Math.round(total).toLocaleString()}`,
      });
    }
    if (this.ringAlerted.size > 20_000) this.ringAlerted.clear();
  }
}
