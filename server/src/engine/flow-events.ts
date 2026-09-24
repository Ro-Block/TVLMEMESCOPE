import type { FlowEvent } from '../../../shared/types.ts';
import { FLOW_CHAINS, FLOW_EVENTS } from '../config.ts';
import { gauss, mulberry32 } from '../rand.ts';
import { getFlows, routeHours } from './flows.ts';

const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
const nameOf = (id: string) => FLOW_CHAINS.find((c) => c.id === id)?.name ?? id;

export interface RouteHour {
  from: number;
  src: string;
  dst: string;
  usd: number;
}

export interface Spike {
  kind: 'super-comet' | 'supernova';
  hour: number;
  chain: string;
  to?: string;
  usd: number;
  /** How many times the usual hour this is; null when the usual hour is zero. */
  ratio: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Finds hours that stand out against the route's (or chain's) own last day, so the map reacts to
 * real, unusual movements instead of only the rare $10M+ hour:
 * - super comet: a route's hour is ≥ absolute threshold, or ≥ min and ≥ spike× its median hour
 * - supernova: a chain's hourly net outflow is ≥ absolute threshold, or ≥ min and ≥ spike× its median |net| hour
 * Checks the latest `recent` hours; at most 3 comets and 2 novas per hour, biggest first.
 */
export function detectSpikes(rows: RouteHour[], t = FLOW_EVENTS, recent = 2): Spike[] {
  const hours = [...new Set(rows.map((r) => r.from))].sort((a, b) => a - b);
  if (hours.length < 2) return [];
  const route = new Map<string, Map<number, number>>();
  const net = new Map<string, Map<number, number>>();
  const add = (m: Map<string, Map<number, number>>, k: string, h: number, v: number) => {
    const row = m.get(k) ?? new Map<number, number>();
    row.set(h, (row.get(h) ?? 0) + v);
    m.set(k, row);
  };
  for (const r of rows) {
    add(route, `${r.src}>${r.dst}`, r.from, r.usd);
    add(net, r.dst, r.from, r.usd);
    add(net, r.src, r.from, -r.usd);
  }
  const out: Spike[] = [];
  for (const h of hours.slice(-recent)) {
    const past = hours.filter((x) => x < h).slice(-24);
    if (!past.length) continue;
    const comets: Spike[] = [];
    for (const [k, byHour] of route) {
      const v = byHour.get(h) ?? 0;
      const usual = median(past.map((x) => byHour.get(x) ?? 0));
      if (v >= t.superCometUsd || (v >= t.superCometMinUsd && v >= t.supernovaSpike * usual)) {
        const [src, dst] = k.split('>');
        comets.push({ kind: 'super-comet', hour: h, chain: src, to: dst, usd: v, ratio: usual > 0 ? v / usual : null });
      }
    }
    const novas: Spike[] = [];
    for (const [c, byHour] of net) {
      const loss = -(byHour.get(h) ?? 0);
      const usual = median(past.map((x) => Math.abs(byHour.get(x) ?? 0)));
      if (loss >= t.supernovaUsd || (loss >= t.supernovaMinUsd && loss >= t.supernovaSpike * usual)) {
        novas.push({ kind: 'supernova', hour: h, chain: c, usd: loss, ratio: usual > 0 ? loss / usual : null });
      }
    }
    out.push(...comets.sort((a, b) => b.usd - a.usd).slice(0, 3), ...novas.sort((a, b) => b.usd - a.usd).slice(0, 2));
  }
  return out;
}

const times = (r: number | null) => (r === null ? 'a route that is usually quiet' : `${r >= 10 ? Math.round(r) : r.toFixed(1)}× its usual hour`);

/** Big single bridge transfers (super comets) and liquidity exoduses (supernovas) for the solar map. */
export class FlowEventEngine {
  private listeners = new Set<(e: FlowEvent) => void>();
  private recent: FlowEvent[] = [];
  private seen = new Set<string>();

