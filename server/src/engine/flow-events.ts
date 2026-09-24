import type { FlowEvent } from '../../../shared/types.ts';
import { FLOW_CHAINS, FLOW_EVENTS } from '../config.ts';
import { gauss, mulberry32 } from '../rand.ts';
import { getFlows } from './flows.ts';

const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
const nameOf = (id: string) => FLOW_CHAINS.find((c) => c.id === id)?.name ?? id;

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
   * - super comet: $10M+ moved on one route within the latest hour (Wormholescan chain pairs)
   * - supernova: a chain's stablecoins fell by $50M+ over the last day (DefiLlama), or it bridged
   *   out $50M+ net within the latest hour
   */
  private async pollLive() {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const day = Math.floor(Date.now() / 86_400_000) * 86_400_000;
    const h = await getFlows('1h');
    for (const f of h.flows) {
      if (f.usd < FLOW_EVENTS.superCometUsd) continue;
      this.emit({
        id: `c:${f.from}>${f.to}:${hour}`,
        ts: Date.now(),
        kind: 'super-comet',
        chain: f.from,
        to: f.to,
        usd: f.usd,
        message: `☄ ${usd(f.usd)} moved ${nameOf(f.from)} → ${nameOf(f.to)} in the last hour`,
      });
    }
    for (const c of h.chains) {
      if (c.inflow - c.outflow <= -FLOW_EVENTS.supernovaUsd) {
        this.emit({ id: `w:${c.id}:${hour}`, ts: Date.now(), kind: 'supernova', chain: c.id, usd: c.outflow - c.inflow, message: `✹ ${usd(c.outflow - c.inflow)} net bridged out of ${c.name} in the last hour` });
      }
    }
    const d = await getFlows('1d');
    for (const c of d.chains) {
      if (c.stableChange !== null && c.stableChange <= -FLOW_EVENTS.supernovaUsd) {
        this.emit({ id: `s:${c.id}:${day}`, ts: Date.now(), kind: 'supernova', chain: c.id, usd: -c.stableChange, message: `✹ Stablecoins on ${c.name} fell ${usd(-c.stableChange)} in 24h` });
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
