# TVL Memescope

A cross-chain **liquidity rotation map**  combined with a **memescope** that ranks traders by 60-day ROI and alerts you when proven whale wallets buy new pairs.

Chains covered: **Solana, Base, Robinhood Chain, BNB Chain and HyperEVM/Hyperliquid**, plus Ethereum, Arbitrum, OP, Tron, Avalanche, Polygon and Sui on the flow map.

## Features

| Tab | What it shows |
| --- | --- |
| **Flows** | A **liquidity solar system**. The sun in the centre is the total liquidity bridged in the window. Chains are planets on three orbits by TVL class (> $5B, $1–5B, < $1B), sized by TVL. Comets are net chain-to-chain flows heading toward the receiving chain, and each planet's halo shows net inflow (blue) or outflow (red). Planets drift slowly; hover to pause and trace a chain's routes, or click for its TVL, stablecoin and DEX-volume history, daily bridged in/out and counterpart chains. Also: KPIs (TVL, stablecoins, DEX volume, bridged), net-liquidity bars, and a chain table with pool liquidity. Windows: live 5m / 1h / 6h and trend 1d / 3d / 7d, refreshed every 30 s. |
| **Memescope** | Three live columns (**New pairs**, **Heating up**, **Smart money**) across the five chains, with chain, liquidity and age filters. Each pair shows the qualifying wallets that bought it. Each pair shows its **token logo**: the image the creator uploaded to their DexScreener token profile (picked up from DexScreener's latest-profiles feed and `tokens/v1` lookups), else GeckoTerminal's, else DexScreener's image CDN, else the token's initials and the **launchpad** it came from: pump.fun, letsbonk.fun, boop.fun, Bags, Meteora DBC, Moonshot, Clanker, Zora, Virtuals, four.meme, Flap or LiquidLaunch. Launchpads are recognised from the DEX id or the vanity suffix the launchpad grinds into the mint (`…pump`, `…bonk`, `…4444`); there's a launchpad filter too. |
| **Sniper radar** | Snipers (buys within 1/2/3/5 s of pair creation), bundles (2+ wallets in the same block/slot), and **rings**: wallets linked because they keep sniping the same launches, with their exit behaviour (*dumps together*, *holds together*, *mixed*). A live **laser view** fires a beam from the wallet to the token on every buy (red beams back on sells) for rings, solo snipers and your watchlist. Filters: chain, launchpad/DEX, token-address prefix/suffix (`J7…`, `…pump`), ring intention. Tables list sniped launches (click for the opening buys: delay, block, size, bundle, ring, sold %, exit time) and sniper wallets. |
| **Top traders** | A 60-day leaderboard: ROI, PnL, capital deployed, tokens, win rate, median hold, a 0–100 **legit score** and flags (`bot-like`, `one-hit`, `low-sample`, `small-size`). Watch or unwatch wallets, add your own (KOLs, known whales), and click a row for positions and trades. |
| **Alerts** | A live feed (SSE) with toasts, browser notifications and sound, plus optional **Telegram** and **Discord** delivery. Alert rules can be edited: chains, min buy, max pair age, min ROI, min score, min tokens, cluster size and window, and "always alert on watchlist". |

Two alert types:

- **Whale buy**: a qualifying wallet buys at least *min buy* of a pair younger than *max pair age*.
- **Cluster**: at least *N* qualifying wallets each buy at least *min buy* of the same new pair within *M* minutes.
- **Sniper ring**: at least *K* members of a known ring snipe the same new pair.

Snipers are kept out of smart money by default: a wallet whose median entry over 3 or more launches falls inside the sniper window gets a `sniper` flag, and never qualifies for whale or cluster alerts or the Smart money column. This is a toggle on the Alerts tab. The memescope marks heavily sniped or bundled pairs and can hide them.

## Quick start

```bash
npm install
cp .env.example .env        # then paste your free Helius key into HELIUS_API_KEY
npm run dev                 # API on :8787, UI on http://localhost:5173
```

Production: `npm run build && npm start`.

**No data?** Run `npm run doctor`. It checks Node and your `.env`, then tests every data source from your computer and says what's wrong (blocked, rate-limited, antivirus intercepting HTTPS, DNS…). In the app, the **Data** indicator in the top bar opens the same status per source, with the last error.

The liquidity map also plays live events. A **super comet** fires when $10M or more moves on one route within an hour (`SUPER_COMET_USD`). A **supernova** fires when a chain's stablecoins fall by $50M or more in 24h, or it bridges out $50M or more net within an hour (`SUPERNOVA_USD`).

Standalone demo page: `npm run snapshot` runs the simulator for about 45 seconds, records the API responses and writes one self-contained `dist-static/index.html`. That page needs no server: requests are answered from the recorded data, and sniper shots and alerts are replayed. The API serves the built UI on `PORT`.

Requires **Node ≥ 22.13** (uses the built-in `node:sqlite`, no native modules).

### Data modes

`DATA_MODE=auto` (the default) tries the live APIs and falls back to a built-in simulator when they're unreachable. The UI shows a *Live* or *Simulated* badge on each page. `DATA_MODE=live` forces live APIs and `DATA_MODE=demo` forces the simulator.

The simulator is a small synthetic memecoin market: about 60 days of pump-and-dump pairs and a wallet population of whales, smart traders, retail, bots and snipers, each with a hidden skill level. It runs through the same ledger, scoring and alert code as live data, so every screen can be tested offline. Its data lives only in memory.

## Data sources

Everything below is free. The flows page refreshes every 30 seconds, but the server answers from per-source caches, so a refresh costs almost no API calls:

| Data | Source | Refreshed |
| --- | --- | --- |
| Chain TVL + history | DefiLlama `api.llama.fi/v2/chains`, `/v2/historicalChainTvl/{chain}`, `/tvl/{protocol}` | 5 min / 60 min |
| Stablecoin supply per chain (net liquidity for 1d–7d) | DefiLlama `stablecoins.llama.fi/stablecoinchains`, `/stablecoincharts/{chain}` | 5 min / 30 min |
| DEX volume per chain (1d–7d) | DefiLlama `/overview/dexs/{chain}` | 15 min |
| Chain-to-chain routes (comets, bridged in/out) | Wormholescan `api.wormholescan.io/api/v1/x-chain-activity/tops` (hourly and daily buckets per chain pair, all Wormhole apps) | 2 min / 15 min |
| L2 value secured | L2BEAT `l2beat.com/api/scaling/summary` (Total Value Secured, shown in tooltips, the chain table and drawer) | 15 min |
| Pool liquidity + 5m / 1h / 6h DEX volume (optional) | GeckoTerminal top pools, only with `GECKOTERMINAL_POOLS=on` | ~6 min per chain |
| Solana launches | PumpPortal free websocket (`subscribeNewToken`, `subscribeMigration`): every pump.fun / letsbonk token as it's created, with the creator's first buy | live |
| Solana trades (wallets) | Helius: `getSignaturesForAddress` (10 credits) + Enhanced Transactions parse, 100 txs per call (100 credits), capped by `HELIUS_DAILY_CREDITS` | 15 s |
| Base / BNB / HyperEVM / Robinhood pools + trades | Public RPC via viem: `PairCreated` / `PoolCreated` from any Uniswap-style factory, Uniswap v4 `Initialize` / `Swap` on the PoolManager (Base, Robinhood), `Swap` events on tracked pools; trader = `tx.from` | 15 s |
| Pair stats (price, liquidity, volume, txns) | DexScreener `tokens/v1/{chain}/{tokens}` (30 per call, 300/min) | 45 s–2 min |
| Native prices (SOL, ETH, BNB, HYPE) | DefiLlama `coins.llama.fi/prices/current` | 60 s |
| Wallet names (optional) | Arkham `api.arkm.com/intelligence/address/{address}` with `ARKHAM_API_KEY`, cached a week per wallet | background |
| Token logos | DexScreener `token-profiles/latest/v1` and `tokens/v1/{chain}/{addresses}`, then GeckoTerminal, then DexScreener's image CDN | 60 s |
| HyperEVM whales | Hyperliquid leaderboard | 6 h |
| 60-day backfill (optional) | Dune: save `sql/top_meme_traders_60d.sql`, set `DUNE_API_KEY` + `DUNE_QUERY_ID` | cached result |

**Windows.** *Live:* 5m, 1h and 6h. The ring shows net bridged in − out, and volume comes from GeckoTerminal's top pools. Route data is hourly, so 5m shows the latest hour of routes. *Trend:* 1d, 3d and 7d. The ring shows the change in stablecoin supply on the chain, which catches every bridge, mint and burn, and volume is all DEX volume from DefiLlama.

**What the routes cover.** Comets are observed volume per chain pair on Wormhole: Portal, NTT, CCTP via Wormhole, Mayan and others. That is real data but not every bridge. Chains Wormhole doesn't connect (Lighter, Robinhood) show TVL and stablecoins without comets. DefiLlama's own bridge endpoints now require a paid Pro key, so they aren't used.

**Robinhood Chain / HyperEVM network ids.** These default to `robinhood` and `hyperevm` on GeckoTerminal. At startup the scanner warns if a configured id isn't listed; override it with `GT_NETWORK_ROBINHOOD=…` / `GT_NETWORK_HYPEREVM=…`.

**How new tokens reach the memescope.** Every launch (PumpPortal) and every new pool (chain events) starts as a *candidate*. It's shown once DexScreener reports real activity: `PROMOTE_MIN_TXNS_H1` trades, `PROMOTE_MIN_VOLUME_H1` volume, or `PROMOTE_MIN_LIQUIDITY` liquidity. A smart or watched wallet buying it also promotes it straight away. Trades seen before promotion are kept and replayed, so sniper detection still sees the opening seconds.

**Helius budget.** The free plan is 1M credits a month. The app spends at most `HELIUS_DAILY_CREDITS` a day (30,000 by default), spread over the day, on three things in this order: backfilling the opening trades of promoted tokens, checking watched and smart Solana wallets for new buys (every 10 min), and following the busiest promoted tokens. That's roughly 25–30k parsed Solana trades a day. The Data panel shows the credits used today.

**Keys stay on your PC.** `HELIUS_API_KEY`, `ARKHAM_API_KEY` and any other keys go in `.env`, which is in `.gitignore` and never committed or pushed.

**Not covered yet.** Tokens still on four.meme's bonding curve (BNB) trade on four.meme's own contract, so they only show up once they move to a PancakeSwap pool. The same goes for Solana launchpads other than pump.fun and letsbonk, unless a tracked wallet trades them.

## How trader ROI and the legit score work

The scanner polls trades on the most active recent pairs and stores every buy and sell in SQLite (`data/tvlmemescope.db`). Over the rolling `ROI_WINDOW_DAYS` (60 by default):

- **Positions** use average-cost accounting. Sells realise PnL against the cost basis, and open bags are marked to the latest pool price. A sell with no tracked buy is ignored, because there is no known cost.
- **ROI** = (realised + unrealised) / capital deployed.
- **Legit score** (0–100) = sample size (25) + win rate (25) + ROI on a log scale, where 10x earns full points (25) + size (15) + consistency (10). Deductions:
  - `bot-like` (more than 25 trades per token, or sub-minute median holds): −40
  - `low-sample` (fewer than 5 tokens): −15
  - negative ROI halves the score
  - `one-hit` (more than 80% of PnL from one token) gets no consistency points
- **Tier**: *whale* when the score passes and the average position is at least $5K; otherwise *smart*.

The ledger only knows trades it has seen, so a fresh install needs time (or the Dune backfill) before live 60-day numbers mean much. Hyperliquid leaderboard seeds use 30-day perps ROI. They pass on score alone, because they have no meme-token sample.

## How sniper, bundle and ring detection works

This is computed over the first hour of trades for every launch in the last 30 days (`server/src/engine/sniper-analysis.ts`):

- **Sniper**: the wallet's first buy lands within the sniper window of `pool_created_at`, or in the launch block itself when the opening trades were observed.
- **Bundle**: two or more sniper wallets whose first buys land in the same block or Solana slot. If there's no block data, the same second is used instead.
- **Dumped launch**: snipers holding at least half of the sniper dollars sold 80% or more within 10 minutes.
- **Links**: a pair of wallets is linked when they sniped at least 3 of the same launches, with Jaccard ≥ 0.25, and **lift ≥ 2**. Lift means they co-occur at least twice as often as two independent snipers would, so busy solo snipers don't link to everyone. Rings are the connected groups of linked wallets.
- **Intention**: for each launch the ring shared, members either all exit within 3 minutes of each other (*dump together*), all hold past the first hour (*hold together*), or neither. The majority outcome (≥ 60%) names the ring, otherwise it is *mixed*. *Cohesion* is the share of launches where they acted together.

Limits on live data: GeckoTerminal's `trades` endpoint returns only the latest 300 trades, so the scanner polls pairs under 15 minutes old first to catch their opening buys. How precise the detection is depends on how quickly a new pool shows up in `new_pools`. Funding-source links (wallets funded from the same address) need a chain-transfer source, which isn't wired in yet. Today's links come purely from trading behaviour.

## Configuration (`.env`)

| Var | Default | |
| --- | --- | --- |
| `DATA_MODE` | `auto` | `live` / `demo` / `auto` |
| `PORT` | `8787` | API port |
| `MEME_CHAINS` | `solana,base,robinhood,bsc,hyperevm` | memescope chains |
| `ROI_WINDOW_DAYS` | `60` | trader ROI window |
| `SCAN_INTERVAL_MS` | `60000` | scanner cycle |
| `POOLS_PER_CYCLE` | `12` | trade polls per cycle |
| `GT_RATE_PER_MIN` | `25` | GeckoTerminal budget |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | | Telegram alerts |
| `DISCORD_WEBHOOK_URL` | | Discord alerts |
| `DUNE_API_KEY`, `DUNE_QUERY_ID` | | 60-day backfill |
| `DB_PATH` | `data/tvlmemescope.db` | SQLite file |

## Layout

```
shared/types.ts            API contract shared by server and UI
server/src/sources/        DefiLlama, GeckoTerminal, Hyperliquid, Dune adapters
server/src/engine/flows.ts gravity routing + flow/chain-detail endpoints (live or simulated)
server/src/engine/roi.ts   pure position/ROI/legit-score maths (unit-tested)
server/src/engine/ledger.ts trade store, rolling stats, watchlist, seeds
server/src/engine/alerts.ts whale-buy and cluster rules, SSE fan-out, delivery
server/src/engine/sniper-analysis.ts pure sniper / bundle / ring detection (unit-tested)
server/src/engine/snipers.ts snapshot cache, live shot stream, ring alerts
server/src/engine/scanner.ts live GeckoTerminal polling loop
server/src/engine/demo-sim.ts synthetic market for offline use
web/src/                   React UI (Vite)
sql/                       Dune backfill query
```

`npm test` runs the unit tests and `npm run typecheck` runs the type checker.

Not financial advice. On-chain "smart money" signals are noisy, and wallets can be gamed.
