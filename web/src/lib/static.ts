import type { Alert, AlertSettings, Pair, Shot, SnipersResponse, StatusResponse, TraderStats, WalletDetail } from '../../../shared/types.ts';

// Snapshot mode: `npm run snapshot` bakes API responses into the page as window.__STATIC__ so the
// UI runs with no server (e.g. as a hosted demo). Requests are answered from that data, and
// recorded sniper shots and alerts are replayed to keep the live views moving.

interface StaticData {
  capturedAt: number;
  responses: Record<string, unknown>;
  wallets: Record<string, WalletDetail>;
}

declare global {
  interface Window {
    __STATIC__?: StaticData;
  }
}

export const isStatic = () => typeof window !== 'undefined' && !!window.__STATIC__;

const TIME_KEYS = new Set(['createdAt', 'ts', 'lastActive', 'lastSeen', 'updatedAt', 't', 'firstBuy', 'lastTrade', 'oldest']);

/** Moves every timestamp forward so ages read as if the snapshot were taken just now. */
function shift(o: unknown, off: number): void {
  if (Array.isArray(o)) return o.forEach((x) => shift(x, off));
  if (!o || typeof o !== 'object') return;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (typeof v === 'number' && TIME_KEYS.has(k) && v > 1e12) (o as Record<string, unknown>)[k] = v + off;
    else if (v && typeof v === 'object') shift(v, off);
  }
}

let ready = false;
function data(): StaticData {
  const d = window.__STATIC__!;
  if (!ready) {
    shift(d.responses, Date.now() - d.capturedAt);
    shift(d.wallets, Date.now() - d.capturedAt);
    ready = true;
  }
  return d;
}

const r = <T>(k: string) => data().responses[k] as T;
const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

function setWatched(chain: string, wallet: string, watched: boolean, label?: string) {
  for (const t of r<TraderStats[]>('traders')) if (t.chain === chain && t.wallet === wallet) t.watched = watched;
  const s = r<SnipersResponse>('snipers');
  for (const p of s.profiles) if (p.chain === chain && p.wallet === wallet) p.watched = watched;
  s.watchlist = s.watchlist.filter((w) => !(w.chain === chain && w.wallet === wallet));
  if (watched) s.watchlist.push({ chain, wallet, label });
}

const alertListeners = new Set<(a: Alert) => void>();
export const onStaticAlert = (fn: (a: Alert) => void) => {
  alertListeners.add(fn);
  return () => alertListeners.delete(fn);
};

