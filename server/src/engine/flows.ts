import { TREND_WINDOWS, type ChainDetail, type ChainNode, type DataSource, type Flow, type FlowWindow, type FlowsResponse, type SourceStatus } from '../../../shared/types.ts';
import { DATA_MODE, FLOW_CHAINS, type ChainMeta } from '../config.ts';
import { cached } from '../http.ts';
import * as llama from '../sources/defillama.ts';
import * as gt from '../sources/geckoterminal.ts';
import * as wh from '../sources/wormhole.ts';
import { gauss, hashSeed, mulberry32 } from '../rand.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How many hours of route data each window covers. 5m uses the latest hourly bucket. */
const WINDOW_HOURS: Record<FlowWindow, number> = { '5m': 1, '1h': 1, '6h': 6, '1d': 24, '3d': 72, '7d': 168 };
export const isTrend = (w: FlowWindow) => TREND_WINDOWS.includes(w);
export const parseWindow = (q: unknown): FlowWindow => (['5m', '1h', '6h', '1d', '3d', '7d'].includes(String(q)) ? (q as FlowWindow) : '1d');

/**
 * Chain-to-chain routing via a gravity model. Only used for the simulator now; live routes are
 * observed chain-pair volumes. Returns the gross matrix.
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
  const ids = [...new Set([...matrix.keys(), ...[...matrix.values()].flatMap((r) => [...r.keys()])])];
  for (let x = 0; x < ids.length; x++) {
    for (let y = x + 1; y < ids.length; y++) {
      const a = ids[x];
      const b = ids[y];
      const net = (matrix.get(a)?.get(b) ?? 0) - (matrix.get(b)?.get(a) ?? 0);
      if (Math.abs(net) < 1) continue;
      flows.push(net > 0 ? { from: a, to: b, usd: net } : { from: b, to: a, usd: -net });
    }
  }
  return flows.sort((p, q) => q.usd - p.usd).slice(0, limit);
}

/** Sums the latest `n` buckets of pair volume into a gross matrix keyed by our chain ids. */
export function pairMatrix(buckets: wh.PairBucket[], n: number, idOf: (whId: number) => string | undefined) {
  const starts = [...new Set(buckets.map((b) => b.from))].sort((a, b) => b - a).slice(0, n);
  const keep = new Set(starts);
  const m = new Map<string, Map<string, number>>();
  for (const b of buckets) {
    if (!keep.has(b.from)) continue;
    const src = idOf(b.src);
    const dst = idOf(b.dst);
    if (!src || !dst || src === dst) continue;
    const row = m.get(src) ?? new Map<string, number>();
    row.set(dst, (row.get(dst) ?? 0) + b.usd);
    m.set(src, row);
  }
  return m;
}

const sumIn = (m: Map<string, Map<string, number>>, id: string) => [...m.values()].reduce((s, r) => s + (r.get(id) ?? 0), 0);
const sumOut = (m: Map<string, Map<string, number>>, id: string) => [...(m.get(id)?.values() ?? [])].reduce((s, v) => s + v, 0);

/** Value of a daily series `days` ago (last point at or before that time). */
function valueAt(series: { t: number; v: number }[], t: number): number | null {
  let best: number | null = null;
  for (const p of series) if (p.t <= t) best = p.v;
  return best;
}

// ---------- live sources, each with its own refresh interval ----------

const status = new Map<string, SourceStatus>();
async function track<T>(name: string, p: Promise<T>, note?: string): Promise<T> {
  try {
    const v = await p;
    status.set(name, { name, ok: true, updatedAt: Date.now(), note });
    return v;
  } catch (e) {
    status.set(name, { name, ok: false, updatedAt: status.get(name)?.updatedAt ?? null, note: (e as Error).message.slice(0, 140) });
    throw e;
  }
}

async function firstWorking<T>(aliases: string[], fn: (name: string) => Promise<T>, ok: (v: T) => boolean): Promise<T | null> {
  for (const a of aliases) {
    try {
      const v = await fn(a);
      if (ok(v)) return v;
    } catch {
      /* next alias */
    }
  }
  return null;
}

const meta = (id: string) => FLOW_CHAINS.find((c) => c.id === id)!;
const byWh = new Map(FLOW_CHAINS.filter((c) => c.wormhole).map((c) => [c.wormhole!, c.id]));

