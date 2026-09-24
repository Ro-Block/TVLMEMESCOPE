import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_ALERT_SETTINGS } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import { Ledger } from '../src/engine/ledger.ts';
import { PairTracker, shouldPromote } from '../src/feeds/tracker.ts';
import type { DsPairStats } from '../src/sources/dexscreener.ts';
import { CreditBudget, tradesFromParsed, WSOL, type ParsedTx } from '../src/sources/helius.ts';
import { parseNewToken } from '../src/sources/pumpportal.ts';

const MINT = 'Gm8kPump1111111111111111111111111111111pump';
const USER = 'Wa11et111111111111111111111111111111111111';

test('PumpPortal create messages become launches; other messages are ignored', () => {
  const t = parseNewToken(
    JSON.stringify({ signature: 'sig1', mint: MINT, traderPublicKey: 'Dev1', txType: 'create', initialBuy: 35_000_000, solAmount: 1, bondingCurveKey: 'Curve1', vTokensInBondingCurve: 1e9, vSolInBondingCurve: 31, marketCapSol: 29.5, name: 'Frog', symbol: 'FROG', uri: 'https://ipfs.io/ipfs/abc', pool: 'pump' }),
    1_000,
  );
  assert.deepEqual(t, { signature: 'sig1', mint: MINT, creator: 'Dev1', initialBuy: 35_000_000, solAmount: 1, marketCapSol: 29.5, bondingCurve: 'Curve1', name: 'Frog', symbol: 'FROG', uri: 'https://ipfs.io/ipfs/abc', pool: 'pump', receivedAt: 1_000 });
  assert.equal(parseNewToken(JSON.stringify({ message: 'Successfully subscribed to token creation events.' })), null);
  assert.equal(parseNewToken('not json'), null);
});

const tx = (over: Partial<ParsedTx>): ParsedTx => ({ signature: 's', timestamp: 1_700_000_000, slot: 123, fee: 5_000, feePayer: USER, ...over });

test('Helius parsed swap: tokens in + SOL out is a buy, priced in USD, fee excluded', () => {
  const [t] = tradesFromParsed(
    tx({
      accountData: [
        { account: USER, nativeBalanceChange: -2_000_005_000, tokenBalanceChanges: [] }, // 2 SOL + fee
        { account: 'ata', nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: USER, mint: MINT, rawTokenAmount: { tokenAmount: '5000000000000', decimals: 6 } }] },
      ],
    }),
    new Set([MINT]),
    150,
  );
  assert.equal(t.kind, 'buy');
  assert.equal(t.qty, 5_000_000);
  assert.ok(Math.abs(t.usd - 300) < 1e-6, `2 SOL × $150, got ${t.usd}`);
  assert.equal(t.block, 123);
  assert.equal(t.ts, 1_700_000_000_000);
});

test('Helius parsed swap: tokens out + WSOL in is a sell; transfers and failed txs are not trades', () => {
  const [sell] = tradesFromParsed(
    tx({ accountData: [{ account: USER, nativeBalanceChange: -5_000, tokenBalanceChanges: [{ userAccount: USER, mint: MINT, rawTokenAmount: { tokenAmount: '-1000000', decimals: 6 } }, { userAccount: USER, mint: WSOL, rawTokenAmount: { tokenAmount: '500000000', decimals: 9 } }] }] }),
    new Set([MINT]),
    100,
  );
  assert.equal(sell.kind, 'sell');
  assert.ok(Math.abs(sell.usd - 50) < 1e-6);
  // Received tokens without paying anything: an airdrop/transfer, not a buy.
  assert.equal(tradesFromParsed(tx({ accountData: [{ account: USER, nativeBalanceChange: -5_000, tokenBalanceChanges: [{ userAccount: USER, mint: MINT, rawTokenAmount: { tokenAmount: '1000000', decimals: 6 } }] }] }), new Set([MINT]), 100).length, 0);
  assert.equal(tradesFromParsed(tx({ transactionError: { InstructionError: [0, 'Custom'] } }), new Set([MINT]), 100).length, 0);
});

test('Helius parsed swap falls back to token transfers when balance changes are missing', () => {
  const [t] = tradesFromParsed(tx({ tokenTransfers: [{ fromUserAccount: USER, toUserAccount: 'pool', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', tokenAmount: 250 }, { fromUserAccount: 'pool', toUserAccount: USER, mint: MINT, tokenAmount: 1_000 }], accountData: [{ account: USER, nativeBalanceChange: -5_000 }] }), new Set([MINT]), 100);
  assert.equal(t.kind, 'buy');
  assert.equal(t.usd, 250);
});

test('credit budget spreads the day and refuses spends over the allowance', () => {
  const b = new CreditBudget(24_000); // 1,000 per hour
  // At least one hour of headroom is always available.
  assert.ok(b.available() >= 1_000);
  let spent = 0;
  while (b.trySpend(100)) spent += 100;
  assert.ok(spent <= 24_000 && spent >= 1_000);
  assert.equal(b.trySpend(100), false);
});

const stats = (over: Partial<DsPairStats>): DsPairStats => ({
  chainId: 'solana', dexId: 'pumpfun', url: 'https://dexscreener.com/solana/x', pairAddress: 'curve', baseToken: { address: MINT, name: 'Frog', symbol: 'FROG' }, quoteToken: { address: WSOL, symbol: 'SOL' },
  priceUsd: 0.0001, marketCap: 80_000, liquidityUsd: 0, volume: { m5: 0, h1: 0, h6: 0, h24: 0 }, txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } },
  change: { m5: 0, h1: 0, h24: 0 }, pairCreatedAt: 5, ...over,
});

test('only tokens with real activity are promoted', () => {
  assert.equal(shouldPromote(undefined), false);
  assert.equal(shouldPromote(stats({})), false);
  assert.equal(shouldPromote(stats({ txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 20, sells: 10 }, h24: { buys: 20, sells: 10 } } })), true);
  assert.equal(shouldPromote(stats({ liquidityUsd: 9_000 })), true);
});

test('a watched wallet buying a candidate promotes it and replays the buffered opening trades', async () => {
  const ledger = new Ledger(openDb(':memory:'), 60, () => DEFAULT_ALERT_SETTINGS);
  const delivered: number[] = [];
  const tracker = new PairTracker(ledger, (_p, fresh) => delivered.push(fresh.length), (_c, w) => w === 'whale');
  tracker.add({ chain: 'solana', token: MINT, pool: MINT, createdAt: 1_000, dex: 'pumpfun', quoteSymbol: 'SOL', symbol: 'FROG' });
  const trade = (tx: string, wallet: string, ts: number) => ({ tx, chain: 'solana', pool: MINT, wallet, token: MINT, kind: 'buy' as const, qty: 1, usd: 100, ts });
  tracker.record('solana', MINT, [trade('a', 'dev', 1_000), trade('b', 'sniper', 1_800)]);
  assert.equal(ledger.pools().length, 0, 'not shown before promotion');
  tracker.record('solana', MINT, [trade('c', 'whale', 5_000)]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ledger.pools().length, 1);
  assert.equal(ledger.counts().trades, 3, 'opening trades replayed into the ledger');
  assert.deepEqual(delivered, [3]);
  tracker.record('solana', MINT, [trade('d', 'late', 9_000)]);
  assert.equal(ledger.counts().trades, 4);
});
