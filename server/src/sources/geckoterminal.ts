import { SCAN } from '../config.ts';
import { getJson, num, RateLimiter } from '../http.ts';

// GeckoTerminal public API v2 (no key). One shared limiter keeps us inside the free tier.
const GT = 'https://api.geckoterminal.com/api/v2';
export const gtLimiter = new RateLimiter(SCAN.gtPerMinute);
const headers = { accept: 'application/json;version=20230302' };

export interface GtPool {
  network: string;
  address: string;
  name: string;
  dex: string;
  createdAt: number;
  baseAddress: string;
  baseSymbol: string;
  quoteSymbol: string;
  imageUrl?: string;
  priceUsd: number;
  mcap: number;
  liquidity: number;
  volume: { m5: number; h1: number; h24: number };
  txns: { h1: { buys: number; sells: number }; h24: { buys: number; sells: number } };
  change: { m5: number; h1: number; h24: number };
}

export interface GtTrade {
  tx: string;
  wallet: string;
  kind: 'buy' | 'sell';
  token: string; // the pool's base token address
  qty: number;
  usd: number;
  priceUsd: number;
  ts: number;
  block: number | null;
}

type Rel = { data?: { id?: string } };
interface GtResource {
  id: string;
  attributes: Record<string, any>;
  relationships?: { base_token?: Rel; quote_token?: Rel; dex?: Rel };
}
interface GtList {
  data: GtResource[];
  included?: GtResource[];
}

/** GeckoTerminal ids look like `solana_<address>`; strip the network prefix. */
const stripNet = (id: string | undefined) => (id ? id.slice(id.indexOf('_') + 1) : '');

/** GeckoTerminal returns a 'missing.png' placeholder for tokens without a logo. */
const goodImage = (u: unknown) => (typeof u === 'string' && /^https?:\/\//.test(u) && !/missing/i.test(u) ? u : undefined);

function mapPools(network: string, res: GtList): GtPool[] {
  const inc = new Map((res.included ?? []).map((r) => [r.id, r.attributes]));
  return res.data.map((p) => {
    const a = p.attributes;
    const baseId = p.relationships?.base_token?.data?.id;
    const quoteId = p.relationships?.quote_token?.data?.id;
    const [nBase, nQuote] = String(a.name ?? '').split(' / ');
    const tx = a.transactions ?? {};
    return {
      network,
      address: String(a.address),
      name: String(a.name ?? ''),
      dex: stripNet(p.relationships?.dex?.data?.id) || String(p.relationships?.dex?.data?.id ?? ''),
      createdAt: Date.parse(a.pool_created_at) || Date.now(),
      baseAddress: stripNet(baseId),
      baseSymbol: String(inc.get(baseId ?? '')?.symbol ?? nBase ?? '?'),
      quoteSymbol: String(inc.get(quoteId ?? '')?.symbol ?? nQuote ?? '?'),
      imageUrl: goodImage(inc.get(baseId ?? '')?.image_url),
      priceUsd: num(a.base_token_price_usd),
      mcap: num(a.market_cap_usd) || num(a.fdv_usd),
      liquidity: num(a.reserve_in_usd),
      volume: { m5: num(a.volume_usd?.m5), h1: num(a.volume_usd?.h1), h24: num(a.volume_usd?.h24) },
      txns: {
        h1: { buys: num(tx.h1?.buys), sells: num(tx.h1?.sells) },
        h24: { buys: num(tx.h24?.buys), sells: num(tx.h24?.sells) },
      },
      change: {
        m5: num(a.price_change_percentage?.m5) / 100,
        h1: num(a.price_change_percentage?.h1) / 100,
        h24: num(a.price_change_percentage?.h24) / 100,
      },
    };
  });
}

export async function newPools(network: string, page = 1): Promise<GtPool[]> {
  const res = await getJson<GtList>('geckoterminal', `${GT}/networks/${network}/new_pools?include=base_token,quote_token,dex&page=${page}`, { limiter: gtLimiter, headers });
  return mapPools(network, res);
}

export async function trendingPools(network: string, duration: '5m' | '1h' | '6h' | '24h' = '1h'): Promise<GtPool[]> {
  const res = await getJson<GtList>('geckoterminal', `${GT}/networks/${network}/trending_pools?include=base_token,quote_token,dex&duration=${duration}`, { limiter: gtLimiter, headers });
  return mapPools(network, res);
}

export async function networks(): Promise<string[]> {
  const res = await getJson<GtList>('geckoterminal', `${GT}/networks?page=1`, { limiter: gtLimiter, headers, retries: 0, timeoutMs: 8_000 });
  return res.data.map((n) => n.id);
}

/** Last ~300 trades (24h) on a pool, mapped to base-token buys/sells. */
export async function poolTrades(network: string, pool: string, baseToken: string): Promise<GtTrade[]> {
  const res = await getJson<{ data: GtResource[] }>('geckoterminal', `${GT}/networks/${network}/pools/${pool}/trades`, { limiter: gtLimiter, headers });
  const out: GtTrade[] = [];
  for (const t of res.data ?? []) {
    const a = t.attributes;
    const kind = a.kind === 'sell' ? 'sell' : 'buy';
    // For a buy the wallet receives ("to") the base token; for a sell it sends ("from") it.
    const token = String(kind === 'buy' ? a.to_token_address : a.from_token_address);
    if (baseToken && token.toLowerCase() !== baseToken.toLowerCase()) continue;
    out.push({
      tx: String(a.tx_hash),
      wallet: String(a.tx_from_address),
      kind,
      token,
      qty: num(kind === 'buy' ? a.to_token_amount : a.from_token_amount),
      usd: num(a.volume_in_usd),
      priceUsd: num(kind === 'buy' ? a.price_to_in_usd : a.price_from_in_usd),
      ts: Date.parse(a.block_timestamp) || Date.now(),
      block: a.block_number != null ? num(a.block_number) : null,
    });
  }
  return out;
}

export const pairUrl = (network: string, pool: string) => `https://www.geckoterminal.com/${network}/pools/${pool}`;
