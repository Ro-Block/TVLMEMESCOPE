/** Small fetch helpers: timeout, JSON, per-host rate limiting, TTL cache and source health. */

export const sourceHealth: Record<string, { ok: boolean; lastError?: string; lastOk?: number }> = {};

export class RateLimiter {
  private queue: (() => void)[] = [];
  private stamps: number[] = [];
  constructor(private perMinute: number) {}

  async take(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.pump();
    });
  }

  private pump() {
    const now = Date.now();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    while (this.queue.length && this.stamps.length < this.perMinute) {
      this.stamps.push(Date.now());
      this.queue.shift()!();
    }
    if (this.queue.length) {
      const wait = 60_000 - (now - this.stamps[0]) + 5;
      setTimeout(() => this.pump(), Math.max(wait, 50));
    }
  }
}

export async function getJson<T>(
  source: string,
  url: string,
  opts: { limiter?: RateLimiter; timeoutMs?: number; headers?: Record<string, string>; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.limiter) await opts.limiter.take();
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (res.status === 429 && attempt < retries) {
        await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as T;
      sourceHealth[source] = { ok: true, lastOk: Date.now() };
      return data;
    } catch (err) {
      lastErr = err;
    }
  }
  const msg = lastErr instanceof Error ? `${lastErr.message}${lastErr.cause ? ` (${String((lastErr.cause as Error).message ?? lastErr.cause)})` : ''}` : String(lastErr);
  sourceHealth[source] = { ...sourceHealth[source], ok: false, lastError: msg };
  throw new Error(`${source}: ${msg}`);
}

export async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
}

export function cached<T>(ttlMs: number, fn: (key: string) => Promise<T>) {
  const store = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string): Promise<T> => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = fn(key);
    store.set(key, { at: Date.now(), value });
    value.catch(() => store.delete(key));
    return value;
  };
}

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Stale-while-revalidate cache: returns the last good value immediately and refreshes it in the
 * background once it is older than `ttlMs`. With nothing cached yet, waits up to `waitMs` for the
 * first load (then returns null and keeps loading), so slow sources never block a response.
 */
export function swr<T>(ttlMs: number, fn: (key: string) => Promise<T>) {
  const store = new Map<string, { at: number; value?: T; loading?: Promise<T> }>();
  const load = (key: string) => {
    const e = store.get(key) ?? { at: 0 };
    if (e.loading) return e.loading;
    e.loading = fn(key)
      .then((v) => {
        e.value = v;
        e.at = Date.now();
        return v;
      })
      .finally(() => {
        e.loading = undefined;
      });
    store.set(key, e);
    e.loading.catch(() => {});
    return e.loading;
  };
  return async (key: string, waitMs = 0): Promise<T | null> => {
    const e = store.get(key);
    if (e?.value !== undefined) {
      if (Date.now() - e.at > ttlMs) void load(key).catch(() => {});
      return e.value;
    }
    const p = load(key);
    if (waitMs <= 0) return null;
    return Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
  };
}
