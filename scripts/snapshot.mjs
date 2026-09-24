// Builds a self-contained demo page (dist-static/index.html): runs the API on the market simulator,
// records its responses, and inlines them with the built UI so the page works with no server.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const PORT = 8790 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
const WARMUP_MS = Number(process.env.SNAPSHOT_WARMUP_MS ?? 45_000);

const server = spawn('npx', ['tsx', 'server/src/index.ts'], { env: { ...process.env, DATA_MODE: 'demo', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
server.stdout.pipe(process.stdout);
const stop = () => server.kill('SIGTERM');
process.on('exit', stop);

const get = async (path) => {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};

for (let i = 0; ; i++) {
  try { await get('/api/status'); break; } catch { if (i > 120) throw new Error('server did not start'); await new Promise((r) => setTimeout(r, 500)); }
}
console.log(`[snapshot] letting the simulated market run for ${WARMUP_MS / 1000}s…`);
await new Promise((r) => setTimeout(r, WARMUP_MS));

const responses = {};
responses.status = await get('/api/status');
for (const w of ['5m', '1h', '6h', '1d', '3d', '7d']) {
  const flows = await get(`/api/flows?window=${w}`);
  responses[`flows:${w}`] = flows;
  for (const c of flows.chains) responses[`chain:${c.id}:${w}`] = await get(`/api/chains/${c.id}?window=${w}`);
}
responses.pairs = await get('/api/pairs?maxAgeHours=24');
responses.traders = await get('/api/traders?minScore=0&hideBots=0&limit=400');
responses.snipers = await get('/api/snipers');
responses.shots = await get('/api/snipers/shots');
responses.alerts = await get('/api/alerts');
responses.settings = await get('/api/settings');

const wanted = new Set();
responses.traders.slice(0, 80).forEach((t) => wanted.add(`${t.chain}:${t.wallet}`));
responses.snipers.profiles.slice(0, 60).forEach((p) => wanted.add(`${p.chain}:${p.wallet}`));
responses.snipers.rings.forEach((r) => r.members.forEach((m) => wanted.add(`${r.chain}:${m}`)));
responses.alerts.forEach((a) => a.wallets.forEach((w) => wanted.add(`${a.chain}:${w.wallet}`)));
const wallets = {};
for (const k of wanted) {
  const [chain, wallet] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)];
  const d = await get(`/api/wallets/${chain}/${wallet}`);
  wallets[k] = { ...d, recent: d.recent.slice(0, 20) };
}
stop();

// Inline the built assets and the data into one page.
const html = readFileSync('dist/index.html', 'utf8');
const assets = readdirSync('dist/assets');
const js = readFileSync(`dist/assets/${assets.find((f) => f.endsWith('.js'))}`, 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readFileSync(`dist/assets/${assets.find((f) => f.endsWith('.css'))}`, 'utf8');
const data = JSON.stringify({ capturedAt: Date.now(), responses, wallets }).replace(/</g, '\\u003c');
const head = html.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<script[\s\S]*?<\/script>/g, '').replace(/<link rel="stylesheet" crossorigin[^>]*>/g, '').replace(/<meta[^>]*>\s*/g, '');
const title = head.match(/<title>.*?<\/title>/)[0];
const out = [
  title,
  head.replace(title, '').trim(),
  `<style>${css}</style>`,
  '<div id="root"></div>',
  `<script>window.__STATIC__=${data}</script>`,
  `<script type="module">${js}</script>`,
].join('\n');
mkdirSync('dist-static', { recursive: true });
writeFileSync('dist-static/index.html', out);
console.log(`[snapshot] dist-static/index.html  ${(out.length / 1024 / 1024).toFixed(2)} MB, ${Object.keys(wallets).length} wallets, ${responses.shots.length} shots`);
process.exit(0);
