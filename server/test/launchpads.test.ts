import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectLaunchpad } from '../src/launchpads.ts';

test('launchpads are recognised from the DEX or the mint suffix', () => {
  assert.equal(detectLaunchpad('solana', 'raydium', '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hrpump'), 'pump.fun');
  assert.equal(detectLaunchpad('solana', 'pumpswap', 'So1anaMintWithoutSuffix111111111111111111111'), 'pump.fun');
  assert.equal(detectLaunchpad('solana', 'raydium-launchlab', 'AbC123'), 'letsbonk.fun');
  assert.equal(detectLaunchpad('bsc', 'pancakeswap-v3', '0x1234567890abcdef1234567890abcdef12344444'), 'four.meme');
  assert.equal(detectLaunchpad('base', 'zora', '0xabc'), 'Zora');
  // A suffix only counts on its own chain.
  assert.equal(detectLaunchpad('base', 'uniswap-v3', '0x1234567890abcdef1234567890abcdef12344444'), undefined);
  assert.equal(detectLaunchpad('solana', 'raydium', 'NoKnownSuffix1111'), undefined);
});
