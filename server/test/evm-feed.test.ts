import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toEventSelector } from 'viem';
import { classifyPool, EV, EVM_CHAINS, swapToTrade, type TrackedPool } from '../src/feeds/evm.ts';

const base = EVM_CHAINS.find((c) => c.id === 'base')!;
const WETH = '0x4200000000000000000000000000000000000006';
const MEME = '0x1111111111111111111111111111111111111111';
const e18 = 10n ** 18n;

test('event signatures match the well-known topics', () => {
  assert.equal(toEventSelector(EV.v2Swap), '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822');
  assert.equal(toEventSelector(EV.v3Swap), '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67');
  assert.equal(toEventSelector(EV.pairCreated), '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9');
  assert.equal(toEventSelector(EV.poolCreated), '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118');
  assert.notEqual(toEventSelector(EV.pcsV3Swap), toEventSelector(EV.v3Swap), 'PancakeSwap v3 has two extra fields');
});

test('pools are classified by their quote token; quote/quote and unknown/unknown pools are skipped', () => {
  assert.deepEqual(classifyPool(base, MEME, WETH), { base: MEME, baseIs0: true, quote: base.quotes[WETH] });
  assert.equal(classifyPool(base, WETH, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'), null);
  assert.equal(classifyPool(base, MEME, '0x2222222222222222222222222222222222222222'), null);
});

const pool = (kind: TrackedPool['kind'], baseIs0 = true): TrackedPool => ({ kind, key: '0xpool', base: MEME, baseIs0, quote: base.quotes[WETH] });

test('v2: WETH in, tokens out is a buy', () => {
  // baseIs0: token0 = MEME, token1 = WETH. Trader sends 0.5 WETH, receives 1,000,000 MEME.
  const t = swapToTrade(pool('v2'), { amount0In: 0n, amount1In: e18 / 2n, amount0Out: 1_000_000n * e18, amount1Out: 0n }, 18, 3_000);
  assert.deepEqual(t, { kind: 'buy', qty: 1_000_000, usd: 1_500 });
});

test('v3: pool gains token and pays WETH = trader sold', () => {
  // Pool balance deltas: +200k MEME in, -0.2 WETH out.
  const t = swapToTrade(pool('v3'), { amount0: 200_000n * e18, amount1: -(e18 / 5n) }, 18, 3_000);
  assert.deepEqual(t, { kind: 'sell', qty: 200_000, usd: 600 });
});

test('v4: amounts are from the swapper, negative = paid into the pool', () => {
  // baseIs0 = false here: currency0 = ETH (quote), currency1 = MEME. Swapper pays 1 ETH, gets 5M MEME.
  const t = swapToTrade(pool('v4', false), { amount0: -e18, amount1: 5_000_000n * e18 }, 18, 3_000);
  assert.deepEqual(t, { kind: 'buy', qty: 5_000_000, usd: 3_000 });
  const s = swapToTrade(pool('v4', false), { amount0: e18 / 10n, amount1: -(500_000n * e18) }, 18, 3_000);
  assert.deepEqual(s, { kind: 'sell', qty: 500_000, usd: 300 });
});

test('non-swaps and dust are ignored', () => {
  assert.equal(swapToTrade(pool('v3'), { amount0: 5n, amount1: 5n }, 18, 3_000), null, 'both into the pool');
  assert.equal(swapToTrade(pool('v2'), { amount0In: 0n, amount1In: 1n, amount0Out: 1n, amount1Out: 0n }, 18, 3_000), null, 'under $1');
});
