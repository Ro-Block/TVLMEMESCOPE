import type { Position, TraderStats, TraderTier } from '../../../shared/types.ts';

// Pure ROI / legitimacy maths, kept free of I/O so it can be unit-tested.

export interface LedgerTrade {
  wallet: string;
  chain: string;
  pool: string;
  token: string;
  kind: 'buy' | 'sell';
  qty: number;
  usd: number;
  ts: number;
}

interface PositionCalc extends Position {
  openCost: number;
  firstSell: number | null;
}

/**
 * Average-cost position accounting for one wallet. Trades must be sorted by time.
 * Sells of tokens bought before we started tracking have no known cost basis and are ignored.
 */
export function buildPositions(trades: LedgerTrade[], symbols: Map<string, string> = new Map()): PositionCalc[] {
  const byToken = new Map<string, PositionCalc>();
  for (const t of trades) {
    let p = byToken.get(t.token);
    if (!p) {
      if (t.kind === 'sell') continue;
      p = {
        token: t.token,
        symbol: symbols.get(t.token) ?? '?',
        pool: t.pool,
        investedUsd: 0,
        realizedUsd: 0,
        unrealizedUsd: 0,
        openQty: 0,
        openCost: 0,
        firstBuy: t.ts,
        firstSell: null,
        lastTrade: t.ts,
        trades: 0,
      };
      byToken.set(t.token, p);
    }
    p.trades++;
    p.lastTrade = t.ts;
    if (t.kind === 'buy') {
      p.investedUsd += t.usd;
      p.openQty += t.qty;
      p.openCost += t.usd;
    } else if (p.openQty > 0 && t.qty > 0) {
      const sold = Math.min(t.qty, p.openQty);
      const basis = p.openCost * (sold / p.openQty);
      const proceeds = t.usd * (sold / t.qty);
      p.realizedUsd += proceeds - basis;
      p.openCost -= basis;
      p.openQty -= sold;
      if (p.openQty < 1e-12) {
        p.openQty = 0;
        p.openCost = 0;
      }
      p.firstSell ??= t.ts;
    }
  }
  return [...byToken.values()];
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export type CoreStats = Omit<TraderStats, 'tier' | 'watched' | 'source' | 'label' | 'legitScore' | 'flags'>;

export function walletStats(
  wallet: string,
  chain: string,
  trades: LedgerTrade[],
  priceOf: (token: string) => number | undefined,
  symbols?: Map<string, string>,
): { stats: CoreStats; positions: Position[] } {
  const pos = buildPositions(trades, symbols);
  // Last traded price is the fallback mark when we have no fresher pool price.
  const lastPx = new Map<string, number>();
  for (const t of trades) if (t.qty > 0) lastPx.set(t.token, t.usd / t.qty);
  for (const p of pos) {
    const px = priceOf(p.token) ?? lastPx.get(p.token) ?? 0;
    p.unrealizedUsd = p.openQty * px - p.openCost;
  }
  const invested = pos.reduce((s, p) => s + p.investedUsd, 0);
  const realized = pos.reduce((s, p) => s + p.realizedUsd, 0);
  const unrealized = pos.reduce((s, p) => s + p.unrealizedUsd, 0);
  const wins = pos.filter((p) => p.realizedUsd + p.unrealizedUsd > 0).length;
  const holds = pos.filter((p) => p.firstSell !== null).map((p) => (p.firstSell! - p.firstBuy) / 60_000);
  return {
    stats: {
      wallet,
      chain,
      roi: invested > 0 ? (realized + unrealized) / invested : 0,
      pnlUsd: realized + unrealized,
      realizedUsd: realized,
      unrealizedUsd: unrealized,
      investedUsd: invested,
      trades: pos.reduce((s, p) => s + p.trades, 0),
      tokens: pos.length,
      wins,
      winRate: pos.length ? wins / pos.length : 0,
      medianHoldMin: median(holds),
      lastActive: trades.at(-1)?.ts ?? 0,
    },
    positions: pos
      .map(({ openCost: _c, firstSell: _f, ...p }) => p)
      .sort((a, b) => b.lastTrade - a.lastTrade),
  };
}

const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, x));

/**
 * 0-100 score for "is this a real, repeatable trader rather than a lucky punt, a bot or a sniper".
 * Weights: sample size 25, win rate 25, ROI 25, size 15, consistency 10; bots and thin samples penalised.
 */
export function legitScore(s: CoreStats, topPositionPnl = 0): { score: number; flags: string[] } {
  const flags: string[] = [];
  const perToken = s.tokens ? s.trades / s.tokens : 0;
  const botLike = perToken > 25 || (s.medianHoldMin !== null && s.medianHoldMin < 1 && s.tokens >= 3);
  const oneHit = s.pnlUsd > 0 && s.tokens >= 2 && topPositionPnl > 0.8 * s.pnlUsd;
  if (s.tokens < 5) flags.push('low-sample');
  if (botLike) flags.push('bot-like');
  if (oneHit) flags.push('one-hit');
  if (s.investedUsd < 2_000) flags.push('small-size');

  let score =
    clamp(s.tokens / 15) * 25 +
    s.winRate * 25 +
    clamp(Math.log2(1 + Math.max(s.roi, 0)) / Math.log2(11)) * 25 +
    clamp(Math.log10(Math.max(s.investedUsd, 1) / 1_000) / 2) * 15 +
    (oneHit ? 0 : 10);
  if (botLike) score -= 40;
  if (s.tokens < 5) score -= 15;
  if (s.roi <= 0) score *= 0.5;
  return { score: Math.round(clamp(score, 0, 100)), flags };
}

export function tierFor(s: { legitScore: number; investedUsd: number; tokens: number }, minLegit: number): TraderTier {
  if (s.legitScore < minLegit) return 'none';
  return s.investedUsd / Math.max(s.tokens, 1) >= 5_000 ? 'whale' : 'smart';
}
