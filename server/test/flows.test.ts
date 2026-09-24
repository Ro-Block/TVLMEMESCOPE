import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gravityMatrix, netFlows } from '../src/engine/flows.ts';

test('gravity model allocates each chain’s full outflow to the other chains', () => {
  const chains = [
    { id: 'a', inflow: 100, outflow: 40 },
    { id: 'b', inflow: 50, outflow: 80 },
    { id: 'c', inflow: 10, outflow: 40 },
  ];
  const m = gravityMatrix(chains);
  for (const c of chains) {
    const sent = [...m.get(c.id)!.values()].reduce((s, v) => s + v, 0);
    assert.ok(Math.abs(sent - c.outflow) < 1e-9);
    assert.equal(m.get(c.id)!.has(c.id), false);
  }
  const flows = netFlows(m);
  assert.ok(flows.every((f) => f.usd > 0));
  // b is a big net exporter and a the big receiver, so b -> a should be the strongest route.
  assert.deepEqual([flows[0].from, flows[0].to], ['b', 'a']);
});

import { pairMatrix } from '../src/engine/flows.ts';

test('observed routes use only the latest N buckets and known chains', () => {
  const H = 3_600_000;
  const ids = new Map([[2, 'ethereum'], [30, 'base'], [1, 'solana']]);
  const buckets = [
    { from: 3 * H, src: 2, dst: 30, usd: 100, count: 1 },
    { from: 3 * H, src: 30, dst: 2, usd: 40, count: 1 },
    { from: 2 * H, src: 2, dst: 30, usd: 50, count: 1 },
    { from: 1 * H, src: 2, dst: 30, usd: 1_000, count: 1 }, // too old for n=2
    { from: 3 * H, src: 2, dst: 999, usd: 7, count: 1 }, // unknown chain
  ];
  const m = pairMatrix(buckets, 2, (x) => ids.get(x));
  assert.equal(m.get('ethereum')!.get('base'), 150);
  assert.equal(m.get('base')!.get('ethereum'), 40);
  const flows = netFlows(m);
  assert.deepEqual(flows, [{ from: 'ethereum', to: 'base', usd: 110 }]);
});
