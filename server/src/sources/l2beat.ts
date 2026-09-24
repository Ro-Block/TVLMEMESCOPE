import { getJson, num, sourceHealth, swr } from '../http.ts';

// L2BEAT public API (no key): Total Value Secured per L2, from /api/scaling/summary, wrapped in a
// { success, data } envelope. Their exact field layout isn't documented where we could verify it,
// so the reader only accepts values it recognises and reports anything else instead of guessing.
const URL = 'https://l2beat.com/api/scaling/summary';

/** Our chain id -> slugs L2BEAT may use for it. */
export const L2BEAT_SLUGS: Record<string, string[]> = {
  arbitrum: ['arbitrum'],
  base: ['base'],
  optimism: ['op-mainnet', 'optimism'],
  lighter: ['lighter'],
  robinhood: ['robinhood', 'robinhood-chain'],
};

/** Finds a USD TVS number on one project entry, trying the layouts L2BEAT has used. */
export function projectTvs(p: Record<string, any>): number | null {
  const candidates = [p?.tvs?.breakdown?.total, p?.tvs?.total, p?.tvs?.usdValue, p?.tvs?.usd, p?.tvl?.breakdown?.total, p?.tvl?.total];
  for (const c of candidates) {
    const v = num(c);
    if (v > 0) return v;
  }
  return null;
}

/** Parses the summary response into slug -> TVS (USD). Throws with a description if unrecognised. */
export function parseSummary(res: unknown): Map<string, number> {
  const r = res as { success?: boolean; data?: { projects?: unknown } };
  const projects = r?.data?.projects;
  const list: Record<string, any>[] = Array.isArray(projects) ? projects : projects && typeof projects === 'object' ? Object.entries(projects).map(([k, v]) => ({ slug: k, ...(v as object) })) : [];
  const out = new Map<string, number>();
  for (const p of list) {
    const slug = String(p.slug ?? p.id ?? '');
    const v = projectTvs(p);
    if (slug && v !== null) out.set(slug, v);
  }
  if (!out.size) {
    const keys = r && typeof r === 'object' ? Object.keys(r).join(',') : typeof r;
    throw new Error(`format not recognised (top-level keys: ${keys}; data keys: ${r?.data ? Object.keys(r.data).join(',') : '-'})`);
  }
  return out;
}

export const l2beatTvs = swr(15 * 60_000, async () => {
  try {
    const res = await getJson<unknown>('l2beat', URL, { timeoutMs: 25_000 });
    return parseSummary(res);
  } catch (e) {
    sourceHealth.l2beat = { ...sourceHealth.l2beat, ok: false, lastError: (e as Error).message };
    throw e;
  }
});

/** TVS for one of our chains, or null. */
export function tvsFor(map: Map<string, number> | null, chainId: string): number | null {
  if (!map) return null;
  for (const slug of L2BEAT_SLUGS[chainId] ?? []) {
    const v = map.get(slug);
    if (v !== undefined) return v;
  }
  return null;
}