  subscribe(fn: (e: FlowEvent) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  list() {
    return this.recent;
  }

  private emit(e: FlowEvent) {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    this.recent = [e, ...this.recent].slice(0, 60);
    for (const l of this.listeners) l(e);
  }

  start(mode: 'live' | 'demo') {
    if (mode === 'demo') return this.startDemo();
    const run = () => void this.pollLive().catch((e) => console.warn('[flow-events]', (e as Error).message));
    run();
    setInterval(run, 2 * 60_000).unref();
  }

  /**
   * Live rules, on data that is free and already cached by the flow engine:
   * - hourly spikes on Wormholescan chain pairs (see detectSpikes)
   * - supernova: a chain's stablecoins fell by $50M+, or 3%+ (and $5M+), over the last day (DefiLlama)
   */
  private async pollLive() {
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    for (const s of detectSpikes(await routeHours())) {
      const when = s.hour >= Date.now() - 3_600_000 ? 'this hour' : 'in the last hour';
      if (s.kind === 'super-comet') {
        this.emit({ id: `c:${s.chain}>${s.to}:${s.hour}`, ts: Date.now(), kind: 'super-comet', chain: s.chain, to: s.to, usd: s.usd, bridge: 'Wormhole', message: `☄ ${usd(s.usd)} moved ${nameOf(s.chain)} → ${nameOf(s.to!)} ${when}, ${times(s.ratio)}` });
      } else {
        this.emit({ id: `w:${s.chain}:${s.hour}`, ts: Date.now(), kind: 'supernova', chain: s.chain, usd: s.usd, message: `✹ ${usd(s.usd)} net bridged out of ${nameOf(s.chain)} ${when}, ${times(s.ratio)}` });
      }
    }
    const d = await getFlows('1d');
    for (const c of d.chains) {
      const drop = c.stableChange !== null ? -c.stableChange : 0;
      const share = c.stablecoins ? drop / (c.stablecoins + drop) : 0;
      if (drop >= FLOW_EVENTS.supernovaUsd || (drop >= 5e6 && share >= 0.03)) {
        this.emit({ id: `s:${c.id}:${day}`, ts: Date.now(), kind: 'supernova', chain: c.id, usd: drop, message: `✹ Stablecoins on ${c.name} fell ${usd(drop)} (${(share * 100).toFixed(1)}%) in 24h` });
      }
    }
    if (this.seen.size > 5_000) this.seen.clear();
  }

  /** Simulated events so the effects can be seen without live data. */
  private startDemo() {
    const rng = mulberry32(99);
    let n = 0;
    const comet = async () => {
      const { flows } = await getFlows('7d');
      const total = flows.reduce((s, f) => s + f.usd, 0);
      let pick = rng() * total;
      const f = flows.find((x) => (pick -= x.usd) <= 0) ?? flows[0];
      if (f) {
        const amount = Math.min(400e6, FLOW_EVENTS.superCometUsd * Math.exp(Math.abs(gauss(rng)) * 1.1 + 0.2));
        const token = ['USDC', 'USDT', 'ETH', 'WBTC', 'SOL', 'USDe'][Math.floor(rng() * 6)];
        this.emit({ id: `demo-c-${++n}`, ts: Date.now(), kind: 'super-comet', chain: f.from, to: f.to, usd: amount, token, bridge: ['Stargate', 'Across', 'Wormhole', 'CCTP', 'deBridge'][Math.floor(rng() * 5)], message: `☄ ${usd(amount)} ${token} bridged ${nameOf(f.from)} → ${nameOf(f.to)}` });
      }
      setTimeout(() => void comet(), 14_000 + rng() * 16_000).unref();
    };
    const nova = async () => {
      const { chains } = await getFlows('1d');
      const c = chains[Math.floor(rng() * chains.length)];
      const amount = FLOW_EVENTS.supernovaUsd * (1.2 + rng() * 5);
      this.emit({ id: `demo-n-${++n}`, ts: Date.now(), kind: 'supernova', chain: c.id, usd: amount, message: `✹ ${usd(amount)} left ${c.name} within the hour` });
      setTimeout(() => void nova(), 45_000 + rng() * 40_000).unref();
    };
    setTimeout(() => void comet(), 5_000).unref();
    setTimeout(() => void nova(), 16_000).unref();
  }
}
