import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSummary, tvsFor } from '../src/sources/l2beat.ts';

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
  assert.throws(() => parseSummary('<html>'), /format not recognised/);
});

import { labelFromResponse } from '../src/sources/arkham.ts';

test('Arkham: entity name wins over label; nothing attributed gives null', () => {
  assert.deepEqual(labelFromResponse({ address: '0xabc', arkhamEntity: { name: 'Wintermute', type: 'fund' }, arkhamLabel: { name: 'Hot Wallet' } }), { name: 'Wintermute', type: 'fund' });
  assert.deepEqual(labelFromResponse({ address: '0xabc', arkhamLabel: { name: 'Jump Trading Deployer' } }), { name: 'Jump Trading Deployer' });
  assert.equal(labelFromResponse({ address: '0xabc', chain: 'ethereum' }), null);
});
