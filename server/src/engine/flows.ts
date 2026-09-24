import type { ChainDetail, ChainNode, DataSource, Flow, FlowWindow, FlowsResponse } from '../../../shared/types.ts';
import { DATA_MODE, FLOW_CHAINS, type ChainMeta } from '../config.ts';
import { cached } from '../http.ts';
import * as llama from '../sources/defillama.ts';
import { gauss, hashSeed, mulberry32 } from '../rand.ts';

const DAY = 86_400_000;
const WINDOW_DAYS: Record<FlowWindow, number> = { '24h': 1, '7d': 7, '30d': 30 };

export interface ChainSeries {
  meta: ChainMeta;
  tvl: number;
  tvlHistory: { t: number; v: number }[];
  bridgeDays: llama.BridgeDay[];
}

/**
 * Chain-to-chain routing via a gravity model. DefiLlama reports how much leaves (deposits) and
 * arrives (withdrawals) per chain, not the pair matrix, so each chain's outflow is spread over the
 * other chains in proportion to what they received. Returns the gross matrix.
 */
export function gravityMatrix(chains: { id: string; inflow: number; outflow: number }[]): Map<string, Map<string, number>> {
  const totalIn = chains.reduce((s, c) => s + c.inflow, 0);
  const m = new Map<string, Map<string, number>>();
  for (const o of chains) {
    const row = new Map<string, number>();
    const denom = totalIn - o.inflow;
    for (const i of chains) {
      if (i.id === o.id || denom <= 0) continue;
      row.set(i.id, (o.outflow * i.inflow) / denom);
    }
    m.set(o.id, row);
  }
  return m;
}

/** Net pairwise flows (a→b minus b→a), strongest first. */
export function netFlows(matrix: Map<string, Map<string, number>>, limit = 36): Flow[] {
  const flows: Flow[] = [];
  const ids = [...matrix.keys()];
  for (let x = 0; x < ids.length; x++) {
    for (let y = x + 1; y < ids.length; y++) {
      const a = ids[x];
      const b = ids[y];
      const ab = matrix.get(a)?.get(b) ?? 0;
      const ba = matrix.get(b)?.get(a) ?? 0;
      const net = ab - ba;
      if (Math.abs(net) < 1) continue;
      flows.push(net > 0 ? { from: a, to: b, usd: net } : { from: b, to: a, usd: -net });
    }
  }
  return flows.sort((p, q) => q.usd - p.usd).slice(0, limit);
}

function windowSums(days: llama.BridgeDay[], n: number) {
  const recent = days.slice(-n);
  return {
    inflow: recent.reduce((s, d) => s + d.withdrawUSD, 0),
    outflow: recent.reduce((s, d) => s + d.depositUSD, 0),
  };
}

function toNode(s: ChainSeries, n: number): ChainNode {
  const { inflow, outflow } = windowSums(s.bridgeDays, n);
  const h = s.tvlHistory;
  const now = h.at(-1)?.v ?? s.tvl;
  const weekAgo = h.length > 7 ? h[h.length - 8].v : 0;
  return {
    id: s.meta.id,
    name: s.meta.name,
    ticker: s.meta.ticker,
    ecosystem: s.meta.ecosystem,
    tvl: s.tvl || now,
    tvlChange7d: weekAgo > 0 ? now / weekAgo - 1 : null,
    inflow,
    outflow,
    net: inflow - outflow,
  };
}

// ---------- live ----------

async function firstNonEmpty<T>(aliases: string[], fn: (name: string) => Promise<T[]>): Promise<T[]> {
  for (const a of aliases) {
    try {
      const rows = await fn(a);
      if (rows.length) return rows;
    } catch {
      /* try next alias */
    }
  }
  return [];
}

async function liveSeries(): Promise<ChainSeries[]> {
  const tvls = await llama.chainsTvl();
  const byName = new Map(tvls.map((c) => [c.name.toLowerCase(), c.tvl]));
  const series = await Promise.all(
    FLOW_CHAINS.map(async (meta) => {
      let tvl = meta.llama.map((n) => byName.get(n.toLowerCase())).find((v) => v !== undefined) ?? 0;
      if (!tvl && meta.protocol) tvl = await llama.protocolTvl(meta.protocol).catch(() => 0);
      const [tvlHistory, bridgeDays] = await Promise.all([
        firstNonEmpty(meta.llama, llama.chainTvlHistory),
        firstNonEmpty(meta.llama, llama.bridgeVolume),
      ]);
      return { meta, tvl, tvlHistory: tvlHistory.slice(-180), bridgeDays: bridgeDays.slice(-90) };
    }),
  );
  // A chain DefiLlama doesn't know yet (e.g. a brand-new L2) is kept only if it has any data.
  return series.filter((s) => s.tvl > 0 || s.bridgeDays.length > 0);
}

// ---------- demo ----------

const DEMO_TVL: Record<string, number> = {
  ethereum: 72e9, solana: 11.5e9, bsc: 7.8e9, base: 5.6e9, arbitrum: 3.4e9, tron: 5.1e9,
  hyperliquid: 3.9e9, lighter: 1.3e9, robinhood: 0.9e9, avalanche: 1.6e9, polygon: 1.2e9, optimism: 0.7e9, sui: 1.5e9,
};

