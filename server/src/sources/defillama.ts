import { getJson, num } from '../http.ts';

// DefiLlama public endpoints (no key). Bridge semantics follow DefiLlama's bridge dashboard:
// "deposit" = value locked into a bridge on this chain (leaving), "withdraw" = value released here (arriving).

const LLAMA = 'https://api.llama.fi';
const BRIDGES = 'https://bridges.llama.fi';

export interface LlamaChain {
  name: string;
  tvl: number;
}

export async function chainsTvl(): Promise<LlamaChain[]> {
  const rows = await getJson<{ name: string; tvl: number }[]>('defillama', `${LLAMA}/v2/chains`);
  return rows.map((r) => ({ name: r.name, tvl: num(r.tvl) }));
}

/** Current TVL of a protocol (used for app-rollups DefiLlama tracks as protocols). */
export async function protocolTvl(slug: string): Promise<number> {
  return num(await getJson<number>('defillama', `${LLAMA}/tvl/${encodeURIComponent(slug)}`));
}

// ---------- stablecoins (stablecoins.llama.fi, free) ----------

const STABLES = 'https://stablecoins.llama.fi';

/** Current stablecoin supply (USD) per chain name. */
export async function stablecoinChains(): Promise<Map<string, number>> {
  const rows = await getJson<{ name: string; totalCirculatingUSD?: { peggedUSD?: number } }[]>('defillama-stablecoins', `${STABLES}/stablecoinchains`);
  return new Map(rows.map((r) => [r.name.toLowerCase(), num(r.totalCirculatingUSD?.peggedUSD)]));
}

/** Daily stablecoin supply (USD) on one chain. */
export async function stablecoinHistory(name: string): Promise<{ t: number; v: number }[]> {
  const rows = await getJson<{ date: string; totalCirculatingUSD?: { peggedUSD?: number } }[]>('defillama-stablecoins', `${STABLES}/stablecoincharts/${encodeURIComponent(name)}`);
  return rows.map((r) => ({ t: num(r.date) * 1000, v: num(r.totalCirculatingUSD?.peggedUSD) })).filter((r) => r.v > 0);
}

// ---------- DEX volume (free) ----------

/** Daily DEX volume on one chain, plus DefiLlama's own 24h total. */
export async function dexVolume(name: string): Promise<{ total24h: number; daily: { t: number; v: number }[] }> {
  const res = await getJson<{ total24h?: number; totalDataChart?: [number, number][] }>(
    'defillama-dexs',
    `${LLAMA}/overview/dexs/${encodeURIComponent(name)}?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=true`,
    { timeoutMs: 25_000 },
  );
  return { total24h: num(res.total24h), daily: (res.totalDataChart ?? []).slice(-60).map(([t, v]) => ({ t: t * 1000, v: num(v) })) };
}

export async function chainTvlHistory(name: string): Promise<{ t: number; v: number }[]> {
  const rows = await getJson<{ date: number; tvl: number }[]>('defillama', `${LLAMA}/v2/historicalChainTvl/${encodeURIComponent(name)}`);
  return rows.map((r) => ({ t: num(r.date) * 1000, v: num(r.tvl) }));
}

export interface BridgeDay {
  t: number;
  depositUSD: number;
  withdrawUSD: number;
}

export async function bridgeVolume(name: string): Promise<BridgeDay[]> {
  const rows = await getJson<{ date: string | number; depositUSD: number; withdrawUSD: number }[]>(
    'defillama-bridges',
    `${BRIDGES}/bridgevolume/${encodeURIComponent(name)}`,
  );
  return rows
    .map((r) => ({ t: num(r.date) * 1000, depositUSD: num(r.depositUSD), withdrawUSD: num(r.withdrawUSD) }))
    .sort((a, b) => a.t - b.t);
}

export interface LlamaBridge {
  name: string;
  chains: string[];
  daily: number;
  weekly: number;
  monthly: number;
}

export async function bridges(): Promise<LlamaBridge[]> {
  const res = await getJson<{ bridges: Record<string, unknown>[] }>('defillama-bridges', `${BRIDGES}/bridges?includeChains=true`);
  return (res.bridges ?? []).map((b) => ({
    name: String(b.displayName ?? b.name ?? 'bridge'),
    chains: Array.isArray(b.chains) ? (b.chains as string[]) : [],
    daily: num(b.lastDailyVolume),
    weekly: num(b.weeklyVolume),
    monthly: num(b.monthlyVolume),
  }));
}

export interface LargeTx {
  ts: number;
  txHash: string;
  token: string;
  usd: number;
  /** true = deposited into a bridge on this chain (leaving), false = released here (arriving). */
  isDeposit: boolean;
  bridge?: string;
}

/** Individual large bridge transfers on one chain in a time range (seconds). */
export async function largeTransactions(name: string, startSec: number, endSec: number): Promise<LargeTx[]> {
  const rows = await getJson<Record<string, unknown>[]>(
    'defillama-bridges',
    `${BRIDGES}/largetransactions/${encodeURIComponent(name)}?startTimestamp=${startSec}&endTimestamp=${endSec}`,
  );
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    ts: num(r.date) * 1000,
    txHash: String(r.txHash ?? ''),
    token: String(r.symbol ?? r.token ?? ''),
    usd: num(r.usdValue),
    isDeposit: r.isDeposit === true || r.isDeposit === 'true',
    bridge: typeof r.bridgeName === 'string' ? r.bridgeName : undefined,
  }));
}

type TokenMap = Record<string, { symbol?: string; usdValue?: number }>;

/** Token breakdown for one chain on one day (timestamp = start of day, seconds). */
export async function bridgeDayTokens(tsSec: number, name: string) {
  const res = await getJson<{ totalTokensDeposited?: TokenMap; totalTokensWithdrawn?: TokenMap }[] | { totalTokensDeposited?: TokenMap; totalTokensWithdrawn?: TokenMap }>(
    'defillama-bridges',
    `${BRIDGES}/bridgedaystats/${tsSec}/${encodeURIComponent(name)}`,
  );
  const day = Array.isArray(res) ? res[0] : res;
  const out = new Map<string, { symbol: string; inUsd: number; outUsd: number }>();
  const add = (m: TokenMap | undefined, key: 'inUsd' | 'outUsd') => {
    for (const v of Object.values(m ?? {})) {
      const symbol = v.symbol ?? '?';
      const row = out.get(symbol) ?? { symbol, inUsd: 0, outUsd: 0 };
      row[key] += num(v.usdValue);
      out.set(symbol, row);
    }
  };
  add(day?.totalTokensWithdrawn, 'inUsd');
  add(day?.totalTokensDeposited, 'outUsd');
  return [...out.values()].sort((a, b) => b.inUsd + b.outUsd - (a.inUsd + a.outUsd)).slice(0, 10);
}
