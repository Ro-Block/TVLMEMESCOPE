import type { Ecosystem } from '../../../shared/types.ts';

// Ecosystem identity colours are CSS variables (--eco-*) so light/dark are chosen in one place.
const VAR: Record<Ecosystem, string> = {
  Ethereum: 'var(--eco-ethereum)',
  Solana: 'var(--eco-solana)',
  Hyperliquid: 'var(--eco-hyperliquid)',
  BNB: 'var(--eco-bnb)',
  Base: 'var(--eco-base)',
  Robinhood: 'var(--eco-robinhood)',
  Other: 'var(--eco-other)',
};
export const ecoColor = (e: Ecosystem) => VAR[e] ?? VAR.Other;

const CHAIN_ECO: Record<string, Ecosystem> = { solana: 'Solana', base: 'Base', robinhood: 'Robinhood', bsc: 'BNB', hyperevm: 'Hyperliquid' };
export const chainColor = (chain: string) => ecoColor(CHAIN_ECO[chain] ?? 'Other');
