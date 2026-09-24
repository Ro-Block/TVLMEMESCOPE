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
