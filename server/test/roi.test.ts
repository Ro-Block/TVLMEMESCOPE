import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPositions, legitScore, walletStats, type LedgerTrade } from '../src/engine/roi.ts';

const t = (kind: 'buy' | 'sell', token: string, qty: number, usd: number, ts: number): LedgerTrade => ({ wallet: 'w', chain: 'base', pool: 'p', token, kind, qty, usd, ts });

test('average-cost accounting realises PnL on partial sells', () => {
  const [p] = buildPositions([t('buy', 'A', 100, 100, 1), t('buy', 'A', 100, 300, 2), t('sell', 'A', 100, 400, 3)]);
  // cost basis 400 for 200 tokens -> selling half releases 200 of basis
  assert.equal(p.realizedUsd, 200);
  assert.equal(p.openQty, 100);
  assert.equal(p.investedUsd, 400);
});

test('sells with no tracked buy are ignored', () => {
  assert.equal(buildPositions([t('sell', 'A', 10, 50, 1)]).length, 0);
});

test('open positions are marked to the current price', () => {
  const { stats } = walletStats('w', 'base', [t('buy', 'A', 100, 100, 1), t('buy', 'B', 10, 100, 2), t('sell', 'B', 10, 50, 3)], (tok) => (tok === 'A' ? 3 : undefined));
  assert.equal(stats.unrealizedUsd, 200); // 100 * $3 - $100 cost
  assert.equal(stats.realizedUsd, -50);
  assert.equal(stats.roi, 150 / 200);
  assert.equal(stats.wins, 1);
  assert.equal(stats.tokens, 2);
});

test('legit score rewards repeatable traders and flags bots', () => {
  const good = legitScore({ wallet: 'w', chain: 'base', roi: 2.5, pnlUsd: 50_000, realizedUsd: 50_000, unrealizedUsd: 0, investedUsd: 20_000, trades: 40, tokens: 15, wins: 11, winRate: 11 / 15, medianHoldMin: 240, lastActive: 0 }, 10_000);
  const bot = legitScore({ wallet: 'b', chain: 'base', roi: 0.05, pnlUsd: 500, realizedUsd: 500, unrealizedUsd: 0, investedUsd: 10_000, trades: 600, tokens: 12, wins: 6, winRate: 0.5, medianHoldMin: 0.3, lastActive: 0 }, 100);
  const lucky = legitScore({ wallet: 'l', chain: 'base', roi: 9, pnlUsd: 90_000, realizedUsd: 90_000, unrealizedUsd: 0, investedUsd: 10_000, trades: 6, tokens: 3, wins: 1, winRate: 1 / 3, medianHoldMin: 600, lastActive: 0 }, 95_000);
  assert.ok(good.score >= 75, `good=${good.score}`);
  assert.ok(bot.flags.includes('bot-like') && bot.score < 30, `bot=${bot.score}`);
  assert.ok(lucky.flags.includes('one-hit') && lucky.flags.includes('low-sample') && lucky.score < good.score);
});