const tvlNow = cached(5 * 60_000, () => track('DefiLlama TVL', llama.chainsTvl()));
const protocolTvl = cached(5 * 60_000, (slug) => llama.protocolTvl(slug));
const tvlHist = cached(60 * 60_000, async (id) => (await firstWorking(meta(id).llama, llama.chainTvlHistory, (r) => r.length > 0)) ?? []);
const stablesNow = cached(5 * 60_000, () => track('DefiLlama stablecoins', llama.stablecoinChains()));
const stablesHist = cached(30 * 60_000, async (id) => (await firstWorking(meta(id).llama, llama.stablecoinHistory, (r) => r.length > 0)) ?? []);
const dex = cached(15 * 60_000, async (id) => firstWorking(meta(id).llama, llama.dexVolume, (r) => r.daily.length > 0 || r.total24h > 0));
const whHourly = cached(2 * 60_000, () => track('Wormholescan routes', wh.hourly(26), 'observed chain-pair volume, all Wormhole apps'));
const whDaily = cached(15 * 60_000, () => wh.daily(45));

/** Pool liquidity + short-window DEX volume, refreshed one chain at a time to stay inside GeckoTerminal's free limit. */
const pools = new Map<string, { liquidity: number; m5: number; h1: number; h6: number; h24: number; at: number }>();
let poolTimer: NodeJS.Timeout | null = null;
export function startPoolRotation(everyMs = 30_000) {
  if (poolTimer || DATA_MODE === 'demo') return;
  const list = FLOW_CHAINS.filter((c) => c.gt);
  let i = 0;
  const step = async () => {
    const c = list[i++ % list.length];
    try {
      const ps = await track('GeckoTerminal pools', gt.topPools(c.gt!), 'top ~20 pools per chain, one chain per 30s');
      pools.set(c.id, {
        liquidity: ps.reduce((s, p) => s + p.liquidity, 0),
        m5: ps.reduce((s, p) => s + p.volume.m5, 0),
        h1: ps.reduce((s, p) => s + p.volume.h1, 0),
        h6: ps.reduce((s, p) => s + (p.volume.h6 ?? 0), 0),
        h24: ps.reduce((s, p) => s + p.volume.h24, 0),
        at: Date.now(),
      });
    } catch {
      /* status already recorded */
    }
  };
  void step();
  poolTimer = setInterval(() => void step(), everyMs);
  poolTimer.unref();
}

const settle = async <T,>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

async function liveFlows(window: FlowWindow): Promise<FlowsResponse> {
  const trend = isTrend(window);
  const [tvls, stables, hourly, daily] = await Promise.all([settle(tvlNow('all')), settle(stablesNow('all')), settle(whHourly('all')), trend && window !== '1d' ? settle(whDaily('all')) : Promise.resolve(null)]);
  if (!tvls && !stables && !hourly) throw new Error('no live data source reachable (DefiLlama, Wormholescan)');

  const matrix = trend && window !== '1d' ? pairMatrix(daily ?? [], window === '3d' ? 3 : 7, (x) => byWh.get(x)) : pairMatrix(hourly ?? [], WINDOW_HOURS[window], (x) => byWh.get(x));
  const tvlByName = new Map((tvls ?? []).map((c) => [c.name.toLowerCase(), c.tvl]));
  const now = Date.now();

  const chains: ChainNode[] = await Promise.all(
    FLOW_CHAINS.map(async (m: ChainMeta) => {
      let tvl = m.llama.map((n) => tvlByName.get(n.toLowerCase())).find((v) => v !== undefined) ?? 0;
      if (!tvl && m.protocol) tvl = await protocolTvl(m.protocol).catch(() => 0);
      const hist = await settle(tvlHist(m.id));
      const weekAgo = hist?.length ? valueAt(hist, now - 7 * DAY) : null;
      const stable = m.llama.map((n) => stables?.get(n.toLowerCase())).find((v) => v !== undefined) ?? null;
      let stableChange: number | null = null;
      if (trend && stable !== null) {
        const sh = await settle(stablesHist(m.id));
        const then = sh?.length ? valueAt(sh, now - (WINDOW_HOURS[window] / 24) * DAY) : null;
        stableChange = then !== null ? stable - then : null;
      }
      let dexVolume: number | null = null;
      if (trend) {
        const d = await settle(dex(m.id));
        if (d) dexVolume = window === '1d' ? d.total24h || (d.daily.at(-1)?.v ?? 0) : d.daily.slice(-(WINDOW_HOURS[window] / 24)).reduce((s, p) => s + p.v, 0);
      } else {
        const p = pools.get(m.id);
        if (p) dexVolume = window === '5m' ? p.m5 : window === '1h' ? p.h1 : p.h6;
      }
      const inflow = sumIn(matrix, m.id);
      const outflow = sumOut(matrix, m.id);
      return {
        id: m.id,
        name: m.name,
        ticker: m.ticker,
        ecosystem: m.ecosystem,
        tvl,
        tvlChange7d: weekAgo && tvl ? tvl / weekAgo - 1 : null,
        inflow,
        outflow,
        net: trend && stableChange !== null ? stableChange : inflow - outflow,
        stablecoins: stable,
        stableChange,
        dexVolume,
        poolLiquidity: pools.get(m.id)?.liquidity ?? null,
      };
    }),
  );
  const shown = chains.filter((c) => c.tvl > 0 || (c.stablecoins ?? 0) > 0 || c.inflow + c.outflow > 0).sort((a, b) => b.tvl - a.tvl);
  const sources = ['DefiLlama TVL', 'DefiLlama stablecoins', 'Wormholescan routes', 'GeckoTerminal pools'].map((n) => status.get(n) ?? { name: n, ok: false, updatedAt: null, note: 'not loaded yet' });
  return {
    window,
    chains: shown,
    flows: netFlows(matrix),
    totals: {
      tvl: shown.reduce((s, c) => s + c.tvl, 0),
      bridged: shown.reduce((s, c) => s + c.inflow, 0),
      stablecoins: shown.reduce((s, c) => s + (c.stablecoins ?? 0), 0),
      dexVolume: shown.reduce((s, c) => s + (c.dexVolume ?? 0), 0),
    },
    routing: 'observed',
    routesWindow: window === '5m' ? '1h' : window,
    sources,
    source: 'live',
    updatedAt: now,
  };
}

