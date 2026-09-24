import { useState } from 'react';
import type { FlowWindow } from '../../../shared/types.ts';
import { AreaChart, MirrorBars, NetFlowBars } from '../components/charts.tsx';
import { EcosystemLegend, FlowEventLog, LiquidityMap, SpaceKey } from '../components/LiquidityMap.tsx';
import { api } from '../lib/api.ts';
import { ecoColor } from '../lib/colors.ts';
import { pct, signedUsd, timeAgo, usd } from '../lib/format.ts';
import { usePoll, useStored } from '../lib/hooks.ts';

const WINDOWS: FlowWindow[] = ['24h', '7d', '30d'];

export function FlowsPage() {
  const [win, setWin] = useStored<FlowWindow>('flows.window', '7d');
  const [selected, setSelected] = useState<string | null>(null);
  const { data, error } = usePoll(() => api.flows(win), [win], 5 * 60_000);

  if (error && !data) return <div className="page"><div className="card card-body">Couldn't load flows: {error}</div></div>;
  if (!data) return <div className="page muted">Loading liquidity map…</div>;

  const inflowLeader = [...data.chains].sort((a, b) => b.net - a.net)[0];
  const outflowLeader = [...data.chains].sort((a, b) => a.net - b.net)[0];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Liquidity system</h1>
          <p>Where bridged capital is moving between chains. Every chain is a planet orbiting the pool of bridged liquidity; comets show which way the money flows. Hover a planet to pause and trace its routes, click it for details.</p>
        </div>
        <div className="spacer" />
        <span className={`badge ${data.source}`}>{data.source === 'live' ? 'Live · DefiLlama' : 'Simulated data'}</span>
        <div className="seg" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w} aria-pressed={w === win} onClick={() => setWin(w)}>
              {w}
            </button>
          ))}
        </div>
      </div>

      <div className="kpis">
        <div className="card kpi">
          <div className="label">Total value locked</div>
          <div className="value">{usd(data.totals.tvl)}</div>
          <div className="sub">{data.chains.length} chains tracked</div>
        </div>
        <div className="card kpi">
          <div className="label">Bridged, {win}</div>
          <div className="value">{usd(data.totals.bridged)}</div>
          <div className="sub">sum of arrivals</div>
        </div>
        <div className="card kpi">
          <div className="label">Top net inflow</div>
          <div className="value">{inflowLeader.name}</div>
          <div className="sub">▲ {signedUsd(inflowLeader.net)}</div>
        </div>
        <div className="card kpi">
          <div className="label">Top net outflow</div>
          <div className="value">{outflowLeader.name}</div>
          <div className="sub">▼ {signedUsd(outflowLeader.net)}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head">
            <h2>Liquidity solar system</h2>
            <div className="spacer" />
            <EcosystemLegend present={new Set(data.chains.map((c) => c.ecosystem))} />
          </div>
          <div className="card-body" style={{ display: 'grid', gap: 12 }}>
            <SpaceKey />
            <LiquidityMap chains={data.chains} flows={data.flows} windowLabel={win} selected={selected} onSelect={setSelected} />
            <p className="note" style={{ margin: 0 }}>
              Per-chain inflow and outflow are measured bridge volumes.{' '}
              {data.routing === 'gravity-estimate'
                ? 'The chain-to-chain routes are estimated: DefiLlama reports totals per chain, so each chain’s outflow is split across destinations by how much they received.'
                : 'Routes are simulated.'}{' '}
              Updated {timeAgo(data.updatedAt)}.
            </p>
            <FlowEventLog />
          </div>
      </div>

      <div className="flows-grid" style={{ alignItems: 'start' }}>
          <div className="card">
            <div className="card-head">
              <h2>Net flow by chain, {win}</h2>
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
                    <th className="num">In</th>
                    <th className="num">Out</th>
                  </tr>
                </thead>
                <tbody>
                  {data.chains.map((c) => (
                    <tr key={c.id} className="clickable" aria-selected={selected === c.id} onClick={() => setSelected(c.id)}>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <i className="swatch" style={{ background: ecoColor(c.ecosystem), borderRadius: '50%' }} />
                          {c.name}
                        </span>
                      </td>
                      <td className="num">{usd(c.tvl)}</td>
                      <td className={`num ${c.tvlChange7d !== null && c.tvlChange7d >= 0 ? 'up' : 'down'}`}>{pct(c.tvlChange7d)}</td>
                      <td className="num">{usd(c.inflow)}</td>
                      <td className="num">{usd(c.outflow)}</td>
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

function ChainDrawer({ id, win, onClose }: { id: string; win: FlowWindow; onClose: () => void }) {
  const { data, error } = usePoll(() => api.chain(id, win), [id, win]);
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" aria-label="Chain details">
        <div className="drawer-head">
          {data && <i className="swatch" style={{ background: ecoColor(data.chain.ecosystem), width: 14, height: 14, borderRadius: '50%' }} />}
          <h2>{data?.chain.name ?? id}</h2>
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
              <div className="card kpi"><div className="label">In, {win}</div><div className="value">{usd(data.chain.inflow)}</div></div>
              <div className="card kpi"><div className="label">Out, {win}</div><div className="value">{usd(data.chain.outflow)}</div></div>
              <div className="card kpi"><div className="label">Net, {win}</div><div className="value">{data.chain.net >= 0 ? '▲' : '▼'} {signedUsd(data.chain.net)}</div></div>
            </div>

            <div className="card">
              <div className="card-head"><h3>TVL, last {data.tvlHistory.length} days</h3></div>
              <div className="card-body"><AreaChart data={data.tvlHistory} label="TVL" /></div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Daily bridge flows</h3>
                <div className="spacer" />
                <div className="legend">
                  <span><i className="swatch" style={{ background: 'var(--flow-in)' }} /> Inflow</span>
                  <span><i className="swatch" style={{ background: 'var(--flow-out)' }} /> Outflow</span>
                </div>
              </div>
              <div className="card-body"><MirrorBars data={data.flowHistory.slice(-45)} /></div>
            </div>

            <div className="card">
              <div className="card-head"><h3>Counterpart chains, {win}</h3><span className="note">estimated routing</span></div>
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
          </div>
        )}
      </aside>
    </>
  );
}
