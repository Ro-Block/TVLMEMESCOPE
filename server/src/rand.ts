/** Deterministic PRNG helpers used by the demo simulators. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export type Rng = () => number;
export const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
export const gauss = (rng: Rng) => Math.sqrt(-2 * Math.log(rng() || 1e-9)) * Math.cos(2 * Math.PI * rng());

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function fakeAddress(rng: Rng, chain: string): string {
  if (chain === 'solana') return Array.from({ length: 44 }, () => pick(rng, [...B58])).join('');
  return '0x' + Array.from({ length: 40 }, () => Math.floor(rng() * 16).toString(16)).join('');
}
