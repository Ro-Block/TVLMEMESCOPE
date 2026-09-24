import { HELIUS } from '../config.ts';
import { num, RateLimiter, sourceHealth } from '../http.ts';

// Helius (Solana). Free plan: 1M credits/month, 10 requests/s. Costs used for budgeting:
// getSignaturesForAddress = 10 credits, Enhanced Transactions parse = 100 credits per call (≤100 txs).
export const COST = { signatures: 10, parse: 100 };
const limiter = new RateLimiter(300); // 5 req/s, half the free limit

export const heliusEnabled = () => Boolean(HELIUS.apiKey);

/** Spreads the daily allowance over the day so a busy hour can't burn it all. */
export class CreditBudget {
  spentToday = 0;
  spentTotal = 0;
  private day = this.today();
  constructor(public dailyCap: number) {}
  private today() {
    return Math.floor(Date.now() / 86_400_000);
  }
  /** Credits that may be spent right now. */
  available(now = Date.now()) {
    if (this.today() !== this.day) {
      this.day = this.today();
      this.spentToday = 0;
    }
    const dayFrac = (now % 86_400_000) / 86_400_000;
    // Allowance grows through the day, with one hour's worth of headroom.
    const allowance = this.dailyCap * Math.min(1, dayFrac + 1 / 24);
    return Math.max(0, allowance - this.spentToday);
  }
  trySpend(n: number) {
    if (this.available() < n) return false;
    this.spentToday += n;
    this.spentTotal += n;
    return true;
  }
}
export const budget = new CreditBudget(HELIUS.dailyCredits);

const rpcUrl = () => `https://mainnet.helius-rpc.com/?api-key=${HELIUS.apiKey}`;
const apiUrl = () => `https://api-mainnet.helius-rpc.com/v0/transactions/?api-key=${HELIUS.apiKey}`;

async function post<T>(url: string, body: unknown): Promise<T> {
  await limiter.take();
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const j = (await res.json()) as T;
    sourceHealth.helius = { ok: true, lastOk: Date.now() };
    return j;
  } catch (e) {
    // Never echo the URL: it contains the API key.
    sourceHealth.helius = { ...sourceHealth.helius, ok: false, lastError: (e as Error).message };
    throw new Error(`helius: ${(e as Error).message}`);
  }
}

export interface SigInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
}

/** Newest-first signatures touching an address (10 credits). Returns null when over budget. */
export async function signatures(address: string, opts: { limit?: number; before?: string; until?: string } = {}): Promise<SigInfo[] | null> {
  if (!budget.trySpend(COST.signatures)) return null;
  const res = await post<{ result?: SigInfo[]; error?: { message: string } }>(rpcUrl(), {
    jsonrpc: '2.0',
    id: 1,
    method: 'getSignaturesForAddress',
    params: [address, { limit: opts.limit ?? 100, before: opts.before, until: opts.until, commitment: 'confirmed' }],
  });
  if (res.error) throw new Error(`helius: ${res.error.message}`);
  return (res.result ?? []).filter((s) => !s.err);
}

/** Parses up to 100 transactions in one call (100 credits). Returns null when over budget. */
export async function parse(sigs: string[]): Promise<ParsedTx[] | null> {
  if (!sigs.length) return [];
  if (!budget.trySpend(COST.parse)) return null;
  return post<ParsedTx[]>(apiUrl(), { transactions: sigs.slice(0, 100) });
}

// ---------- turning parsed transactions into trades ----------

export interface ParsedTx {
  signature: string;
  timestamp: number; // seconds
  slot: number;
  fee?: number; // lamports
  feePayer: string;
  transactionError?: unknown;
  tokenTransfers?: { fromUserAccount?: string; toUserAccount?: string; mint: string; tokenAmount: number }[];
  accountData?: {
    account: string;
    nativeBalanceChange?: number;
    tokenBalanceChanges?: { userAccount: string; mint: string; rawTokenAmount: { tokenAmount: string; decimals: number } }[];
  }[];
}

export const WSOL = 'So11111111111111111111111111111111111111112';
const STABLES = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

export interface SolTrade {
  tx: string;
  wallet: string;
  mint: string;
  kind: 'buy' | 'sell';
  qty: number;
  usd: number;
  ts: number;
  block: number;
}

/**
 * The signer's own balance changes decide the trade: tokens in and SOL/stables out is a buy, the
 * reverse a sell. Uses accountData balance changes, falling back to token transfers.
 */
export function tradesFromParsed(tx: ParsedTx, mints: Set<string>, solUsd: number): SolTrade[] {
  if (tx.transactionError || !tx.feePayer) return [];
  const wallet = tx.feePayer;
  const delta = new Map<string, number>();
  const add = (mint: string, v: number) => delta.set(mint, (delta.get(mint) ?? 0) + v);
  let sawBalances = false;
  let lamports = 0;
  for (const a of tx.accountData ?? []) {
    if (a.account === wallet) lamports += num(a.nativeBalanceChange);
    for (const c of a.tokenBalanceChanges ?? []) {
      if (c.userAccount !== wallet) continue;
      sawBalances = true;
      add(c.mint, num(c.rawTokenAmount?.tokenAmount) / 10 ** num(c.rawTokenAmount?.decimals));
    }
  }
  if (!sawBalances) {
    for (const t of tx.tokenTransfers ?? []) {
      if (t.toUserAccount === wallet) add(t.mint, num(t.tokenAmount));
      if (t.fromUserAccount === wallet) add(t.mint, -num(t.tokenAmount));
    }
  }
  // The network fee isn't part of the trade.
  const sol = (lamports + num(tx.fee)) / 1e9 + (delta.get(WSOL) ?? 0);
  const stable = [...STABLES].reduce((s, m) => s + (delta.get(m) ?? 0), 0);
  const quoteUsd = sol * solUsd + stable; // negative = spent

  const out: SolTrade[] = [];
  for (const mint of mints) {
    const qty = delta.get(mint) ?? 0;
    if (!qty) continue;
    const kind = qty > 0 ? 'buy' : 'sell';
    // A buy must spend quote and a sell must receive it; anything else is a transfer, not a trade.
    if ((kind === 'buy' && quoteUsd >= 0) || (kind === 'sell' && quoteUsd <= 0)) continue;
    const usd = Math.abs(quoteUsd);
    if (usd < 1) continue;
    out.push({ tx: tx.signature, wallet, mint, kind, qty: Math.abs(qty), usd, ts: tx.timestamp * 1000, block: tx.slot });
  }
  return out;
}

