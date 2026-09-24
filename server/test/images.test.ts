import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pair } from '../../shared/types.ts';
import { DEFAULT_ALERT_SETTINGS } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Ledger } from '../src/engine/ledger.ts';

const pair = (imageUrl?: string): Pair => ({
  id: 'base:0xpool', chain: 'base', address: '0xpool', dex: 'uniswap-v4', name: 'X / WETH', baseSymbol: 'X', baseAddress: '0xTOKEN', quoteSymbol: 'WETH', imageUrl,
  createdAt: Date.now(), priceUsd: 1, mcap: 1, liquidity: 1, volume: { m5: 0, h1: 0, h24: 0 }, txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
  change: { m5: 0, h1: 0, h24: 0 }, trending: false, smartWallets: [], url: '',
});

test('a DexScreener logo wins over GeckoTerminal and survives later polls', () => {
  const ledger = new Ledger(openDb(':memory:'), 60, () => DEFAULT_ALERT_SETTINGS);
  ledger.upsertPools([pair('https://gt/logo.png')]);
  assert.equal(ledger.pool('base:0xpool')!.imageUrl, 'https://gt/logo.png');

  ledger.setTokenImage('base', '0xtoken', 'https://ds/creator-logo.png');
  assert.equal(ledger.pool('base:0xpool')!.imageUrl, 'https://ds/creator-logo.png');
  assert.equal(ledger.hasTokenImage('base', '0xToken'), true);

  ledger.upsertPools([pair('https://gt/logo.png')]);
  assert.equal(ledger.pool('base:0xpool')!.imageUrl, 'https://ds/creator-logo.png');
  ledger.upsertPools([pair(undefined)]);
  assert.equal(ledger.pool('base:0xpool')!.imageUrl, 'https://ds/creator-logo.png');
});
