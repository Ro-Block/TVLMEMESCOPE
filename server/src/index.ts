import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import type { AlertSettings, FlowWindow, StatusResponse, TraderStats } from '../../shared/types.ts';
import { DATA_MODE, DB_PATH, DEFAULT_ALERT_SETTINGS, MEME_CHAINS, PORT, ROI_WINDOW_DAYS } from './config.ts';
import { openDb } from './db.ts';
import { AlertEngine } from './engine/alerts.ts';
import { DemoMarket } from './engine/demo-sim.ts';
import { FlowEventEngine } from './engine/flow-events.ts';
import { flowsSource, getChainDetail, getFlows, parseWindow, startPoolRotation, warmFlows } from './engine/flows.ts';
import { Ledger } from './engine/ledger.ts';
import { LiveScanner, type TradeSink } from './engine/scanner.ts';
import { SniperEngine } from './engine/snipers.ts';
import { sourceHealth } from './http.ts';
import { notifyChannels } from './notify.ts';

// DATA_MODE=live never waits on a probe; auto gives GeckoTerminal a few seconds to answer.
const memeMode = DATA_MODE === 'demo' ? 'demo' : DATA_MODE === 'live' || (await LiveScanner.probe()) ? 'live' : 'demo';
if (memeMode === 'demo') console.log('[memescope] running on the built-in market simulator (set DATA_MODE=live to force live APIs)');

// Simulated history never touches the persistent database.
const db = openDb(memeMode === 'demo' ? ':memory:' : DB_PATH);

let settings: AlertSettings = { ...DEFAULT_ALERT_SETTINGS };
const saved = db.prepare("SELECT json FROM kv WHERE key = 'settings'").get() as { json: string } | undefined;
if (saved) settings = { ...settings, ...JSON.parse(saved.json) };
const getSettings = () => settings;

const ledger = new Ledger(db, ROI_WINDOW_DAYS, getSettings);
const alerts = new AlertEngine(db, ledger, getSettings);
const snipers = new SniperEngine(db, ledger, alerts, getSettings);
ledger.extraFlags = (chain, wallet) => (snipers.isSniper(chain, wallet) ? ['sniper'] : []);
const onTrades: TradeSink = (pair, fresh, now) => {
  alerts.onTrades(pair, fresh, now);
  snipers.onTrades(pair, fresh, now);
};
if (memeMode === 'demo') new DemoMarket(ledger, alerts, onTrades, () => snipers.compute()).start();
else new LiveScanner(ledger, onTrades).start();

startPoolRotation();
const flowEvents = new FlowEventEngine();
// Never block startup on network calls: the server answers at once and fills in data as it arrives.
flowEvents.start(DATA_MODE === 'demo' ? 'demo' : 'live');

const app = express();
app.use(express.json());

const wrap =
  (fn: (req: express.Request, res: express.Response) => unknown) =>
  async (req: express.Request, res: express.Response) => {
    try {
      const out = await fn(req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ error: (e as Error).message });
    }
  };

const windowOf = (q: unknown): FlowWindow => parseWindow(q);
const listOf = (q: unknown) => (typeof q === 'string' && q ? q.split(',') : []);

app.get('/api/status', wrap(async (): Promise<StatusResponse> => ({
  flows: await flowsSource(),
  memescope: memeMode,
  chains: MEME_CHAINS.map(({ id, name, ecosystem }) => ({ id, name, ecosystem })),
  roiWindowDays: ROI_WINDOW_DAYS,
  ledger: ledger.counts(),
  sources: sourceHealth,
  notify: notifyChannels(),
  scanner: memeMode === 'live' ? LiveScanner.stats : null,
})));

app.get('/api/flows', wrap((req) => getFlows(windowOf(req.query.window))));

app.get('/api/flow-events', wrap(() => flowEvents.list()));

app.get('/api/chains/:id', wrap(async (req, res) => {
  const d = await getChainDetail(String(req.params.id), windowOf(req.query.window));
  if (!d) return res.status(404).json({ error: 'unknown chain' });
  return d;
}));

app.get('/api/pairs', wrap((req) => {
  const chains = listOf(req.query.chains);
  const maxAge = Number(req.query.maxAgeHours ?? 24);
  const pairs = ledger.pools({ chains, sinceCreated: Date.now() - maxAge * 3_600_000, limit: 400 });
  const smart = ledger.smartBuyers(pairs.map((p) => p.id), settings);
  return pairs.map((p) => ({ ...p, smartWallets: smart.get(p.id) ?? [], snipe: snipers.summary(p.id) }));
}));

app.get('/api/traders', wrap((req) => {
  const chains = listOf(req.query.chains);
  const sort = String(req.query.sort ?? 'score') as 'roi' | 'pnl' | 'score';
  const minScore = Number(req.query.minScore ?? 0);
  const minTokens = Number(req.query.minTokens ?? 0);
  const hideBots = req.query.hideBots !== '0';
  const key: Record<string, (s: TraderStats) => number> = { roi: (s) => s.roi, pnl: (s) => s.pnlUsd, score: (s) => s.legitScore * 1e12 + s.pnlUsd };
  return ledger
    .allStats()
    .filter((s) => (!chains.length || chains.includes(s.chain)) && (s.legitScore >= minScore || s.watched) && (s.tokens >= minTokens || s.source !== 'ledger') && (!hideBots || !s.flags.includes('bot-like')))
    .sort((a, b) => (key[sort] ?? key.score)(b) - (key[sort] ?? key.score)(a))
    .slice(0, Number(req.query.limit ?? 200))
    .map((s) => ({ ...s, qualifies: ledger.qualifies(s, settings) }));
}));

