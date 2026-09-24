import { DUNE } from '../config.ts';
import { getJson, num } from '../http.ts';

// Optional 60-day backfill. Save sql/top_meme_traders_60d.sql as a Dune query, then set
// DUNE_API_KEY and DUNE_QUERY_ID. We read the latest cached result (no credits spent on execution).

export interface DuneTrader {
  wallet: string;
  chain: string;
  investedUsd: number;
  returnedUsd: number;
  trades: number;
  tokens: number;
  wins: number;
  lastActive: number;
}

export const duneEnabled = () => Boolean(DUNE.apiKey && DUNE.queryId);

export async function topTraders(): Promise<DuneTrader[]> {
  const res = await getJson<{ result?: { rows?: Record<string, unknown>[] } }>(
    'dune',
    `https://api.dune.com/api/v1/query/${DUNE.queryId}/results?limit=5000`,
    { headers: { 'X-Dune-API-Key': DUNE.apiKey }, timeoutMs: 30_000 },
  );
  return (res.result?.rows ?? []).map((r) => ({
    wallet: String(r.wallet),
    chain: String(r.chain),
    investedUsd: num(r.invested_usd),
    returnedUsd: num(r.returned_usd),
    trades: num(r.trades),
    tokens: num(r.tokens),
    wins: num(r.wins),
    lastActive: Date.parse(String(r.last_active)) || Date.now(),
  }));
}