function demoSeries(): ChainSeries[] {
  const today = Math.floor(Date.now() / DAY) * DAY;
  return FLOW_CHAINS.map((meta) => {
    const rng = mulberry32(hashSeed(meta.id));
    const base = DEMO_TVL[meta.id] ?? 1e9;
    const drift = (rng() - 0.45) * 0.006; // per day
    const tvlHistory: { t: number; v: number }[] = [];
    const bridgeDays: llama.BridgeDay[] = [];
    let v = base / Math.exp(drift * 180);
    for (let d = 179; d >= 0; d--) {
      v *= Math.exp(drift + gauss(rng) * 0.018);
      tvlHistory.push({ t: today - d * DAY, v });
    }
    const scale = base * (0.004 + rng() * 0.006);
    const bias = drift * 40; // chains that grow tend to receive
    for (let d = 89; d >= 0; d--) {
      const vol = scale * Math.exp(gauss(rng) * 0.35);
      const tilt = Math.max(-0.6, Math.min(0.6, bias + gauss(rng) * 0.18));
      bridgeDays.push({ t: today - d * DAY, withdrawUSD: vol * (1 + tilt), depositUSD: vol * (1 - tilt) });
    }
    return { meta, tvl: v, tvlHistory, bridgeDays };
  });
}

// ---------- public ----------

let flowSource: DataSource = DATA_MODE === 'demo' ? 'demo' : 'live';

export const loadSeries = cached(10 * 60_000, async () => {
  if (DATA_MODE === 'demo') return demoSeries();
  try {
    const s = await liveSeries();
    if (!s.length) throw new Error('no chains returned');
    flowSource = 'live';
    return s;
  } catch (err) {
    if (DATA_MODE === 'live') throw err;
    console.warn(`[flows] live data unavailable, using simulated flows: ${(err as Error).message}`);
    flowSource = 'demo';
    return demoSeries();
  }
});

/** Source of the flow data, after the first load has settled. */
export async function flowsSource(): Promise<DataSource> {
  await loadSeries('all').catch(() => {});
  return flowSource;
}

export async function getFlows(window: FlowWindow): Promise<FlowsResponse> {
  const series = await loadSeries('all');
  const n = WINDOW_DAYS[window] ?? 7;
  const chains = series.map((s) => toNode(s, n)).sort((a, b) => b.tvl - a.tvl);
  const flows = netFlows(gravityMatrix(chains));
  return {
    window,
    chains,
    flows,
    totals: { tvl: chains.reduce((s, c) => s + c.tvl, 0), bridged: chains.reduce((s, c) => s + c.inflow, 0) },
    routing: flowSource === 'demo' ? 'simulated' : 'gravity-estimate',
    source: flowSource,
    updatedAt: Date.now(),
  };
}

const loadBridges = cached(30 * 60_000, () => llama.bridges());

export async function getChainDetail(id: string, window: FlowWindow): Promise<ChainDetail | null> {
  const series = await loadSeries('all');
  const s = series.find((x) => x.meta.id === id);
  if (!s) return null;
  const n = WINDOW_DAYS[window] ?? 7;
  const nodes = series.map((x) => toNode(x, n));
  const matrix = gravityMatrix(nodes);
  const counterparts = nodes
    .filter((c) => c.id !== id)
    .map((c) => ({
      chain: c.id,
      name: c.name,
      ecosystem: c.ecosystem,
      toHere: matrix.get(c.id)?.get(id) ?? 0,
      fromHere: matrix.get(id)?.get(c.id) ?? 0,
    }))
    .sort((a, b) => b.toHere + b.fromHere - (a.toHere + a.fromHere));

  let bridgeList: { name: string; volume: number }[] = [];
  let topTokens: ChainDetail['topTokens'] = [];
  if (flowSource === 'live') {
    const aliases = new Set(s.meta.llama.map((a) => a.toLowerCase()));
    const key = window === '24h' ? 'daily' : window === '7d' ? 'weekly' : 'monthly';
    bridgeList = await loadBridges('all')
      .then((bs) =>
        bs
          .filter((b) => b.chains.some((c) => aliases.has(c.toLowerCase())))
          .map((b) => ({ name: b.name, volume: b[key] }))
          .sort((a, b) => b.volume - a.volume)
          .slice(0, 8),
      )
      .catch(() => []);
    const yesterday = Math.floor((Date.now() - DAY) / DAY) * 86_400;
    for (const alias of s.meta.llama) {
      topTokens = await llama.bridgeDayTokens(yesterday, alias).catch(() => []);
      if (topTokens.length) break;
    }
  } else {
    const rng = mulberry32(hashSeed(id + 'bridges'));
    const names = ['Canonical bridge', 'Across', 'Stargate', 'Wormhole', 'deBridge', 'Relay', 'LayerZero OFT', 'CCTP'];
    const vol = nodes.find((c) => c.id === id)!;
    bridgeList = names.map((name) => ({ name, volume: (vol.inflow + vol.outflow) * rng() * 0.4 })).sort((a, b) => b.volume - a.volume);
    const syms = ['USDC', 'USDT', 'ETH', 'WBTC', 'SOL', 'BNB', 'HYPE', 'USDe'];
    topTokens = syms.map((symbol) => ({ symbol, inUsd: vol.inflow * rng() * 0.3, outUsd: vol.outflow * rng() * 0.3 })).sort((a, b) => b.inUsd + b.outUsd - a.inUsd - a.outUsd);
  }

  return {
    chain: nodes.find((c) => c.id === id)!,
    tvlHistory: s.tvlHistory,
    flowHistory: s.bridgeDays.map((d) => ({ t: d.t, inflow: d.withdrawUSD, outflow: d.depositUSD })),
    counterparts,
    bridges: bridgeList,
    topTokens,
    source: flowSource,
    updatedAt: Date.now(),
  };
}
