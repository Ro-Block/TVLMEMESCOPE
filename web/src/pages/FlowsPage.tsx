import { useEffect, useState } from 'react';
import { LIVE_WINDOWS, TREND_WINDOWS, type FlowWindow, type FlowsResponse } from '../../../shared/types.ts';
import { AreaChart, MirrorBars, NetFlowBars } from '../components/charts.tsx';
import { EcosystemLegend, FlowEventLog, LiquidityMap, SpaceKey } from '../components/LiquidityMap.tsx';
import { api } from '../lib/api.ts';
import { ecoColor } from '../lib/colors.ts';
import { pct, signedUsd, timeAgo, usd } from '../lib/format.ts';
import { useNow, usePoll, useStored } from '../lib/hooks.ts';

const REFRESH_MS = 30_000;
const ALL = [...LIVE_WINDOWS, ...TREND_WINDOWS];
const WINDOW_LABEL: Record<FlowWindow, string> = { '5m': '5 min', '1h': '1 hour', '6h': '6 hours', '1d': '1 day', '3d': '3 days', '7d': '7 days' };

export function FlowsPage() {
  const [stored, setWin] = useStored<FlowWindow>('flows.window', '1d');
  const win: FlowWindow = ALL.includes(stored) ? stored : '1d';
  const [selected, setSelected] = useState<string | null>(null);
  // Refreshes every 30s; the server answers from per-source caches, so this costs almost no API calls.
  const { data, error } = usePoll(() => api.flows(win), [win], REFRESH_MS);
  const now = useNow(1_000);
  const [lastLoad, setLastLoad] = useState(Date.now());
  useEffect(() => setLastLoad(Date.now()), [data]);

  if (error && !data) return <div className="page"><div className="card card-body">Couldn't load flows: {error}<p className="note">Click the Data indicator at the top for details, or run <code>npm run doctor</code> in PowerShell.</p></div></div>;
  if (!data) return <div className="page muted">Loading liquidity map…</div>;

  const ranked = [...data.chains].sort((a, b) => b.net - a.net);
  const inflowLeader = ranked[0];
  const outflowLeader = ranked.at(-1);
  const live = LIVE_WINDOWS.includes(win);
  const nextIn = Math.max(0, Math.ceil((REFRESH_MS - (now - lastLoad)) / 1000));
  const via = (name: string) => (data.source === 'live' ? name : 'simulated');

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Liquidity system</h1>
          <p>Where capital is moving between chains. Every chain is a planet; comets are real chain-to-chain transfers, flying toward the chain receiving liquidity. Hover a planet to pause and trace its routes, click it for details.</p>
        </div>
        <div className="spacer" />
        <div className="window-picker">
          <div>
            <span className="window-group-label">Live</span>
            <div className="seg" role="group" aria-label="Live windows">
              {LIVE_WINDOWS.map((w) => (
                <button key={w} aria-pressed={w === win} onClick={() => setWin(w)}>{w}</button>
              ))}
            </div>
          </div>
          <div>
            <span className="window-group-label">Trend</span>
            <div className="seg" role="group" aria-label="Trend windows">
              {TREND_WINDOWS.map((w) => (
                <button key={w} aria-pressed={w === win} onClick={() => setWin(w)}>{w}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <SourceBar data={data} nextIn={nextIn} />

      <div className="kpis">
        <div className="card kpi">
          <div className="label">Total value locked</div>
          <div className="value">{usd(data.totals.tvl)}</div>
          <div className="sub">{data.chains.length} chains · {via('DefiLlama')}</div>
        </div>
        <div className="card kpi">
          <div className="label">Stablecoins on these chains</div>
          <div className="value">{usd(data.totals.stablecoins)}</div>
          <div className="sub">dry powder · {via('DefiLlama')}</div>
        </div>
        <div className="card kpi">
          <div className="label">DEX volume, {WINDOW_LABEL[win]}</div>
          <div className="value">{data.totals.dexVolume ? usd(data.totals.dexVolume) : '—'}</div>
          <div className="sub">{live ? `top pools · ${via('GeckoTerminal')}` : `all DEXs · ${via('DefiLlama')}`}</div>
        </div>
        <div className="card kpi">
          <div className="label">Bridged, {WINDOW_LABEL[data.routesWindow]}</div>
          <div className="value">{usd(data.totals.bridged)}</div>
          <div className="sub">observed routes · {data.routing === 'observed' ? 'Wormholescan' : 'simulated'}</div>
        </div>
        {inflowLeader && (
          <div className="card kpi">
            <div className="label">Top net inflow</div>
            <div className="value">{inflowLeader.name}</div>
            <div className="sub">▲ {signedUsd(inflowLeader.net)}</div>
          </div>
        )}
        {outflowLeader && (
          <div className="card kpi">
            <div className="label">Top net outflow</div>
            <div className="value">{outflowLeader.name}</div>
            <div className="sub">▼ {signedUsd(outflowLeader.net)}</div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Liquidity solar system · {WINDOW_LABEL[win]}</h2>
          <div className="spacer" />
          <EcosystemLegend present={new Set(data.chains.map((c) => c.ecosystem))} />
        </div>
        <div className="card-body" style={{ display: 'grid', gap: 12 }}>
          <SpaceKey live={live} />
          <LiquidityMap chains={data.chains} flows={data.flows} windowLabel={win} selected={selected} onSelect={setSelected} />
          <p className="note" style={{ margin: 0 }}>
            {live
              ? 'Ring = net bridged in − out on observed routes. Volume = DEX volume in the chain’s top pools.'
              : 'Ring = change in stablecoin supply on the chain (catches every bridge, mint and burn). Volume = all DEX volume.'}{' '}
            {data.routing === 'observed'
              ? `Comets are observed chain-to-chain volume from Wormholescan (Portal, NTT, CCTP and other Wormhole apps)${win === '5m' ? '; route data is hourly, so 5m shows the latest hour of routes' : ''}. Chains Wormhole doesn’t connect (Lighter, Robinhood) show TVL and stablecoins but no comets.`
              : 'Routes are simulated.'}
          </p>
          <FlowEventLog />
        </div>
      </div>

      <div className="flows-grid" style={{ alignItems: 'start' }}>
          <div className="card">
            <div className="card-head">
              <h2>Net liquidity by chain, {WINDOW_LABEL[win]}</h2>
            </div>
            <div className="card-body">
              <NetFlowBars chains={data.chains} onSelect={setSelected} selected={selected} />
              <div className="legend" style={{ marginTop: 6 }}>
                <span><i className="swatch" style={{ background: 'var(--flow-in)' }} /> Net inflow ▲</span>
                <span><i className="swatch" style={{ background: 'var(--flow-out)' }} /> Net outflow ▼</span>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Chain</th>
                    <th className="num">TVL</th>
                    <th className="num">7d</th>
                    <th className="num">Stables</th>
                    <th className="num">DEX vol</th>
                    <th className="num">Pool liq.</th>
                    <th className="num">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {data.chains.map((c) => (
                    <tr key={c.id} className="clickable" aria-selected={selected === c.id} onClick={() => setSelected(c.id)}>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <i className="swatch" style={{ background: ecoColor(c.ecosystem), borderRadius: '50%' }} />
                          {c.name}
                          {c.ticker && <span className="muted mono" style={{ fontSize: 12 }}>{c.ticker}</span>}
                        </span>
                      </td>
                      <td className="num">{usd(c.tvl)}</td>
                      <td className={`num ${c.tvlChange7d !== null && c.tvlChange7d >= 0 ? 'up' : 'down'}`}>{pct(c.tvlChange7d)}</td>
                      <td className="num">{c.stablecoins !== null ? usd(c.stablecoins) : '—'}</td>
                      <td className="num">{c.dexVolume !== null ? usd(c.dexVolume) : '—'}</td>
                      <td className="num">{c.poolLiquidity !== null ? usd(c.poolLiquidity) : '—'}</td>
                      <td className={`num ${c.net >= 0 ? 'up' : 'down'}`}>{c.net >= 0 ? '▲' : '▼'} {signedUsd(c.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
      </div>

      {selected && <ChainDrawer id={selected} win={win} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** Which sources fed this view, how fresh they are, and when the page refreshes next. */
function SourceBar({ data, nextIn }: { data: FlowsResponse; nextIn: number }) {
  return (
    <div className="source-bar" role="status">
      <span className={`badge ${data.source}`}>{data.source === 'live' ? 'Live data' : 'Simulated data'}</span>
      {data.sources.map((s) => (
        <span key={s.name} className={`source ${s.ok ? 'ok' : 'bad'}`} title={s.note ?? ''}>
          <i aria-hidden>{s.ok ? '●' : '○'}</i> {s.name}
          <span className="muted">{s.updatedAt ? ` · ${timeAgo(s.updatedAt)}` : s.ok ? '' : ' · unavailable'}</span>
        </span>
      ))}
      <span className="spacer" />
      <span className="muted mono">refresh in {nextIn}s</span>
    </div>
  );
}

function ChainDrawer({ id, win, onClose }: { id: string; win: FlowWindow; onClose: () => void }) {
  const { data, error } = usePoll(() => api.chain(id, win), [id, win]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" aria-label="Chain details">
        <div className="drawer-head">
          {data && <i className="swatch" style={{ background: ecoColor(data.chain.ecosystem), width: 14, height: 14, borderRadius: '50%' }} />}
          <h2>{data?.chain.name ?? id}{data?.chain.ticker && <span className="muted mono" style={{ fontSize: 14, marginLeft: 8 }}>{data.chain.ticker}</span>}</h2>
          {data && <span className="badge">{data.chain.ecosystem}</span>}
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        {error && <div className="drawer-body">Couldn't load: {error}</div>}
        {!data && !error && <div className="drawer-body muted">Loading…</div>}
        {data && (
          <div className="drawer-body">
            <div className="kpis" style={{ marginBottom: 0 }}>
              <div className="card kpi"><div className="label">TVL</div><div className="value">{usd(data.chain.tvl)}</div><div className="sub">{pct(data.chain.tvlChange7d)} 7d</div></div>
              <div className="card kpi"><div className="label">Stablecoins</div><div className="value">{data.chain.stablecoins !== null ? usd(data.chain.stablecoins) : '—'}</div><div className="sub">{data.chain.stableChange !== null ? `${signedUsd(data.chain.stableChange)} ${win}` : 'supply now'}</div></div>
              <div className="card kpi"><div className="label">DEX volume, {win}</div><div className="value">{data.chain.dexVolume !== null ? usd(data.chain.dexVolume) : '—'}</div><div className="sub">{data.chain.poolLiquidity !== null ? `${usd(data.chain.poolLiquidity)} in top pools` : ''}</div></div>
              <div className="card kpi"><div className="label">Bridged in / out</div><div className="value" style={{ fontSize: 18 }}>{usd(data.chain.inflow)} / {usd(data.chain.outflow)}</div><div className="sub">observed routes</div></div>
              <div className="card kpi"><div className="label">Net liquidity, {win}</div><div className="value">{data.chain.net >= 0 ? '▲' : '▼'} {signedUsd(data.chain.net)}</div></div>
            </div>

            <div className="card">
              <div className="card-head"><h3>TVL, last {data.tvlHistory.length} days</h3></div>
              <div className="card-body"><AreaChart data={data.tvlHistory} label="TVL" /></div>
            </div>

            {data.stableHistory.length > 1 && (
              <div className="card">
                <div className="card-head"><h3>Stablecoin supply, last {data.stableHistory.length} days</h3></div>
                <div className="card-body"><AreaChart data={data.stableHistory} label="Stablecoins" /></div>
              </div>
            )}

            {data.dexHistory.length > 1 && (
              <div className="card">
                <div className="card-head"><h3>Daily DEX volume</h3></div>
                <div className="card-body"><AreaChart data={data.dexHistory} label="DEX volume" height={160} /></div>
              </div>
            )}

            <div className="card">
              <div className="card-head">
                <h3>Daily bridged in / out (observed routes)</h3>
                <div className="spacer" />
                <div className="legend">
                  <span><i className="swatch" style={{ background: 'var(--flow-in)' }} /> Inflow</span>
                  <span><i className="swatch" style={{ background: 'var(--flow-out)' }} /> Outflow</span>
                </div>
              </div>
              <div className="card-body">{data.flowHistory.length ? <MirrorBars data={data.flowHistory.slice(-45)} /> : <div className="note">No observed routes for this chain.</div>}</div>
            </div>

            <div className="card">
              <div className="card-head"><h3>Counterpart chains, {win}</h3><span className="note">{data.source === 'live' ? 'observed routes' : 'simulated'}</span></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Chain</th><th className="num">Into {data.chain.name}</th><th className="num">Out to</th><th className="num">Net</th></tr></thead>
                  <tbody>
                    {data.counterparts.slice(0, 10).map((c) => (
                      <tr key={c.chain}>
                        <td><span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><i className="swatch" style={{ background: ecoColor(c.ecosystem), borderRadius: '50%' }} />{c.name}</span></td>
                        <td className="num">{usd(c.toHere)}</td>
                        <td className="num">{usd(c.fromHere)}</td>
                        <td className="num">{c.toHere - c.fromHere >= 0 ? '▲' : '▼'} {signedUsd(c.toHere - c.fromHere)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {(data.bridges.length > 0 || data.topTokens.length > 0) && (
            <div className="split">
              <div className="card">
                <div className="card-head"><h3>Bridges serving {data.chain.name}</h3></div>
                <div className="table-wrap">
                  <table>
                    <tbody>
                      {data.bridges.length === 0 && <tr><td className="muted">No bridge data</td></tr>}
                      {data.bridges.map((b) => (
                        <tr key={b.name}><td>{b.name}</td><td className="num">{usd(b.volume)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="card">
                <div className="card-head"><h3>Top tokens bridged (1d)</h3></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Token</th><th className="num">In</th><th className="num">Out</th></tr></thead>
                    <tbody>
                      {data.topTokens.length === 0 && <tr><td className="muted" colSpan={3}>No token data</td></tr>}
                      {data.topTokens.map((t) => (
                        <tr key={t.symbol}><td>{t.symbol}</td><td className="num">{usd(t.inUsd)}</td><td className="num">{usd(t.outUsd)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
            )}
          </div>
        )}
      </aside>
    </>
  );
}