// ---------- demo ----------

const DEMO_TVL: Record<string, number> = {
  ethereum: 72e9, solana: 11.5e9, bsc: 7.8e9, base: 5.6e9, arbitrum: 3.4e9, tron: 5.1e9,
  hyperliquid: 3.9e9, lighter: 1.3e9, robinhood: 0.9e9, avalanche: 1.6e9, polygon: 1.2e9, optimism: 0.7e9, sui: 1.5e9,
};

interface DemoSeries {
  meta: ChainMeta;
  tvlHistory: { t: number; v: number }[];
  days: { t: number; inflow: number; outflow: number }[];
}

let demoCache: DemoSeries[] | null = null;
function demoSeries(): DemoSeries[] {
  if (demoCache) return demoCache;
  const today = Math.floor(Date.now() / DAY) * DAY;
  demoCache = FLOW_CHAINS.map((meta) => {
    const rng = mulberry32(hashSeed(meta.id));
    const base = DEMO_TVL[meta.id] ?? 1e9;
    const drift = (rng() - 0.45) * 0.006;
    const tvlHistory: { t: number; v: number }[] = [];
    let v = base / Math.exp(drift * 180);
    for (let d = 179; d >= 0; d--) {
      v *= Math.exp(drift + gauss(rng) * 0.018);
      tvlHistory.push({ t: today - d * DAY, v });
    }
    const scale = base * (0.004 + rng() * 0.006);
    const days = [];
    for (let d = 44; d >= 0; d--) {
      const vol = scale * Math.exp(gauss(rng) * 0.35);
      const tilt = Math.max(-0.6, Math.min(0.6, drift * 40 + gauss(rng) * 0.18));
      days.push({ t: today - d * DAY, inflow: vol * (1 + tilt), outflow: vol * (1 - tilt) });
    }
    return { meta, tvlHistory, days };
  });
  return demoCache;
}

function demoFlows(window: FlowWindow): FlowsResponse {
  const hours = WINDOW_HOURS[window];
  // Short windows jitter every 30s so the demo feels live.
  const tick = Math.floor(Date.now() / 30_000);
  const chains: ChainNode[] = demoSeries().map((s) => {
    const rng = mulberry32(hashSeed(`${s.meta.id}:${window}:${isTrend(window) ? 0 : tick}`));
    const recent = s.days.slice(-Math.max(1, Math.ceil(hours / 24)));
    const frac = window === '5m' ? 1 / 288 : Math.min(1, hours / 24);
    const inflow = recent.reduce((a, d) => a + d.inflow, 0) * (hours < 24 ? frac : 1) * (0.8 + rng() * 0.4);
    const outflow = recent.reduce((a, d) => a + d.outflow, 0) * (hours < 24 ? frac : 1) * (0.8 + rng() * 0.4);
    const tvl = s.tvlHistory.at(-1)!.v;
    const weekAgo = s.tvlHistory.at(-8)!.v;
    const stableChange = isTrend(window) ? (inflow - outflow) * (0.7 + rng() * 0.6) : null;
    return {
      id: s.meta.id, name: s.meta.name, ticker: s.meta.ticker, ecosystem: s.meta.ecosystem, tvl, tvlChange7d: tvl / weekAgo - 1,
      inflow, outflow, net: stableChange ?? inflow - outflow, stablecoins: tvl * (0.18 + rng() * 0.15), stableChange,
      dexVolume: tvl * 0.03 * (window === '5m' ? 1 / 288 : hours / 24) * (0.6 + rng() * 0.8), poolLiquidity: tvl * (0.03 + rng() * 0.04),
    };
  }).sort((a, b) => b.tvl - a.tvl);
  return {
    window,
    chains,
    flows: netFlows(gravityMatrix(chains)),
    totals: {
      tvl: chains.reduce((s, c) => s + c.tvl, 0),
      bridged: chains.reduce((s, c) => s + c.inflow, 0),
      stablecoins: chains.reduce((s, c) => s + (c.stablecoins ?? 0), 0),
      dexVolume: chains.reduce((s, c) => s + (c.dexVolume ?? 0), 0),
    },
    routing: 'simulated',
    routesWindow: window,
    sources: [{ name: 'Simulator', ok: true, updatedAt: Date.now(), note: 'DATA_MODE=demo or live sources unreachable' }],
    source: 'demo',
    updatedAt: Date.now(),
  };
}

