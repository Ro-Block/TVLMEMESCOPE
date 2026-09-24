import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pair } from '../../shared/types.ts';
import { DEFAULT_ALERT_SETTINGS } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { AlertEngine } from '../src/engine/alerts.ts';
import { Ledger } from '../src/engine/ledger.ts';

const DAY = 86_400_000;

function setup() {
  const db = openDb(':memory:');
  const st = { ...DEFAULT_ALERT_SETTINGS, chains: ['base'], clusterSize: 2 };
  const ledger = new Ledger(db, 60, () => st);
  const alerts = new AlertEngine(db, ledger, () => st);
  alerts.deliver = false;
  return { db, ledger, alerts, st };
}

let n = 0;
/** Gives a wallet a 60d history of `wins` 5x round-trips across distinct tokens. */
function history(ledger: Ledger, wallet: string, wins: number) {
  const now = Date.now();
  const trades = [];
  for (let i = 0; i < wins; i++) {
    const token = `0xtok${wallet}${i}`;
    const ts = now - (i + 2) * DAY;
    trades.push({ tx: `h${n++}`, chain: 'base', pool: `0xpool${wallet}${i}`, wallet, token, kind: 'buy' as const, qty: 1000, usd: 2_000, ts });
    trades.push({ tx: `h${n++}`, chain: 'base', pool: `0xpool${wallet}${i}`, wallet, token, kind: 'sell' as const, qty: 1000, usd: 10_000, ts: ts + 6 * 3_600_000 });
  }
  ledger.insertTrades(trades);
}

const pair = (createdAt: number): Pair => ({
  id: 'base:0xnew', chain: 'base', address: '0xnew', dex: 'uni', name: 'NEW / WETH', baseSymbol: 'NEW', baseAddress: '0xnewtok', quoteSymbol: 'WETH',
  createdAt, priceUsd: 0.001, mcap: 1e6, liquidity: 1e5, volume: { m5: 0, h1: 0, h24: 0 }, txns: { h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
  change: { m5: 0, h1: 0, h24: 0 }, trending: false, smartWallets: [], url: '',
});

test('a proven wallet buying a fresh pair raises a whale alert, a newcomer does not', () => {
  const { ledger, alerts } = setup();
  history(ledger, '0xaaa', 12);
  const now = Date.now();
  const p = pair(now - 20 * 60_000);
  const fresh = ledger.insertTrades([
    { tx: 'x1', chain: 'base', pool: '0xnew', wallet: '0xAAA', token: '0xnewtok', kind: 'buy', qty: 1e6, usd: 5_000, ts: now },
    { tx: 'x2', chain: 'base', pool: '0xnew', wallet: '0xbbb', token: '0xnewtok', kind: 'buy', qty: 1e6, usd: 50_000, ts: now },
  ]);
  const out = alerts.onTrades(p, fresh, now);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'whale_buy');
  assert.equal(out[0].wallets[0].wallet, '0xaaa'); // EVM addresses are normalised
  // Same wallet, same pair: deduplicated.
  assert.equal(alerts.onTrades(p, fresh, now + 1000).length, 0);
});

test('old pairs and small buys are ignored; clusters fire once enough smart wallets pile in', () => {
  const { ledger, alerts } = setup();
  history(ledger, '0xa1', 10);
  history(ledger, '0xa2', 10);
  const now = Date.now();
  const buy = (tx: string, wallet: string, usd: number) => ({ tx, chain: 'base', pool: '0xnew', wallet, token: '0xnewtok', kind: 'buy' as const, qty: 1, usd, ts: now });

  assert.equal(alerts.onTrades(pair(now - 3 * DAY), ledger.insertTrades([buy('o1', '0xa1', 5_000)]), now).length, 0);
  assert.equal(alerts.onTrades(pair(now - 60_000), ledger.insertTrades([buy('s1', '0xa2', 50)]), now).length, 0);

  const out = alerts.onTrades(pair(now - 60_000), ledger.insertTrades([buy('c2', '0xa2', 3_000)]), now);
  assert.ok(out.some((a) => a.kind === 'cluster' && a.wallets.length === 2));
});
