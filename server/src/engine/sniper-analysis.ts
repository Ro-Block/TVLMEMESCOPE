import type { Launch, Pair, RingIntention, SniperBuy, SniperLink } from '../../../shared/types.ts';
import { hashSeed } from '../rand.ts';
import { median } from './roi.ts';
import type { LedgerTrade } from './roi.ts';

// Pure sniper / bundle / ring detection. Input is the first hour of trades for each launch.

export interface LaunchInput {
  pair: Pair;
  trades: LedgerTrade[]; // sorted by time
}

const DUMP_SOLD = 0.8;
const DUMP_WITHIN_MIN = 10;

export function analyzeLaunch({ pair, trades }: LaunchInput, windowSec: number): Launch {
  const created = pair.createdAt;
  const withBlock = trades.filter((t) => t.block != null);
  // Only trust "same block as launch" if we actually saw the opening trades.
  const sawLaunch = trades.length > 0 && trades[0].ts - created <= windowSec * 1000;
  const launchBlock = sawLaunch && withBlock.length ? Math.min(...withBlock.map((t) => t.block!)) : null;

  interface Acc { firstBuy: number; firstBlock: number | null; firstUsd: number; bought: number; sold: number; firstSell: number | null }
  const byWallet = new Map<string, Acc>();
  let buys5m = 0;
  for (const t of trades) {
    let a = byWallet.get(t.wallet);
    if (t.kind === 'buy') {
      if (t.ts - created <= 5 * 60_000) buys5m += t.usd;
      if (!a) {
        a = { firstBuy: t.ts, firstBlock: t.block ?? null, firstUsd: 0, bought: 0, sold: 0, firstSell: null };
        byWallet.set(t.wallet, a);
      }
      // The opening buy may be split over several txs in the same block / second.
      if (t.ts - a.firstBuy <= 1_000 || (t.block != null && t.block === a.firstBlock)) a.firstUsd += t.usd;
      a.bought += t.qty;
    } else if (a) {
      a.sold += t.qty;
      a.firstSell ??= t.ts;
    }
  }

  const buys: SniperBuy[] = [];
  for (const [wallet, a] of byWallet) {
    const delaySec = Math.max(0, (a.firstBuy - created) / 1000);
    const inLaunchBlock = launchBlock !== null && a.firstBlock === launchBlock;
    if (delaySec > windowSec && !inLaunchBlock) continue;
    buys.push({
      wallet,
      delaySec,
      block: a.firstBlock,
      usd: a.firstUsd,
      bundled: false,
      soldPct: a.bought > 0 ? Math.min(1, a.sold / a.bought) : 0,
      exitMin: a.firstSell !== null ? (a.firstSell - a.firstBuy) / 60_000 : null,
    });
  }

  // Bundle = two or more sniper wallets landing in the same block (same second if no block data).
  const groups = new Map<string, SniperBuy[]>();
  for (const b of buys) {
    const k = b.block !== null ? `b${b.block}` : `s${Math.floor((created + b.delaySec * 1000) / 1000)}`;
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  for (const g of groups.values()) if (g.length >= 2) for (const b of g) b.bundled = true;

  const sniperUsd = buys.reduce((s, b) => s + b.usd, 0);
  const dumpedUsd = buys.filter((b) => b.soldPct >= DUMP_SOLD && b.exitMin !== null && b.exitMin <= DUMP_WITHIN_MIN).reduce((s, b) => s + b.usd, 0);
  buys.sort((a, b) => a.delaySec - b.delaySec);
  return {
    pair,
    launchBlock,
    buys,
    snipers: buys.length,
    bundled: buys.filter((b) => b.bundled).length,
    sniperUsd,
    share: buys5m > 0 ? Math.min(1, sniperUsd / buys5m) : 0,
    dumped: sniperUsd > 0 && dumpedUsd / sniperUsd >= 0.5,
    rings: 0,
    ringIds: [],
  };
}

export interface ProfileCalc {
  wallet: string;
  chain: string;
  launches: number;
  medianDelaySec: number;
  bundleRate: number;
  dumpRate: number;
  medianExitMin: number | null;
  avgUsd: number;
  lastSeen: number;
}

export function buildProfiles(launches: Launch[]): ProfileCalc[] {
  const acc = new Map<string, { chain: string; wallet: string; delays: number[]; bundled: number; dumps: number; exits: number[]; usd: number; last: number }>();
  for (const l of launches) {
    for (const b of l.buys) {
      const k = `${l.pair.chain}:${b.wallet}`;
      const a = acc.get(k) ?? { chain: l.pair.chain, wallet: b.wallet, delays: [], bundled: 0, dumps: 0, exits: [], usd: 0, last: 0 };
      a.delays.push(b.delaySec);
      if (b.bundled) a.bundled++;
      if (b.soldPct >= DUMP_SOLD && b.exitMin !== null && b.exitMin <= DUMP_WITHIN_MIN) a.dumps++;
      if (b.exitMin !== null) a.exits.push(b.exitMin);
      a.usd += b.usd;
      a.last = Math.max(a.last, l.pair.createdAt);
      acc.set(k, a);
    }
  }
  return [...acc.values()].map((a) => ({
    wallet: a.wallet,
    chain: a.chain,
    launches: a.delays.length,
    medianDelaySec: median(a.delays) ?? 0,
    bundleRate: a.bundled / a.delays.length,
    dumpRate: a.dumps / a.delays.length,
    medianExitMin: median(a.exits),
    avgUsd: a.usd / a.delays.length,
    lastSeen: a.last,
  }));
}

export interface RingCalc {
  id: string;
  chain: string;
  members: string[];
  sharedLaunches: number;
  sameBlockRate: number;
  cohesion: number;
  intention: RingIntention;
  medianExitSpreadMin: number | null;
  lastSeen: number;
  recent: { pairId: string; symbol: string; ts: number }[];
}

/**
 * Links wallets that keep sniping the same launches (co-occurrence + Jaccard), groups them into
 * rings (connected components), then checks whether ring members exit together.
 */
export function findRings(launches: Launch[], opts: { minShared?: number; minJaccard?: number; minLift?: number; maxPerLaunch?: number } = {}): { links: SniperLink[]; rings: RingCalc[] } {
  const minShared = opts.minShared ?? 3;
  const minJaccard = opts.minJaccard ?? 0.25;
  const maxPer = opts.maxPerLaunch ?? 40;
  // Busy snipers overlap with everyone by chance; lift = how much more often a pair co-occurs than independence predicts.
  const minLift = opts.minLift ?? 2;
  const perChain = new Map<string, number>();
  for (const l of launches) perChain.set(l.pair.chain, (perChain.get(l.pair.chain) ?? 0) + 1);

  const count = new Map<string, number>();
  const pairs = new Map<string, { shared: number; sameBlock: number }>();
  for (const l of launches) {
    const bs = l.buys.slice(0, maxPer);
    for (const b of bs) count.set(`${l.pair.chain}:${b.wallet}`, (count.get(`${l.pair.chain}:${b.wallet}`) ?? 0) + 1);
    for (let i = 0; i < bs.length; i++) {
      for (let j = i + 1; j < bs.length; j++) {
        const [a, b] = bs[i].wallet < bs[j].wallet ? [bs[i], bs[j]] : [bs[j], bs[i]];
        const k = `${l.pair.chain}|${a.wallet}|${b.wallet}`;
        const p = pairs.get(k) ?? { shared: 0, sameBlock: 0 };
        p.shared++;
        if (a.block !== null && a.block === b.block) p.sameBlock++;
        pairs.set(k, p);
      }
    }
  }

  const links: SniperLink[] = [];
  for (const [k, p] of pairs) {
    if (p.shared < minShared) continue;
    const [chain, a, b] = k.split('|');
    const ca = count.get(`${chain}:${a}`)!;
    const cb = count.get(`${chain}:${b}`)!;
    const jaccard = p.shared / (ca + cb - p.shared);
    const lift = (p.shared * perChain.get(chain)!) / (ca * cb);
    if (jaccard >= minJaccard && lift >= minLift) links.push({ chain, a, b, shared: p.shared, sameBlock: p.sameBlock, jaccard });
  }

  // Union-find over links.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    const p = parent.get(x) ?? x;
    if (p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  for (const l of links) {
    const ra = find(`${l.chain}:${l.a}`);
    const rb = find(`${l.chain}:${l.b}`);
    if (ra !== rb) parent.set(ra, rb);
  }
  const comps = new Map<string, string[]>();
  for (const l of links) {
    for (const w of [l.a, l.b]) {
      const r = find(`${l.chain}:${w}`);
      const m = comps.get(r) ?? [];
      if (!m.includes(w)) m.push(w);
      comps.set(r, m);
    }
  }

  const rings: RingCalc[] = [];
  for (const [root, members] of comps) {
    const chain = root.slice(0, root.indexOf(':'));
    const set = new Set(members);
    let shared = 0;
    let sameBlock = 0;
    let dumpTogether = 0;
    let holdTogether = 0;
    const spreads: number[] = [];
    let lastSeen = 0;
    const recent: RingCalc['recent'] = [];
    for (const l of launches) {
      if (l.pair.chain !== chain) continue;
      const present = l.buys.filter((b) => set.has(b.wallet));
      if (present.length < 2) continue;
      shared++;
      lastSeen = Math.max(lastSeen, l.pair.createdAt);
      recent.push({ pairId: l.pair.id, symbol: l.pair.baseSymbol, ts: l.pair.createdAt });
      const blocks = present.map((b) => b.block).filter((b) => b !== null);
      if (new Set(blocks).size < blocks.length) sameBlock++;
      const sold = present.filter((b) => b.soldPct >= 0.5 && b.exitMin !== null);
      const exitTs = sold.map((b) => l.pair.createdAt + b.delaySec * 1000 + b.exitMin! * 60_000);
      if (exitTs.length >= 2) spreads.push((Math.max(...exitTs) - Math.min(...exitTs)) / 60_000);
      if (sold.length === present.length && (Math.max(...exitTs) - Math.min(...exitTs)) / 60_000 <= 3) dumpTogether++;
      else if (sold.length === 0) holdTogether++;
    }
    if (shared < minShared) continue;
    const intention: RingIntention = dumpTogether / shared >= 0.6 ? 'coordinated-dump' : holdTogether / shared >= 0.6 ? 'coordinated-hold' : 'mixed';
    const sorted = [...members].sort();
    rings.push({
      id: `${chain}:${hashSeed(sorted.join(',')).toString(16).padStart(8, '0')}`,
      chain,
      members: sorted,
      sharedLaunches: shared,
      sameBlockRate: sameBlock / shared,
      cohesion: (dumpTogether + holdTogether) / shared,
      intention,
      medianExitSpreadMin: median(spreads),
      lastSeen,
      recent: recent.sort((a, b) => b.ts - a.ts).slice(0, 8),
    });
  }
  rings.sort((a, b) => b.sharedLaunches - a.sharedLaunches);
  return { links, rings };
}
