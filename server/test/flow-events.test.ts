import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectSpikes, type RouteHour } from '../src/engine/flow-events.ts';

const H = 3_600_000;
const t = { superCometUsd: 10e6, supernovaUsd: 50e6, supernovaSpike: 3, superCometMinUsd: 1e6, supernovaMinUsd: 2e6 };

function day(last: Partial<Record<string, number>>): RouteHour[] {
  const rows: RouteHour[] = [];
  for (let i = 0; i < 24; i++) {
    rows.push({ from: i * H, src: 'ethereum', dst: 'base', usd: 400_000 });
    rows.push({ from: i * H, src: 'base', dst: 'solana', usd: 300_000 });
  }
  for (const [k, v] of Object.entries(last)) {
    const [src, dst] = k.split('>');
    rows.push({ from: 24 * H, src, dst, usd: v! });
  }
  return rows;
}

test('a route far above its usual hour is a super comet', () => {
  const s = detectSpikes(day({ 'ethereum>base': 2_400_000, 'base>solana': 300_000 }), t, 1);
  const c = s.filter((x) => x.kind === 'super-comet');
  assert.equal(c.length, 1);
  assert.equal(c[0].chain, 'ethereum');
  assert.equal(c[0].to, 'base');
  assert.equal(c[0].ratio, 6);
});

test('a normal hour fires nothing', () => {
  assert.deepEqual(detectSpikes(day({ 'ethereum>base': 450_000, 'base>solana': 320_000 }), t, 1), []);
});

test('a big spike below the minimum does not fire', () => {
  assert.deepEqual(detectSpikes(day({ 'ethereum>base': 900_000 }), t, 1).filter((x) => x.kind === 'super-comet'), []);
});

test('a chain bleeding far more than usual is a supernova', () => {
  const s = detectSpikes(day({ 'ethereum>base': 400_000, 'base>solana': 3_500_000 }), t, 1);
  const n = s.filter((x) => x.kind === 'supernova');
  assert.equal(n.length, 1);
  assert.equal(n[0].chain, 'base');
  assert.equal(n[0].usd, 3_100_000);
});

test('absolute thresholds fire regardless of history', () => {
  const rows = day({});
  for (let i = 0; i < 24; i++) rows.push({ from: i * H, src: 'arbitrum', dst: 'base', usd: 8e6 });
  rows.push({ from: 24 * H, src: 'arbitrum', dst: 'base', usd: 12e6 });
  assert.ok(detectSpikes(rows, t, 1).some((x) => x.kind === 'super-comet' && x.chain === 'arbitrum'));
});
