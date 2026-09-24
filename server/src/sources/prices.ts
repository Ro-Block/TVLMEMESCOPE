import { getJson, num, swr } from '../http.ts';

// Native-token USD prices from DefiLlama's free coins API, refreshed every minute.
const IDS: Record<string, string> = {
  solana: 'coingecko:solana',
  ethereum: 'coingecko:ethereum',
  bnb: 'coingecko:binancecoin',
  hype: 'coingecko:hyperliquid',
};

const load = swr(60_000, async () => {
  const res = await getJson<{ coins: Record<string, { price?: number }> }>('defillama-prices', `https://coins.llama.fi/prices/current/${Object.values(IDS).join(',')}`);
  const out: Record<string, number> = {};
  for (const [k, id] of Object.entries(IDS)) out[k] = num(res.coins?.[id]?.price);
  return out;
});

/** USD price of a native asset ('solana' | 'ethereum' | 'bnb' | 'hype'), or 0 while unknown. */
export async function nativeUsd(asset: string): Promise<number> {
  return (await load('all', 10_000))?.[asset] ?? 0;
}