app.get('/api/wallets/:chain/:wallet', wrap((req) => ledger.walletDetail(String(req.params.chain), String(req.params.wallet))));

app.post('/api/watchlist', wrap((req, res) => {
  const { chain, wallet, label } = req.body ?? {};
  if (!MEME_CHAINS.some((c) => c.id === chain) || typeof wallet !== 'string' || wallet.length < 20) return res.status(400).json({ error: 'chain and wallet required' });
  ledger.addWatch(chain, wallet.trim(), typeof label === 'string' && label.trim() ? label.trim().slice(0, 40) : undefined);
  return { ok: true };
}));

app.delete('/api/watchlist/:chain/:wallet', wrap((req) => {
  ledger.removeWatch(String(req.params.chain), String(req.params.wallet));
  return { ok: true };
}));

app.get('/api/snipers', wrap((req) => snipers.response({ chains: listOf(req.query.chains) })));
app.get('/api/snipers/shots', wrap(() => snipers.recentShots()));

app.post('/api/watchlist/bulk', wrap((req, res) => {
  const { chain, wallets, label } = req.body ?? {};
  if (!MEME_CHAINS.some((c) => c.id === chain) || !Array.isArray(wallets)) return res.status(400).json({ error: 'chain and wallets required' });
  wallets.slice(0, 50).forEach((w: unknown, i: number) => typeof w === 'string' && w.length >= 20 && ledger.addWatch(chain, w, typeof label === 'string' ? `${label} #${i + 1}` : undefined));
  return { ok: true };
}));

app.get('/api/alerts', wrap(() => alerts.list()));

app.get('/api/settings', wrap(() => settings));

app.put('/api/settings', wrap((req) => {
  const b = req.body ?? {};
  const n = (k: keyof AlertSettings, lo: number, hi: number) => (typeof b[k] === 'number' && Number.isFinite(b[k]) ? Math.max(lo, Math.min(hi, b[k])) : settings[k]);
  settings = {
    chains: Array.isArray(b.chains) ? b.chains.filter((c: unknown) => MEME_CHAINS.some((m) => m.id === c)) : settings.chains,
    minBuyUsd: n('minBuyUsd', 0, 1e9) as number,
    maxPairAgeHours: n('maxPairAgeHours', 0.1, 24 * 30) as number,
    minRoi: n('minRoi', -1, 1000) as number,
    minLegitScore: n('minLegitScore', 0, 100) as number,
    minTokens: n('minTokens', 0, 1000) as number,
    clusterSize: n('clusterSize', 2, 50) as number,
    clusterWindowMin: n('clusterWindowMin', 1, 24 * 60) as number,
    includeWatchlist: typeof b.includeWatchlist === 'boolean' ? b.includeWatchlist : settings.includeWatchlist,
    sniperWindowSec: n('sniperWindowSec', 0.5, 60) as number,
    excludeSnipers: typeof b.excludeSnipers === 'boolean' ? b.excludeSnipers : settings.excludeSnipers,
    ringAlerts: typeof b.ringAlerts === 'boolean' ? b.ringAlerts : settings.ringAlerts,
    ringMinMembers: n('ringMinMembers', 2, 50) as number,
    telegram: typeof b.telegram === 'boolean' ? b.telegram : settings.telegram,
    discord: typeof b.discord === 'boolean' ? b.discord : settings.discord,
  };
  db.prepare("INSERT OR REPLACE INTO kv (key, json) VALUES ('settings', ?)").run(JSON.stringify(settings));
  return settings;
}));

app.post('/api/alerts/test', wrap(() => {
  const now = Date.now();
  alerts.emit({
    id: `${now}-test`, ts: now, kind: 'whale_buy', chain: MEME_CHAINS[0]?.id ?? 'solana',
    pair: { id: 'test', name: 'TEST / SOL', symbol: 'TEST', address: '', ageMin: 12, mcap: 420_000, liquidity: 60_000, url: '' },
    wallets: [{ wallet: 'test-wallet', usd: 12_500, roi: 3.2, legitScore: 91, tier: 'whale', label: 'test whale' }],
    usd: 12_500, message: '🧪 Test alert: test whale bought $12.5K of TEST (pair 12m old)',
  });
  return { ok: true };
}));

app.get('/api/stream', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const off = alerts.subscribe((a) => res.write(`event: alert\ndata: ${JSON.stringify(a)}\n\n`));
  const offShots = snipers.subscribe((s) => res.write(`event: shot\ndata: ${JSON.stringify(s)}\n\n`));
  const offFlow = flowEvents.subscribe((e) => res.write(`event: flow\ndata: ${JSON.stringify(e)}\n\n`));
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    off();
    offShots();
    offFlow();
    clearInterval(ping);
  });
});

const dist = resolve('dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

app.get('/api/health', wrap(async () => ({
  node: process.version,
  dataMode: DATA_MODE,
  memescope: memeMode,
  flows: await flowsSource().catch(() => 'error'),
  scanner: memeMode === 'live' ? LiveScanner.stats : null,
  ledger: ledger.counts(),
  sources: sourceHealth,
})));

app.listen(PORT, () => {
  console.log(`[api] http://localhost:${PORT}  (data: ${DATA_MODE}, memescope: ${memeMode})`);
  console.log('[api] open the app at http://localhost:5173 (npm run dev) or this port (npm start)');
  void warmFlows();
});
