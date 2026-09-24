import type { FlowEvent } from '../../../shared/types.ts';
import { FLOW_CHAINS, FLOW_EVENTS } from '../config.ts';
import { gauss, mulberry32 } from '../rand.ts';
import * as llama from '../sources/defillama.ts';
import { getFlows, gravityMatrix, loadSeries } from './flows.ts';
import { median } from './roi.ts';

const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : `$${(n / 1e6).toFixed(1)}M`);
const nameOf = (id: string) => FLOW_CHAINS.find((c) => c.id === id)?.name ?? id;

interface Tx extends llama.LargeTx {
  chain: string;
}

/**
 * Pairs the deposit and withdrawal legs of the same transfer (same token, amount within 2%,
 * release up to an hour after the deposit). Matched pairs give an exact route.
 */
export function matchLegs(txs: Tx[]): { from?: string; to?: string; tx: Tx; exact: boolean }[] {
  const deposits = txs.filter((t) => t.isDeposit).sort((a, b) => a.ts - b.ts);
  const releases = txs.filter((t) => !t.isDeposit);
  const used = new Set<Tx>();
  const out: { from?: string; to?: string; tx: Tx; exact: boolean }[] = [];
  for (const d of deposits) {
    const r = releases.find((x) => !used.has(x) && x.chain !== d.chain && x.token === d.token && Math.abs(x.usd - d.usd) <= d.usd * 0.02 && x.ts >= d.ts - 60_000 && x.ts - d.ts <= 3_600_000);
    if (r) used.add(r);
    out.push({ from: d.chain, to: r?.chain, tx: d, exact: !!r });
  }
  for (const r of releases) if (!used.has(r)) out.push({ to: r.chain, tx: r, exact: false });
  return out;
}

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
    setInterval(run, 5 * 60_000).unref();
  }

  /** Most likely counterpart of a chain, from the 24h gravity routing. */
  private async counterpart(chain: string, direction: 'to' | 'from'): Promise<string | undefined> {
    const { chains } = await getFlows('24h');
    const m = gravityMatrix(chains);
    let best: string | undefined;
    let bestV = 0;
    for (const c of chains) {
      if (c.id === chain) continue;
      const v = direction === 'to' ? m.get(chain)?.get(c.id) ?? 0 : m.get(c.id)?.get(chain) ?? 0;
      if (v > bestV) [best, bestV] = [c.id, v];
    }
    return best;
  }

  private async pollLive() {
    const series = await loadSeries('all');
    const now = Date.now();
    const txs: Tx[] = [];
    for (const s of series) {
      for (const alias of s.meta.llama) {
        try {
          const rows = await llama.largeTransactions(alias, Math.floor((now - 2 * 3_600_000) / 1000), Math.floor(now / 1000));
          txs.push(...rows.filter((r) => r.usd >= FLOW_EVENTS.superCometUsd).map((r) => ({ ...r, chain: s.meta.id })));
          break;
        } catch {
          /* try the next alias */
        }
      }
    }

    for (const m of matchLegs(txs)) {
      const from = m.from ?? (await this.counterpart(m.to!, 'from'));
      const to = m.to ?? (await this.counterpart(m.from!, 'to'));
      if (!from || !to) continue;
      const t = m.tx;
      this.emit({
        id: `c:${t.chain}:${t.txHash}`,
        ts: t.ts,
        kind: 'super-comet',
        chain: from,
        to,
        estimatedRoute: !m.exact,
        usd: t.usd,
        token: t.token,
        bridge: t.bridge,
        txHash: t.txHash,
        message: `☄ ${usd(t.usd)}${t.token ? ` ${t.token}` : ''} bridged ${nameOf(from)} → ${nameOf(to)}${m.exact ? '' : ' (route estimated)'}`,
      });
      if (m.from && t.usd >= FLOW_EVENTS.supernovaUsd) {
        this.emit({ id: `n:${t.chain}:${t.txHash}`, ts: t.ts, kind: 'supernova', chain: m.from, usd: t.usd, token: t.token, txHash: t.txHash, message: `✹ ${usd(t.usd)} left ${nameOf(m.from)} in a single transfer` });
      }
    }

    // Exodus days: outflow far above the chain's recent norm.
    for (const s of series) {
      const days = s.bridgeDays;
      const last = days.at(-1);
      if (!last || days.length < 8) continue;
      const norm = median(days.slice(-15, -1).map((d) => d.depositUSD)) ?? 0;
      const netOut = last.depositUSD - last.withdrawUSD;
      if (norm > 0 && last.depositUSD >= FLOW_EVENTS.supernovaSpike * norm && netOut >= FLOW_EVENTS.supernovaUsd / 2) {
        this.emit({
          id: `x:${s.meta.id}:${last.t}`,
          ts: now,
          kind: 'supernova',
          chain: s.meta.id,
          usd: netOut,
          message: `✹ ${nameOf(s.meta.id)} exodus: ${usd(last.depositUSD)} bridged out today, ${(last.depositUSD / norm).toFixed(1)}× its usual day`,
        });
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
      const { chains } = await getFlows('7d');
      const c = chains[Math.floor(rng() * chains.length)];
      const amount = FLOW_EVENTS.supernovaUsd * (1.2 + rng() * 5);
      this.emit({ id: `demo-n-${++n}`, ts: Date.now(), kind: 'supernova', chain: c.id, usd: amount, message: `✹ ${usd(amount)} left ${c.name} within the hour` });
      setTimeout(() => void nova(), 45_000 + rng() * 40_000).unref();
    };
    setTimeout(() => void comet(), 5_000).unref();
    setTimeout(() => void nova(), 16_000).unref();
  }
}
