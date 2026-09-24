// Checks, from this computer, that every data source the app uses can be reached.
// Run with: npm run doctor
import { existsSync, readFileSync } from 'node:fs';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;

console.log(`Node ${process.version} on ${process.platform}`);
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 13)) console.log(bad('  ✗ Node 22.13 or newer is required (built-in SQLite). Install the current LTS from nodejs.org.'));
else console.log(ok('  ✓ Node version OK'));

if (existsSync('.env')) {
  const mode = (readFileSync('.env', 'utf8').match(/^DATA_MODE=(\w+)/m) ?? [])[1] ?? 'auto';
  console.log(mode === 'live' ? ok(`  ✓ .env found, DATA_MODE=${mode}`) : warn(`  ! .env found, DATA_MODE=${mode} (set DATA_MODE=live to never fall back to simulated data)`));
} else console.log(warn('  ! No .env file: running with DATA_MODE=auto (copy .env.example to .env)'));

const now = Date.now();
const checks = [
  ['DefiLlama TVL', 'https://api.llama.fi/v2/chains', (j) => Array.isArray(j) && j.length > 50],
  ['DefiLlama stablecoins', 'https://stablecoins.llama.fi/stablecoinchains', (j) => Array.isArray(j) && j.length > 10],
  ['DefiLlama DEX volume', 'https://api.llama.fi/overview/dexs/Base?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true', (j) => typeof j.total24h === 'number'],
  ['Wormholescan routes', `https://api.wormholescan.io/api/v1/x-chain-activity/tops?timespan=1h&from=${new Date(now - 3 * 3600e3).toISOString()}&to=${new Date(now).toISOString()}`, (j) => Array.isArray(j)],
  ['GeckoTerminal', 'https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1', (j) => Array.isArray(j.data)],
  ['DexScreener', 'https://api.dexscreener.com/token-profiles/latest/v1', (j) => Array.isArray(j)],
  ['Hyperliquid leaderboard', 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', (j) => Array.isArray(j.leaderboardRows)],
];

let failed = 0;
for (const [name, url, valid] of checks) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    const ms = Date.now() - t0;
    if (!res.ok) {
      failed++;
      console.log(bad(`  ✗ ${name}: HTTP ${res.status} ${res.statusText} (${ms} ms)`));
      if (res.status === 429) console.log('      rate limited: wait a minute and retry');
      continue;
    }
    const body = await res.json();
    if (valid(body)) console.log(ok(`  ✓ ${name} (${ms} ms)`));
    else {
      failed++;
      console.log(bad(`  ✗ ${name}: unexpected response`), JSON.stringify(body).slice(0, 200));
    }
  } catch (e) {
    failed++;
    const cause = e.cause ? ` — ${e.cause.code ?? ''} ${e.cause.message ?? ''}` : '';
    console.log(bad(`  ✗ ${name}: ${e.message}${cause}`));
    if (/CERT|SELF_SIGNED|certificate/i.test(cause + e.message)) console.log('      an antivirus / firewall is intercepting HTTPS; allow Node.js or turn off its HTTPS scanning');
    if (/ENOTFOUND|EAI_AGAIN/.test(cause)) console.log('      DNS lookup failed: check your internet connection or VPN');
  }
}
console.log(failed ? bad(`\n${failed} source(s) failed. Paste this output to get help.`) : ok('\nAll data sources reachable.'));
