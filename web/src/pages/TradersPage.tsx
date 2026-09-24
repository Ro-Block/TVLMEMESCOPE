import { useState } from 'react';
import type { MemeChain, TraderStats } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { chainColor } from '../lib/colors.ts';
import { age, pct, shortAddr, timeAgo, usd } from '../lib/format.ts';
import { usePoll, useStored } from '../lib/hooks.ts';

const FLAG_INFO: Record<string, string> = {
  'low-sample': 'Fewer than 5 tokens traded in the window',
  'bot-like': 'Many round-trips per token or sub-minute holds (MEV / volume bot pattern)',
  'one-hit': 'More than 80% of PnL came from a single token',
  'small-size': 'Less than $2K deployed in the window',
  'hl-perps-30d': 'Seeded from the Hyperliquid perps leaderboard (30d ROI)',
  manual: 'Added to your watchlist by hand',
  sniper: 'Usually buys within seconds of pair creation (see Sniper radar)',
};
const BAD = new Set(['bot-like', 'one-hit', 'sniper']);

export function TierLabel({ tier }: { tier: TraderStats['tier'] }) {
  if (tier === 'whale') return <span className="tier">🐋 Whale</span>;
  if (tier === 'smart') return <span className="tier">🧠 Smart</span>;
  if (tier === 'watch') return <span className="tier">👁 Watch</span>;
  return <span className="muted">—</span>;
}

export function Score({ v }: { v: number }) {
  return (
    <span className="meter">
      <span className="meter-bar"><i style={{ width: `${v}%` }} /></span>
      <span className="mono">{v}</span>
    </span>
  );
}

