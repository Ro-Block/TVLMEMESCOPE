import assert from 'node:assert/strict';
import { test } from 'node:test';

// Exercises the live code path against the documented response formats of DefiLlama and
// Wormholescan, with fetch stubbed (the sources can't be reached from CI).
process.env.DATA_MODE = 'live';
const NOW = Date.now();
const sec = (ms: number) => Math.floor(ms / 1000);
const H = 3_600_000;
const D = 24 * H;
const hourStart = Math.floor(NOW / H) * H;
const dayStart = Math.floor(NOW / D) * D;
const SCALE = 1e8; // Wormholescan tops volume units in this fixture

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: string | URL) => {
  const url = String(input);
  if (url.includes('/v2/chains')) return json([{ name: 'Ethereum', tvl: 60e9 }, { name: 'Base', tvl: 5e9 }, { name: 'Solana', tvl: 10e9 }]);
  if (url.includes('/v2/historicalChainTvl/')) return json([{ date: sec(NOW - 8 * D), tvl: 50e9 }, { date: sec(NOW), tvl: 60e9 }]);
  if (url.includes('/tvl/lighter')) return json(1.2e9);
  if (url.includes('/stablecoinchains')) return json([{ name: 'Ethereum', totalCirculatingUSD: { peggedUSD: 150e9 } }, { name: 'Base', totalCirculatingUSD: { peggedUSD: 4e9 } }, { name: 'Solana', totalCirculatingUSD: { peggedUSD: 11e9 } }]);
  if (url.includes('/stablecoincharts/Base')) return json([{ date: String(sec(NOW - 2 * D)), totalCirculatingUSD: { peggedUSD: 3.7e9 } }, { date: String(sec(NOW - D - 60_000)), totalCirculatingUSD: { peggedUSD: 3.9e9 } }]);
  if (url.includes('/stablecoincharts/')) return json([{ date: String(sec(NOW - 2 * D)), totalCirculatingUSD: { peggedUSD: 1e9 } }]);
  if (url.includes('/overview/dexs/Base')) return json({ total24h: 900e6, totalDataChart: [[sec(NOW - 2 * D), 800e6], [sec(NOW - D), 850e6], [sec(NOW), 900e6]] });
  if (url.includes('/overview/dexs/')) return json({ total24h: 0, totalDataChart: [] });
  if (url.includes('/x-chain-activity/tops') && url.includes('timespan=1h')) {
    return json([
      { from: new Date(hourStart).toISOString(), emitter_chain: '2', destination_chain: '30', volume: 12e6 * SCALE, count: 40 }, // Ethereum → Base $12M
      { from: new Date(hourStart).toISOString(), emitter_chain: '30', destination_chain: '2', volume: 2e6 * SCALE, count: 10 },
      { from: new Date(hourStart - H).toISOString(), emitter_chain: '1', destination_chain: '2', volume: 5e6 * SCALE, count: 9 }, // older hour
    ]);
  }
  if (url.includes('/x-chain-activity/tops')) {
    return json([
      { from: new Date(dayStart).toISOString(), emitter_chain: '1', destination_chain: '30', volume: 30e6 * SCALE, count: 100 },
      { from: new Date(dayStart - D).toISOString(), emitter_chain: '2', destination_chain: '30', volume: 70e6 * SCALE, count: 200 },
    ]);
  }
  if (url.includes('/x-chain-activity')) return json({ txs: [{ chain: 1, volume: '30000000' }, { chain: 2, volume: '70000000' }] });
  return new Response('blocked', { status: 403 });
}) as typeof fetch;

const { getFlows, warmFlows } = await import('../src/engine/flows.ts');
// Same as the server does right after it starts listening.
await warmFlows();

test('live 1h window: observed Wormhole routes, units calibrated to USD', async () => {
  const f = await getFlows('1h');
  assert.equal(f.source, 'live');
  assert.equal(f.routing, 'observed');
  const eb = f.flows.find((x) => x.from === 'ethereum' && x.to === 'base');
  assert.ok(eb && Math.abs(eb.usd - 10e6) < 1, `net Ethereum→Base should be $10M, got ${eb?.usd}`);
  assert.equal(f.flows.some((x) => x.from === 'solana'), false, 'the older hour is outside a 1h window');
  const base = f.chains.find((c) => c.id === 'base')!;
  assert.equal(base.inflow, 12e6);
  assert.equal(base.outflow, 2e6);
  assert.equal(base.net, 10e6); // live windows: bridged in − out
  assert.equal(base.tvl, 5e9);
  assert.equal(f.chains.find((c) => c.id === 'lighter')!.tvl, 1.2e9); // protocol TVL fallback
});

test('live 1d window: net liquidity = stablecoin supply change, DEX volume from DefiLlama', async () => {
  const f = await getFlows('1d');
  const base = f.chains.find((c) => c.id === 'base')!;
  assert.equal(base.stablecoins, 4e9);
  assert.ok(Math.abs((base.stableChange ?? 0) - 0.1e9) < 1, `4.0B now − 3.9B a day ago, got ${base.stableChange}`);
  assert.equal(base.net, base.stableChange);
  assert.equal(base.dexVolume, 900e6);
  const eth = f.chains.find((c) => c.id === 'ethereum')!;
  assert.ok(Math.abs(eth.tvlChange7d! - (60 / 50 - 1)) < 1e-9);
});

test('live 3d window sums daily route buckets', async () => {
  const f = await getFlows('3d');
  const base = f.chains.find((c) => c.id === 'base')!;
  assert.equal(base.inflow, 100e6); // $30M today + $70M yesterday
  assert.equal(base.dexVolume, 800e6 + 850e6 + 900e6);
});
