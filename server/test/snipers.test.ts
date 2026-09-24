import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pair } from '../../shared/types.ts';
import type { LedgerTrade } from '../src/engine/roi.ts';
import { analyzeLaunch, buildProfiles, findRings } from '../src/engine/sniper-analysis.ts';

const pair = (i: number, createdAt: number): Pair => ({
  id: `solana:pool${i}`, chain: 'solana', address: `pool${i}`, dex: 'pumpswap', name: `T${i} / SOL`, baseSymbol: `T${i}`, baseAddress: `J7tok${i}`, quoteSymbol: 'SOL',
  createdAt, priceUsd: 1, mcap: 1, liquidity: 1, volume: { m5: 0, h1: 0, h24: 0 }, txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
  change: { m5: 0, h1: 0, h24: 0 }, trending: false, smartWallets: [], url: '',
});
const tr = (wallet: string, kind: 'buy' | 'sell', ts: number, block: number, usd = 500): LedgerTrade => ({ wallet, chain: 'solana', pool: 'p', token: 't', kind, qty: 100, usd, ts, block });

test('snipes, bundles and dumps are detected per launch', () => {
  const t0 = 1_000_000;
  const l = analyzeLaunch(
    {
      pair: pair(0, t0),
      trades: [
        tr('a', 'buy', t0 + 800, 10), tr('b', 'buy', t0 + 800, 10), // same block => bundle
        tr('c', 'buy', t0 + 2_500, 14), // solo sniper
        tr('late', 'buy', t0 + 30_000, 80, 5_000), // not a sniper
        tr('a', 'sell', t0 + 120_000, 400, 900), tr('b', 'sell', t0 + 130_000, 420, 900),
      ],
    },
    3,
  );
  assert.deepEqual(l.buys.map((b) => b.wallet).sort(), ['a', 'b', 'c']);
  assert.equal(l.bundled, 2);
  assert.equal(l.buys.find((b) => b.wallet === 'c')!.bundled, false);
  assert.ok(Math.abs(l.share - 1500 / 6500) < 1e-9);
  assert.equal(l.dumped, true); // a+b (2/3 of sniper $) sold everything within 10 min
});

test('rings are wallets that co-snipe far more than chance; exits reveal intention', () => {
  const launches = [];
  for (let i = 0; i < 30; i++) {
    const t0 = i * 3_600_000;
    const trades: LedgerTrade[] = [];
    // Two busy solo snipers hit every other launch, independently of each other.
    if (i % 2 === 0) trades.push(tr('solo1', 'buy', t0 + 1_000, i * 100 + 2));
    if (i % 3 === 0) trades.push(tr('solo2', 'buy', t0 + 1_500, i * 100 + 3));
    if (i % 3 === 1) {
      // Ring of three: same block, all dump within a minute of each other.
      for (const w of ['r1', 'r2', 'r3']) trades.push(tr(w, 'buy', t0 + 500, i * 100 + 1), tr(w, 'sell', t0 + 90_000 + w.charCodeAt(1) * 1_000, i * 100 + 50));
    }
    trades.sort((a, b) => a.ts - b.ts);
    launches.push(analyzeLaunch({ pair: pair(i, t0), trades }, 3));
  }
  const { rings } = findRings(launches);
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0].members, ['r1', 'r2', 'r3']);
  assert.equal(rings[0].intention, 'coordinated-dump');
  assert.equal(rings[0].sameBlockRate, 1);
  assert.equal(rings[0].sharedLaunches, 10);

  const prof = buildProfiles(launches).find((p) => p.wallet === 'r1')!;
  assert.equal(prof.launches, 10);
  assert.equal(prof.bundleRate, 1);
  assert.equal(prof.dumpRate, 1);
});

test('a ring that holds past the first hour is labelled as holding together', () => {
  const launches = [];
  for (let i = 0; i < 6; i++) {
    const t0 = i * 3_600_000;
    launches.push(analyzeLaunch({ pair: pair(i, t0), trades: ['h1', 'h2', 'h3'].map((w) => tr(w, 'buy', t0 + 700, i * 10)) }, 3));
  }
  // Every launch has the same three wallets, so lift is 1: add unrelated launches to give the base rate.
  for (let i = 6; i < 20; i++) launches.push(analyzeLaunch({ pair: pair(i, i * 3_600_000), trades: [tr(`x${i}`, 'buy', i * 3_600_000 + 1_000, i * 10)] }, 3));
  const { rings } = findRings(launches);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].intention, 'coordinated-hold');
});
