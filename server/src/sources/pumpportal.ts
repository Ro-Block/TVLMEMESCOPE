import { num, sourceHealth } from '../http.ts';

// PumpPortal's free data websocket: every pump.fun and letsbonk.fun token the moment it's created,
// plus migrations to AMM pools. (Trade streams are metered, so trades come from Helius instead.)
// One connection for everything, reconnecting with backoff.
const URL = 'wss://pumpportal.fun/api/data';

export interface NewToken {
  signature: string;
  mint: string;
  creator: string;
  /** Tokens the creator bought in the create transaction (the dev buy). */
  initialBuy: number;
  solAmount: number;
  marketCapSol: number;
  bondingCurve: string;
  name: string;
  symbol: string;
  uri: string;
  /** Launchpad pool, e.g. "pump" or "bonk". */
  pool: string;
  receivedAt: number;
}

/** Parses one websocket message; returns null for anything that isn't a token creation. */
export function parseNewToken(raw: string, now = Date.now()): NewToken | null {
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (m.txType !== 'create' || typeof m.mint !== 'string') return null;
  return {
    signature: String(m.signature ?? ''),
    mint: m.mint,
    creator: String(m.traderPublicKey ?? ''),
    initialBuy: num(m.initialBuy),
    solAmount: num(m.solAmount),
    marketCapSol: num(m.marketCapSol),
    bondingCurve: String(m.bondingCurveKey ?? ''),
    name: String(m.name ?? ''),
    symbol: String(m.symbol ?? '?'),
    uri: String(m.uri ?? ''),
    pool: String(m.pool ?? 'pump'),
    receivedAt: now,
  };
}

export function connectPumpPortal(onToken: (t: NewToken) => void, onMigration?: (mint: string) => void) {
  let ws: WebSocket | null = null;
  let backoff = 2_000;
  let stopped = false;
  const open = () => {
    if (stopped) return;
    ws = new WebSocket(URL);
    ws.addEventListener('open', () => {
      backoff = 2_000;
      sourceHealth.pumpportal = { ok: true, lastOk: Date.now() };
      ws!.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws!.send(JSON.stringify({ method: 'subscribeMigration' }));
      console.log('[pumpportal] connected: streaming new pump.fun / letsbonk tokens');
    });
    ws.addEventListener('message', (ev) => {
      const raw = String(ev.data);
      const t = parseNewToken(raw);
      if (t) {
        sourceHealth.pumpportal = { ok: true, lastOk: Date.now() };
        onToken(t);
        return;
      }
      try {
        const m = JSON.parse(raw);
        if (m.txType === 'migrate' && typeof m.mint === 'string') onMigration?.(m.mint);
      } catch {
        /* ignore */
      }
    });
    const retry = (why: string) => {
      sourceHealth.pumpportal = { ...sourceHealth.pumpportal, ok: false, lastError: why };
      if (stopped) return;
      setTimeout(open, backoff).unref();
      backoff = Math.min(backoff * 2, 60_000);
    };
    // Browsers-style sockets fire 'error' and then 'close'; reconnect once, on close.
    ws.addEventListener('error', () => {
      sourceHealth.pumpportal = { ...sourceHealth.pumpportal, ok: false, lastError: 'websocket error' };
    });
    ws.addEventListener('close', (ev) => {
      if (ev.code !== 1000) retry(`connection closed (${ev.code})`);
    });
  };
  open();
  return () => {
    stopped = true;
    ws?.close(1000);
  };
}

/** Token metadata JSON (name, image…) behind the create event's `uri`. */
export async function metadataImage(uri: string): Promise<string | undefined> {
  if (!/^https?:\/\//.test(uri)) return undefined;
  try {
    const res = await fetch(uri, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { image?: string };
    return typeof j.image === 'string' && /^https?:\/\//.test(j.image) ? j.image : undefined;
  } catch {
    return undefined;
  }
}
