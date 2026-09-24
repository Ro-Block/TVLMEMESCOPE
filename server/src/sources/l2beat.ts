import { getJson, num, sourceHealth, swr } from '../http.ts';

// L2BEAT public API (no key): Total Value Secured from /api/scaling/summary: a `chart` with the
// all-L2 total ([timestamp, native, canonical, external, ethPrice]) and per-project entries. Their exact field layout isn't documented where we could verify it,
// so the reader only accepts values it recognises and reports anything else instead of guessing.
const URL = 'https://l2beat.com/api/scaling/summary';

/** Our chain id -> slugs L2BEAT may use for it. */
export const L2BEAT_SLUGS: Record<string, string[]> = {
  arbitrum: ['arbitrum', 'arbitrum-one'],
  base: ['base'],
  optimism: ['op-mainnet', 'optimism'],
  lighter: ['lighter'],
  robinhood: ['robinhood', 'robinhood-chain'],
};

/** Finds a USD TVS number on one project entry, trying the layouts L2BEAT has used. */
export function projectTvs(p: Record<string, any>): number | null {
  const tvs = p?.tvs ?? p?.tvl;
  const b = tvs?.breakdown;
  const sum = b ? num(b.native) + num(b.canonical) + num(b.external) : 0;
  const candidates = [b?.total, sum, tvs?.total, tvs?.usdValue, tvs?.usd, typeof tvs === 'number' ? tvs : undefined];
  for (const c of candidates) {
    const v = num(c);
    if (v > 0) return v;
  }
  return null;
}

/** Latest native + canonical + external from a { types, data } chart, in USD. */
export function chartTotal(chart: unknown): number | null {
  const c = chart as { types?: string[]; data?: number[][] };
  if (!Array.isArray(c?.types) || !Array.isArray(c?.data) || !c.data.length) return null;
  const idx = ['native', 'canonical', 'external'].map((t) => c.types!.indexOf(t));
  if (idx.some((i) => i < 0)) return null;
  const last = c.data[c.data.length - 1];
  const v = idx.reduce((s, i) => s + num(last[i]), 0);
  return v > 0 ? v : null;
}

export interface L2beatSummary {
  bySlug: Map<string, number>;
  /** Value secured across all L2s (from the summary chart). */
  total: number | null;
}

/** Parses /api/scaling/summary, with or without a { success, data } wrapper. */
export function parseSummary(res: unknown): L2beatSummary {
  const root = ((res as { data?: unknown })?.data ?? res) as { projects?: unknown; chart?: unknown };
  const projects = root?.projects;
  const list: Record<string, any>[] = Array.isArray(projects) ? projects : projects && typeof projects === 'object' ? Object.entries(projects).map(([k, v]) => ({ slug: k, ...(v as object) })) : [];
  const bySlug = new Map<string, number>();
  for (const p of list) {
    const v = projectTvs(p);
    if (v === null) continue;
    for (const k of [p.slug, p.id, p.key].filter(Boolean)) bySlug.set(String(k), v);
  }
  const total = chartTotal(root?.chart);
  if (!bySlug.size && total === null) {
    const keys = root && typeof root === 'object' ? Object.keys(root).join(',') : typeof root;
    throw new Error(`format not recognised (keys: ${keys})`);
  }
  return { bySlug, total };
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
export function tvsFor(summary: L2beatSummary | null, chainId: string): number | null {
  if (!summary) return null;
  for (const slug of L2BEAT_SLUGS[chainId] ?? []) {
    const v = summary.bySlug.get(slug);
    if (v !== undefined) return v;
  }
  return null;
}
