// Checks, from this computer, that every data source the app uses can be reached.
// Run with: npm run doctor   (never prints your API keys)
import { existsSync, readFileSync } from 'node:fs';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
let failed = 0;
const fail = (msg) => {
  failed++;
  console.log(bad(`  ✗ ${msg}`));
};

console.log(`Node ${process.version} on ${process.platform}`);
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) fail('Node 22.13 or newer is required (built-in SQLite). Install the current LTS from nodejs.org.');
else console.log(ok('  ✓ Node version OK'));

// Read .env without printing secrets.
const env = {};
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  const mode = env.DATA_MODE || 'auto';
  console.log(mode === 'live' ? ok(`  ✓ .env found, DATA_MODE=${mode}`) : warn(`  ! .env found, DATA_MODE=${mode} (set DATA_MODE=live to never fall back to simulated data)`));
} else console.log(warn('  ! No .env file: running with DATA_MODE=auto (copy .env.example to .env)'));
const has = (k) => Boolean(env[k] || process.env[k]);
const val = (k) => env[k] || process.env[k] || '';
console.log(has('HELIUS_API_KEY') ? ok('  ✓ HELIUS_API_KEY set') : warn('  ! HELIUS_API_KEY not set: Solana wallet trades (top traders, snipers, whale alerts) need a free key from dashboard.helius.dev'));
console.log(has('ARKHAM_API_KEY') ? ok('  ✓ ARKHAM_API_KEY set') : warn('  ! ARKHAM_API_KEY not set: wallet names from Arkham are off (optional)'));

async function http(name, url, { method = 'GET', body, headers = {}, check, sample = false } = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, body, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, signal: AbortSignal.timeout(20_000) });
    const ms = Date.now() - t0;
    if (!res.ok) {
      fail(`${name}: HTTP ${res.status} ${res.statusText} (${ms} ms)${res.status === 429 ? ' — rate limited, retry in a minute' : res.status === 401 || res.status === 403 ? ' — key missing/invalid or access blocked' : ''}`);
      return;
    }
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      fail(`${name}: not JSON: ${text.slice(0, 120)}`);
      return;
    }
    const verdict = check ? check(j) : true;
    if (verdict === true) console.log(ok(`  ✓ ${name} (${ms} ms)`));
    else {
      fail(`${name}: ${typeof verdict === 'string' ? verdict : 'unexpected response'}`);
      if (sample) console.log('      sample:', text.slice(0, 400));
    }
  } catch (e) {
    const cause = e.cause ? ` — ${e.cause.code ?? ''} ${e.cause.message ?? ''}` : '';
    fail(`${name}: ${e.message}${cause}`);
    if (/CERT|SELF_SIGNED|certificate/i.test(cause + e.message)) console.log('      an antivirus / firewall is intercepting HTTPS; allow Node.js or turn off its HTTPS scanning');
    if (/ENOTFOUND|EAI_AGAIN/.test(cause)) console.log('      DNS lookup failed: check your internet connection or VPN');
  }
}

const rpc = (name, url) => http(name, url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }), check: (j) => (typeof j.result === 'string' ? true : `no block number (${JSON.stringify(j).slice(0, 120)})`) });

console.log('\nLiquidity map');
const now = Date.now();
await http('DefiLlama TVL', 'https://api.llama.fi/v2/chains', { check: (j) => Array.isArray(j) && j.length > 50 });
await http('DefiLlama stablecoins', 'https://stablecoins.llama.fi/stablecoinchains', { check: (j) => Array.isArray(j) && j.length > 10 });
await http('DefiLlama DEX volume', 'https://api.llama.fi/overview/dexs/Base?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true', { check: (j) => typeof j.total24h === 'number' });
await http('Wormholescan routes', `https://api.wormholescan.io/api/v1/x-chain-activity/tops?timespan=1h&from=${new Date(now - 3 * 3600e3).toISOString()}&to=${new Date(now).toISOString()}`, { check: (j) => Array.isArray(j) });
await http('L2BEAT value secured', 'https://l2beat.com/api/scaling/summary', {
  sample: true,
  check: (j) => {
    const p = j?.data?.projects;
    const list = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.values(p) : [];
    const n = list.filter((x) => x?.tvs?.breakdown?.total > 0 || x?.tvs?.total > 0 || x?.tvs?.usdValue > 0 || x?.tvl?.breakdown?.total > 0).length;
    return n > 0 ? true : `format not recognised (keys: ${Object.keys(j ?? {}).join(',')}; data: ${j?.data ? Object.keys(j.data).join(',') : '-'}) — paste this output to get it fixed`;
  },
});

console.log('\nMemescope, snipers, whales');
await http('DexScreener pairs', 'https://api.dexscreener.com/tokens/v1/solana/So11111111111111111111111111111111111111112', { check: (j) => Array.isArray(j) });
await http('DefiLlama prices', 'https://coins.llama.fi/prices/current/coingecko:solana', { check: (j) => j?.coins?.['coingecko:solana']?.price > 0 });
await new Promise((resolve) => {
  const t0 = Date.now();
  let done = false;
  const finish = (fn) => {
    if (done) return;
    done = true;
    fn();
    try {
      ws.close();
    } catch {}
    resolve();
  };
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  const timer = setTimeout(() => finish(() => fail('PumpPortal launches: connected but no new token within 20 s')), 20_000);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ method: 'subscribeNewToken' })));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.txType === 'create') {
      clearTimeout(timer);
      finish(() => console.log(ok(`  ✓ PumpPortal launches (first new token after ${Date.now() - t0} ms: ${m.symbol})`)));
    }
  });
  ws.addEventListener('error', () => {
    clearTimeout(timer);
    finish(() => fail('PumpPortal launches: websocket could not connect'));
  });
});
if (has('HELIUS_API_KEY')) {
  await http('Helius (Solana trades)', `https://mainnet.helius-rpc.com/?api-key=${val('HELIUS_API_KEY')}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getHealth' }), check: (j) => (j.result === 'ok' ? true : `unexpected: ${JSON.stringify(j).slice(0, 120)}`) });
}
await rpc('Base RPC', val('RPC_BASE') || 'https://base-rpc.publicnode.com');
await rpc('BNB Chain RPC', val('RPC_BSC') || 'https://bsc-rpc.publicnode.com');
await rpc('HyperEVM RPC', val('RPC_HYPEREVM') || 'https://rpc.hyperliquid.xyz/evm');
await rpc('Robinhood Chain RPC', val('RPC_ROBINHOOD') || 'https://rpc.mainnet.chain.robinhood.com');
await http('Hyperliquid leaderboard', 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', { check: (j) => Array.isArray(j.leaderboardRows) });
if (has('ARKHAM_API_KEY')) {
  // One lookup (a well-known address) to confirm the key works.
  await http('Arkham labels', 'https://api.arkm.com/intelligence/address/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', { headers: { 'API-Key': val('ARKHAM_API_KEY') }, check: (j) => (j && typeof j === 'object' ? true : 'unexpected response') });
}

console.log(failed ? bad(`\n${failed} check(s) failed. Paste this output to get help.`) : ok('\nAll data sources reachable.'));
process.exit(0);