export async function staticReq(path: string, init?: RequestInit): Promise<unknown> {
  const url = new URL(path, 'http://x');
  const q = url.searchParams;
  const p = url.pathname;
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const now = Date.now();

  if (p === '/api/status') return r<StatusResponse>('status');
  if (p === '/api/flows') return r(`flows:${q.get('window') ?? '7d'}`);
  if (p.startsWith('/api/chains/')) return r(`chain:${p.split('/')[3]}:${q.get('window') ?? '7d'}`);
  if (p === '/api/pairs') {
    const chains = list(q.get('chains'));
    const since = now - Number(q.get('maxAgeHours') ?? 24) * 3_600_000;
    return r<Pair[]>('pairs').filter((x) => (!chains.length || chains.includes(x.chain)) && x.createdAt >= since);
  }
  if (p === '/api/traders') {
    const chains = list(q.get('chains'));
    const minScore = Number(q.get('minScore') ?? 0);
    const hideBots = q.get('hideBots') !== '0';
    const sort = q.get('sort') ?? 'score';
    const key = (s: TraderStats) => (sort === 'roi' ? s.roi : sort === 'pnl' ? s.pnlUsd : s.legitScore * 1e12 + s.pnlUsd);
    return r<TraderStats[]>('traders')
      .filter((s) => (!chains.length || chains.includes(s.chain)) && (s.legitScore >= minScore || s.watched) && (!hideBots || !s.flags.includes('bot-like')))
      .sort((a, b) => key(b) - key(a));
  }
  if (p.startsWith('/api/wallets/')) {
    const [, , , chain, wallet] = p.split('/');
    return (
      data().wallets[`${chain}:${wallet}`] ?? {
        stats: r<TraderStats[]>('traders').find((t) => t.chain === chain && t.wallet === wallet) ?? null,
        positions: [],
        recent: [],
      }
    );
  }
  if (p === '/api/snipers') {
    const chains = list(q.get('chains'));
    const s = r<SnipersResponse>('snipers');
    const ok = (c: string) => !chains.length || chains.includes(c);
    return {
      ...s,
      launches: s.launches.filter((l) => ok(l.pair.chain)),
      profiles: s.profiles.filter((x) => ok(x.chain)),
      rings: s.rings.filter((x) => ok(x.chain)),
      links: s.links.filter((x) => ok(x.chain)),
      watchlist: s.watchlist.filter((x) => ok(x.chain)),
    };
  }
  if (p === '/api/snipers/shots') return r<Shot[]>('shots');
  if (p === '/api/alerts' && method === 'GET') return r<Alert[]>('alerts');
  if (p === '/api/settings') {
    if (method === 'PUT') data().responses.settings = { ...r<AlertSettings>('settings'), ...body };
    return r<AlertSettings>('settings');
  }
  if (p === '/api/watchlist' && method === 'POST') return setWatched(body.chain, body.wallet, true, body.label), { ok: true };
  if (p === '/api/watchlist/bulk') return (body.wallets as string[]).forEach((w, i) => setWatched(body.chain, w, true, `${body.label} #${i + 1}`)), { ok: true };
  if (p.startsWith('/api/watchlist/') && method === 'DELETE') {
    const [, , , chain, wallet] = p.split('/');
    return setWatched(chain, wallet, false), { ok: true };
  }
  if (p === '/api/alerts/test') {
    const a: Alert = {
      id: `${now}-test`, ts: now, kind: 'whale_buy', chain: 'solana',
      pair: { id: 'test', name: 'TEST / SOL', symbol: 'TEST', address: '', ageMin: 12, mcap: 420_000, liquidity: 60_000, url: '' },
      wallets: [{ wallet: 'test-wallet', usd: 12_500, roi: 3.2, legitScore: 91, tier: 'whale', label: 'test whale' }],
      usd: 12_500, message: '🧪 Test alert: test whale bought $12.5K of TEST (pair 12m old)',
    };
    alertListeners.forEach((l) => l(a));
    return { ok: true };
  }
  throw new Error(`Not available in the snapshot: ${p}`);
}

/** Replays recorded shots in bursts (one burst = one pair's opening volley) and an alert now and then. */
export function startReplay(onShot: (s: Shot) => void, onAlert: (a: Alert) => void): () => void {
  const shots = [...r<Shot[]>('shots')].sort((a, b) => a.ts - b.ts);
  const bursts: Shot[][] = [];
  for (const s of shots) {
    const last = bursts.at(-1);
    if (last && last[0].pairId === s.pairId && s.ts - last[0].ts < 5_000) last.push(s);
    else bursts.push([s]);
  }
  const alerts = r<Alert[]>('alerts').filter((a) => a.kind !== 'cluster' || a.wallets.length);
  let i = 0;
  let loop = 0;
  let tShot: ReturnType<typeof setTimeout> | undefined;
  let tAlert: ReturnType<typeof setTimeout> | undefined;
  const next = () => {
    if (!bursts.length) return;
    const b = bursts[i];
    const now = Date.now();
    b.forEach((s, k) => onShot({ ...s, id: `${s.id}-r${loop}`, ts: now + k }));
    i = (i + 1) % bursts.length;
    if (i === 0) loop++;
    tShot = setTimeout(next, 900 + Math.random() * 1_600);
  };
  let ai = 0;
  const nextAlert = () => {
    if (alerts.length) {
      const a = alerts[ai++ % alerts.length];
      const now = Date.now();
      onAlert({ ...a, id: `${a.id}-r${ai}`, ts: now, pair: { ...a.pair, ageMin: Math.min(a.pair.ageMin, 30) } });
    }
    tAlert = setTimeout(nextAlert, 25_000 + Math.random() * 15_000);
  };
  tShot = setTimeout(next, 1_200);
  tAlert = setTimeout(nextAlert, 12_000);
  return () => {
    clearTimeout(tShot);
    clearTimeout(tAlert);
  };
}
