import { ARKHAM } from '../config.ts';
import { RateLimiter, sourceHealth } from '../http.ts';

// Arkham Intel API: who owns an address (entity such as a fund, exchange or KOL, or a label).
// GET https://api.arkm.com/intelligence/address/{address} with header API-Key. The key lives only in .env.
const limiter = new RateLimiter(20); // gentle: one lookup every 3 s at most

export const arkhamEnabled = () => Boolean(ARKHAM.apiKey);

export interface ArkhamLabel {
  name: string; // entity name if attributed, else label name
  type?: string; // entity type, e.g. "fund", "cex", "individual"
}

/** Picks the most useful name from an address response; null when Arkham has nothing. */
export function labelFromResponse(j: unknown): ArkhamLabel | null {
  const r = j as { arkhamEntity?: { name?: string; type?: string }; arkhamLabel?: { name?: string } };
  if (r?.arkhamEntity?.name) return { name: r.arkhamEntity.name, type: r.arkhamEntity.type };
  if (r?.arkhamLabel?.name) return { name: r.arkhamLabel.name };
  return null;
}

export async function lookup(address: string): Promise<ArkhamLabel | null> {
  await limiter.take();
  const res = await fetch(`https://api.arkm.com/intelligence/address/${encodeURIComponent(address)}`, { headers: { 'API-Key': ARKHAM.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) {
    sourceHealth.arkham = { ...sourceHealth.arkham, ok: false, lastError: `${res.status} ${res.statusText}` };
    throw new Error(`arkham: ${res.status}`);
  }
  sourceHealth.arkham = { ok: true, lastOk: Date.now() };
  return labelFromResponse(await res.json());
}
