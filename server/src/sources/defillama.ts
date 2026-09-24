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
