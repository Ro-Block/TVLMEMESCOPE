import { getJson, RateLimiter } from '../http.ts';

// DexScreener token metadata (no key, ~300 req/min). Used to fill in token images that
// GeckoTerminal doesn't have: projects register their logo / socials there after launch.
const limiter = new RateLimiter(60);

/** Our chain ids -> DexScreener chain ids. Override with DS_CHAIN_<ID>. */
export const dsChain = (chain: string) => process.env[`DS_CHAIN_${chain.toUpperCase()}`] ?? chain;

interface DsPair {
  baseToken?: { address?: string };
  info?: { imageUrl?: string };
}

/** Image URL per token address (up to 30 addresses per call). */
export async function tokenImages(chain: string, tokens: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!tokens.length) return out;
  const res = await getJson<DsPair[]>('dexscreener', `https://api.dexscreener.com/tokens/v1/${dsChain(chain)}/${tokens.slice(0, 30).join(',')}`, { limiter });
  for (const p of Array.isArray(res) ? res : []) {
    const addr = p.baseToken?.address;
    if (addr && p.info?.imageUrl && !out.has(addr.toLowerCase())) out.set(addr.toLowerCase(), p.info.imageUrl);
  }
  return out;
}