export function TradersPage({ chains, windowDays, onWallet }: { chains: MemeChain[]; windowDays: number; onWallet: (chain: string, wallet: string) => void }) {
  const [sel, setSel] = useStored<string[]>('traders.chains', []);
  const [sort, setSort] = useStored('traders.sort', 'score');
  const [minScore, setMinScore] = useStored('traders.minScore', 50);
  const [hideBots, setHideBots] = useStored('traders.hideBots', true);
  const { data, reload } = usePoll(() => api.traders({ chains: sel, sort, minScore, hideBots }), [sel.join(','), sort, minScore, hideBots], 30_000);
  const [addChain, setAddChain] = useState(chains[0]?.id ?? 'solana');
  const [addWallet, setAddWallet] = useState('');
  const [addLabel, setAddLabel] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const toggle = (id: string) => setSel(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
  const watch = async (t: TraderStats) => {
    await (t.watched ? api.unwatch(t.chain, t.wallet) : api.watch(t.chain, t.wallet, t.label));
    void reload();
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.watch(addChain, addWallet.trim(), addLabel.trim() || undefined);
      setAddWallet('');
      setAddLabel('');
      setErr(null);
      void reload();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };

  const rows = data ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Top traders, {windowDays} days</h1>
          <p>
            Wallet ROI from every tracked new-pair trade using average-cost accounting, with open positions marked to the current price. The legit score weighs
            sample size, win rate, ROI, size and consistency, and filters out bots, snipers and one-hit wonders.
          </p>
        </div>
      </div>

      <div className="filters">
        {chains.map((c) => (
          <button key={c.id} className="chip" aria-pressed={sel.includes(c.id)} onClick={() => toggle(c.id)}>
            <i className="swatch" style={{ background: chainColor(c.id), borderRadius: '50%' }} />
            {c.name}
          </button>
        ))}
        <div className="spacer" />
        <label className="secondary" style={{ fontSize: 13, display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          Min score <input type="range" min={0} max={95} step={5} value={minScore} onChange={(e) => setMinScore(+e.target.value)} /> <span className="mono">{minScore}</span>
        </label>
        <label className="secondary" style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={hideBots} onChange={(e) => setHideBots(e.target.checked)} /> Hide bots
        </label>
        <div className="seg" role="group" aria-label="Sort">
          {[['score', 'Score'], ['roi', 'ROI'], ['pnl', 'PnL']].map(([k, l]) => (
            <button key={k} aria-pressed={sort === k} onClick={() => setSort(k)}>{l}</button>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Wallet</th>
                <th>Tier</th>
                <th className="num">ROI</th>
                <th className="num">PnL</th>
                <th className="num">Deployed</th>
                <th className="num">Tokens</th>
                <th className="num">Win rate</th>
                <th className="num">Med. hold</th>
                <th>Score</th>
                <th>Flags</th>
                <th title="Buys from this wallet trigger alerts">Alerts</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={13} className="muted" style={{ textAlign: 'center', padding: 30 }}>No wallets match yet. On live data the app builds its own trade history from the moment it starts, so rankings need a few hours of trades (60 days of history needs the Dune backfill, see the README). Lower “Min score” to see early wallets.</td></tr>
              )}
              {rows.map((t, i) => (
                <tr key={`${t.chain}:${t.wallet}`} className="clickable" onClick={() => onWallet(t.chain, t.wallet)}>
                  <td className="muted mono">{i + 1}</td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <i className="swatch" style={{ background: chainColor(t.chain), borderRadius: '50%' }} title={t.chain} />
                      <span>
                        {t.label && <div style={{ fontWeight: 600 }}>{t.label}</div>}
                        <div className="mono secondary" style={{ fontSize: 12 }}>{shortAddr(t.wallet)}</div>
                      </span>
                    </span>
                  </td>
                  <td><TierLabel tier={t.tier} /></td>
                  <td className={`num ${t.roi >= 0 ? 'up' : 'down'}`}>{pct(t.roi, 0)}</td>
                  <td className="num">{usd(t.pnlUsd)}</td>
                  <td className="num">{usd(t.investedUsd)}</td>
                  <td className="num">{t.tokens || '—'}</td>
                  <td className="num">{t.tokens ? `${Math.round(t.winRate * 100)}%` : '—'}</td>
                  <td className="num">{t.medianHoldMin !== null ? age(t.medianHoldMin * 60_000) : '—'}</td>
                  <td><Score v={t.legitScore} /></td>
                  <td>{t.flags.map((f) => <span key={f} className={`flag ${BAD.has(f) ? 'bad' : ''}`} title={FLAG_INFO[f]}>{f}</span>)}</td>
                  <td>{t.qualifies ? <span title="Qualifies for alerts">🔔</span> : <span className="muted">—</span>}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn small" onClick={() => void watch(t)}>{t.watched ? 'Unwatch' : 'Watch'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <form className="card card-body" style={{ marginTop: 16, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }} onSubmit={add}>
        <b>Add a wallet to watch</b>
        <select value={addChain} onChange={(e) => setAddChain(e.target.value)}>
          {chains.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="text" placeholder="Wallet address" value={addWallet} onChange={(e) => setAddWallet(e.target.value)} style={{ flex: '1 1 280px' }} className="mono" />
        <input type="text" placeholder="Label (optional)" value={addLabel} onChange={(e) => setAddLabel(e.target.value)} />
        <button className="btn primary" disabled={addWallet.trim().length < 20}>Watch</button>
        {err && <span className="down">{err}</span>}
        <span className="note" style={{ flexBasis: '100%' }}>Watched wallets always raise alerts on new-pair buys (toggle on the Alerts tab), whatever their score.</span>
      </form>
    </div>
  );
}

export function WalletDrawer({ chain, wallet, onClose }: { chain: string; wallet: string; onClose: () => void }) {
  const { data, reload } = usePoll(() => api.wallet(chain, wallet), [chain, wallet], 30_000);
  const s = data?.stats;
  const toggle = async () => {
    await (s?.watched ? api.unwatch(chain, wallet) : api.watch(chain, wallet, s?.label));
    void reload();
  };
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" aria-label="Wallet details">
        <div className="drawer-head">
          <i className="swatch" style={{ background: chainColor(chain), width: 14, height: 14, borderRadius: '50%' }} />
          <div style={{ minWidth: 0 }}>
            <h2>{s?.label ?? shortAddr(wallet)}</h2>
            <div className="mono muted" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{wallet}</div>
          </div>
          <div className="spacer" />
          <button className="btn small" onClick={() => void toggle()}>{s?.watched ? 'Unwatch' : 'Watch'}</button>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="drawer-body">
          {!data && <div className="muted">Loading…</div>}
          {s && (
            <div className="kpis" style={{ marginBottom: 0 }}>
              <div className="card kpi"><div className="label">ROI</div><div className={`value ${s.roi >= 0 ? 'up' : 'down'}`}>{pct(s.roi, 0)}</div><div className="sub">{s.source}</div></div>
              <div className="card kpi"><div className="label">PnL</div><div className="value">{usd(s.pnlUsd)}</div><div className="sub">{usd(s.realizedUsd)} realized</div></div>
              <div className="card kpi"><div className="label">Win rate</div><div className="value">{s.tokens ? `${Math.round(s.winRate * 100)}%` : '—'}</div><div className="sub">{s.wins}/{s.tokens} tokens</div></div>
              <div className="card kpi"><div className="label">Legit score</div><div className="value">{s.legitScore}</div><div className="sub"><TierLabel tier={s.tier} /></div></div>
            </div>
          )}
          {s && s.flags.length > 0 && (
            <div>{s.flags.map((f) => <div key={f} className="note"><span className={`flag ${BAD.has(f) ? 'bad' : ''}`}>{f}</span> {FLAG_INFO[f]}</div>)}</div>
          )}
          {data && (
            <div className="card">
              <div className="card-head"><h3>Positions</h3></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Token</th><th className="num">Deployed</th><th className="num">Realized</th><th className="num">Unrealized</th><th className="num">Trades</th><th className="num">Last</th></tr></thead>
                  <tbody>
                    {data.positions.length === 0 && <tr><td colSpan={6} className="muted">No trades recorded in the window.</td></tr>}
                    {data.positions.map((p) => (
                      <tr key={p.token}>
                        <td><b>{p.symbol}</b> <span className="mono muted" style={{ fontSize: 11 }}>{shortAddr(p.token)}</span></td>
                        <td className="num">{usd(p.investedUsd)}</td>
                        <td className={`num ${p.realizedUsd >= 0 ? 'up' : 'down'}`}>{usd(p.realizedUsd)}</td>
                        <td className={`num ${p.unrealizedUsd >= 0 ? 'up' : 'down'}`}>{p.openQty > 0 ? usd(p.unrealizedUsd) : '—'}</td>
                        <td className="num">{p.trades}</td>
                        <td className="num muted">{timeAgo(p.lastTrade)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {data && data.recent.length > 0 && (
            <div className="card">
              <div className="card-head"><h3>Recent trades</h3></div>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {data.recent.map((t) => (
                      <tr key={`${t.tx}-${t.kind}`}>
                        <td className={t.kind === 'buy' ? 'up' : 'down'} style={{ fontWeight: 600 }}>{t.kind === 'buy' ? 'Buy' : 'Sell'}</td>
                        <td>{t.symbol}</td>
                        <td className="num">{usd(t.usd)}</td>
                        <td className="num muted">{timeAgo(t.ts)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
