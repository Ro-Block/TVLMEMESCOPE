export function usd(n: number, digits = 1): string {
  const a = Math.abs(n);
  const s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(digits)}K`;
  if (a === 0) return '$0';
  return `${s}$${a.toFixed(a < 10 ? 2 : 0)}`;
}

export const signedUsd = (n: number, digits = 1) => (n > 0 ? '+' : '') + usd(n, digits);

export function pct(f: number | null | undefined, digits = 1): string {
  if (f === null || f === undefined || !Number.isFinite(f)) return '—';
  return `${f > 0 ? '+' : ''}${(f * 100).toFixed(digits)}%`;
}

export function price(n: number): string {
  if (!n) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  const zeros = Math.max(0, -Math.floor(Math.log10(n)) - 1);
  return zeros >= 4 ? `$0.0${subscript(zeros)}${(n * 10 ** (zeros + 1)).toFixed(3).replace('.', '').slice(0, 4)}` : `$${n.toPrecision(4)}`;
}

const SUB = '₀₁₂₃₄₅₆₇₈₉';
const subscript = (n: number) => String(n).split('').map((d) => SUB[+d]).join('');

export function age(ms: number): string {
  const m = Math.max(0, ms) / 60_000;
  if (m < 1) return `${Math.round(m * 60)}s`;
  if (m < 60) return `${Math.floor(m)}m`;
  if (m < 60 * 24) return `${Math.floor(m / 60)}h ${Math.floor(m % 60)}m`;
  return `${Math.floor(m / 1440)}d`;
}

export const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 5)}…${a.slice(-4)}` : a);

export function timeAgo(ts: number): string {
  return `${age(Date.now() - ts)} ago`;
}

export function date(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
