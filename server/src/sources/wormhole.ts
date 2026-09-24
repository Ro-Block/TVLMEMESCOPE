import { getJson, num } from '../http.ts';

// Wormholescan public API (no key). Gives real source → destination volume per chain pair,
// bucketed by hour or day, for every app on Wormhole (Portal, NTT, CCTP-via-Wormhole, Mayan…).
const WH = 'https://api.wormholescan.io/api/v1';

export interface PairBucket {
  from: number; // bucket start (ms)
  src: number; // Wormhole chain id
  dst: number;
  usd: number;
  count: number;
}

/** Raw buckets; `volume` scale is calibrated separately (see calibrate). */
async function tops(timespan: '1h' | '1d', fromMs: number, toMs: number): Promise<PairBucket[]> {
  const q = `timespan=${timespan}&from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}`;
  const rows = await getJson<Record<string, unknown>[]>('wormholescan', `${WH}/x-chain-activity/tops?${q}`, { timeoutMs: 20_000 });
  return (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      from: Date.parse(String(r.from)) || 0,
      src: num(r.emitter_chain),
      dst: num(r.destination_chain),
      usd: num(r.volume),
      count: num(r.count),
    }))
    .filter((r) => r.src && r.dst && r.src !== r.dst);
}

/** Total 7d notional in USD from x-chain-activity (decimal USD), used to calibrate `tops` units. */
async function weekTotalUsd(): Promise<number> {
  const res = await getJson<{ txs?: { volume?: unknown }[] }>('wormholescan', `${WH}/x-chain-activity?timeSpan=7d`, { timeoutMs: 20_000 });
  return (res.txs ?? []).reduce((s, t) => s + num(t.volume), 0);
}

let scale: number | null = null;

/**
 * `tops.volume` is an integer; Wormholescan stores notional with 8 decimals in places. Compare a
 * week of daily buckets with the decimal 7d total once and pick the factor that makes them agree.
 */
async function calibrate(daily: PairBucket[]): Promise<number> {
  if (scale !== null) return scale;
  try {
    const ref = await weekTotalUsd();
    const since = Date.now() - 7 * 86_400_000;
    const raw = daily.filter((b) => b.from >= since).reduce((s, b) => s + b.usd, 0);
    if (ref > 0 && raw > 0) {
      const ratio = raw / ref;
      scale = ratio > 1e5 ? 1e-8 : 1;
      console.log(`[wormholescan] volume units calibrated (raw/ref ${ratio.toExponential(2)} → ×${scale})`);
      return scale;
    }
  } catch (e) {
    console.warn(`[wormholescan] calibration failed: ${(e as Error).message}`);
  }
  // Fallback guess: a single pair moving > $10T in a day means the numbers are scaled.
  return daily.some((b) => b.usd > 1e13) ? 1e-8 : 1;
}

export async function hourly(hours: number): Promise<PairBucket[]> {
  const now = Date.now();
  // Units are calibrated once from a week of daily buckets before hourly numbers are trusted.
  if (scale === null) await daily(8);
  const rows = await tops('1h', now - hours * 3_600_000, now);
  const k = scale ?? 1;
  return rows.map((r) => ({ ...r, usd: r.usd * k }));
}

/** For tests. */
export const _resetScale = () => {
  scale = null;
};

export async function daily(days: number): Promise<PairBucket[]> {
  const now = Date.now();
  const rows = await tops('1d', now - days * 86_400_000, now);
  const k = await calibrate(rows);
  return rows.map((r) => ({ ...r, usd: r.usd * k }));
}
