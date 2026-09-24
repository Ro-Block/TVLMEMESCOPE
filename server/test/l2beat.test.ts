import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSummary, tvsFor } from '../src/sources/l2beat.ts';

test('L2BEAT summary as served: top-level chart + projects, total from the latest chart row', () => {
  const s = parseSummary({
    chart: { types: ['timestamp', 'native', 'canonical', 'external', 'ethPrice'], data: [[1787616000, 1e9, 2e9, 3e9, 2481], [1787637600, 10964980375.2, 14390888455.9, 13643804380.7, 2507.9]] },
    projects: { base: { name: 'Base Chain', tvs: { breakdown: { native: 1e9, canonical: 4e9, external: 7e9 } } } },
  });
  assert.ok(Math.abs(s.total! - (10964980375.2 + 14390888455.9 + 13643804380.7)) < 1);
  assert.equal(tvsFor(s, 'base'), 12e9); // native + canonical + external when there's no total field
});

test('L2BEAT summary: projects keyed by slug with tvs.breakdown.total', () => {
  const m = parseSummary({ success: true, data: { projects: { arbitrum: { name: 'Arbitrum One', tvs: { breakdown: { total: 16.2e9 } } }, 'op-mainnet': { tvs: { breakdown: { total: 2.1e9 } } } } } });
  assert.equal(tvsFor(m, 'arbitrum'), 16.2e9);
  assert.equal(tvsFor(m, 'optimism'), 2.1e9); // our id -> their slug
  assert.equal(tvsFor(m, 'solana'), null);
});

test('L2BEAT summary: array of projects is accepted too', () => {
  const m = parseSummary({ success: true, data: { projects: [{ slug: 'base', tvs: { total: 12e9 } }] } });
  assert.equal(tvsFor(m, 'base'), 12e9);
});

test('an unrecognised L2BEAT response is reported, never turned into numbers', () => {
  assert.throws(() => parseSummary({ success: true, data: { something: [] } }), /format not recognised/);
  // Chart alone is still useful: the all-L2 total, no per-chain values.
  const onlyChart = parseSummary({ chart: { types: ['timestamp', 'native', 'canonical', 'external'], data: [[1, 1, 2, 3]] }, projects: { x: { weird: true } } });
  assert.equal(onlyChart.total, 6);
  assert.equal(tvsFor(onlyChart, 'base'), null);
  assert.throws(() => parseSummary('<html>'), /format not recognised/);
});

import { labelFromResponse } from '../src/sources/arkham.ts';

test('Arkham: entity name wins over label; nothing attributed gives null', () => {
  assert.deepEqual(labelFromResponse({ address: '0xabc', arkhamEntity: { name: 'Wintermute', type: 'fund' }, arkhamLabel: { name: 'Hot Wallet' } }), { name: 'Wintermute', type: 'fund' });
  assert.deepEqual(labelFromResponse({ address: '0xabc', arkhamLabel: { name: 'Jump Trading Deployer' } }), { name: 'Jump Trading Deployer' });
  assert.equal(labelFromResponse({ address: '0xabc', chain: 'ethereum' }), null);
});
