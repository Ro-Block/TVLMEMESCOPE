import { getJson, num, RateLimiter } from '../http.ts';

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

export interface DsPairStats {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd: number;
  marketCap: number;
  liquidityUsd: number;
  volume: { m5: number; h1: number; h6: number; h24: number };
  txns: { m5: { buys: number; sells: number }; h1: { buys: number; sells: number }; h24: { buys: number; sells: number } };
  change: { m5: number; h1: number; h24: number }; // fractions
  pairCreatedAt: number; // ms
  imageUrl?: string;
}

const pairLimiter = new RateLimiter(200); // pairs endpoints allow 300/min

/** Pair stats for up to 30 tokens on one chain (all their pairs, best-liquidity first per token). */
export async function pairsForTokens(chain: string, tokens: string[]): Promise<DsPairStats[]> {
  if (!tokens.length) return [];
  const res = await getJson<Record<string, any>[]>('dexscreener', `https://api.dexscreener.com/tokens/v1/${dsChain(chain)}/${tokens.slice(0, 30).join(',')}`, { limiter: pairLimiter });
  const tx = (t: any) => ({ buys: num(t?.buys), sells: num(t?.sells) });
  return (Array.isArray(res) ? res : [])
    .map((p) => ({
      chainId: String(p.chainId ?? ''),
      dexId: String(p.dexId ?? ''),
      url: String(p.url ?? ''),
      pairAddress: String(p.pairAddress ?? ''),
      baseToken: { address: String(p.baseToken?.address ?? ''), name: String(p.baseToken?.name ?? ''), symbol: String(p.baseToken?.symbol ?? '?') },
      quoteToken: { address: String(p.quoteToken?.address ?? ''), symbol: String(p.quoteToken?.symbol ?? '?') },
      priceUsd: num(p.priceUsd),
      marketCap: num(p.marketCap) || num(p.fdv),
      liquidityUsd: num(p.liquidity?.usd),
      volume: { m5: num(p.volume?.m5), h1: num(p.volume?.h1), h6: num(p.volume?.h6), h24: num(p.volume?.h24) },
      txns: { m5: tx(p.txns?.m5), h1: tx(p.txns?.h1), h24: tx(p.txns?.h24) },
      change: { m5: num(p.priceChange?.m5) / 100, h1: num(p.priceChange?.h1) / 100, h24: num(p.priceChange?.h24) / 100 },
      pairCreatedAt: num(p.pairCreatedAt),
      imageUrl: typeof p.info?.imageUrl === 'string' ? p.info.imageUrl : undefined,
    }))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd);
}
