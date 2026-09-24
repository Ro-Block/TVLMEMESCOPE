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

export interface DsProfile {
  chain: string; // DexScreener chain id
  token: string;
  icon: string;
}

/** Tokens whose creators just published a DexScreener profile (logo, banner, links). */
export async function latestProfiles(): Promise<DsProfile[]> {
  const res = await getJson<{ chainId?: string; tokenAddress?: string; icon?: string }[]>('dexscreener', 'https://api.dexscreener.com/token-profiles/latest/v1', { limiter });
  return (Array.isArray(res) ? res : []).filter((p) => p.chainId && p.tokenAddress && p.icon).map((p) => ({ chain: p.chainId!, token: p.tokenAddress!, icon: p.icon! }));
}

/** DexScreener's token image CDN. Not a documented API, so it's only used as a fallback. */
export const cdnImage = (chain: string, token: string) => `https://dd.dexscreener.com/ds-data/tokens/${dsChain(chain)}/${chain === 'solana' ? token : token.toLowerCase()}.png`;

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