// ---------- public ----------

let flowSource: DataSource = DATA_MODE === 'demo' ? 'demo' : 'live';

export async function flowsSource(): Promise<DataSource> {
  if (DATA_MODE === 'demo') return 'demo';
  await getFlows('1d').catch(() => {});
  return flowSource;
}

export async function getFlows(window: FlowWindow): Promise<FlowsResponse> {
  if (DATA_MODE === 'demo') return demoFlows(window);
  try {
    const r = await liveFlows(window);
    flowSource = 'live';
    return r;
  } catch (err) {
    if (DATA_MODE === 'live') throw err;
    if (flowSource !== 'demo') console.warn(`[flows] live data unavailable, using simulated flows: ${(err as Error).message}`);
    flowSource = 'demo';
    return demoFlows(window);
  }
}

export async function getChainDetail(id: string, window: FlowWindow): Promise<ChainDetail | null> {
  const flows = await getFlows(window);
  const chain = flows.chains.find((c) => c.id === id);
  if (!chain) return null;
  const counterparts = flows.chains
    .filter((c) => c.id !== id)
    .map((c) => ({
      chain: c.id,
      name: c.name,
      ecosystem: c.ecosystem,
      toHere: flows.flows.find((f) => f.from === c.id && f.to === id)?.usd ?? 0,
      fromHere: flows.flows.find((f) => f.from === id && f.to === c.id)?.usd ?? 0,
    }))
    .filter((c) => c.toHere || c.fromHere)
    .sort((a, b) => b.toHere + b.fromHere - (a.toHere + a.fromHere));

  if (flows.source === 'demo') {
    const s = demoSeries().find((x) => x.meta.id === id)!;
    const rng = mulberry32(hashSeed(id + 'extra'));
    let st = chain.stablecoins ?? chain.tvl * 0.2;
    const stableHistory = s.days.map((d) => ({ t: d.t, v: (st += (d.inflow - d.outflow) * 0.5) }));
    return {
      chain, counterparts, tvlHistory: s.tvlHistory, flowHistory: s.days, stableHistory,
      dexHistory: s.days.map((d) => ({ t: d.t, v: chain.tvl * 0.03 * (0.6 + rng() * 0.8) })),
      bridges: [], topTokens: [], source: 'demo', updatedAt: Date.now(),
    };
  }

  const [tvlHistory, daily, stableHistory, dexData] = await Promise.all([settle(tvlHist(id)), settle(whDaily('all')), settle(stablesHist(id)), settle(dex(id))]);
  const byDay = new Map<number, { t: number; inflow: number; outflow: number }>();
  for (const b of daily ?? []) {
    const src = byWh.get(b.src);
    const dst = byWh.get(b.dst);
    if (src !== id && dst !== id) continue;
    const row = byDay.get(b.from) ?? { t: b.from, inflow: 0, outflow: 0 };
    if (dst === id) row.inflow += b.usd;
    if (src === id) row.outflow += b.usd;
    byDay.set(b.from, row);
  }
  return {
    chain,
    counterparts,
    tvlHistory: (tvlHistory ?? []).slice(-180),
    flowHistory: [...byDay.values()].sort((a, b) => a.t - b.t),
    stableHistory: (stableHistory ?? []).slice(-180),
    dexHistory: (dexData?.daily ?? []).slice(-60),
    bridges: [],
    topTokens: [],
    source: 'live',
    updatedAt: Date.now(),
  };
}
