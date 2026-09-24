import { Fragment, useEffect, useMemo, useState } from 'react';
import type { AlertSettings, Launch, MemeChain, RingIntention, SniperRing } from '../../../shared/types.ts';
import { LaserArena, type ShooterGroup } from '../components/LaserArena.tsx';
import { LaunchpadTag, TokenAvatar } from '../components/TokenAvatar.tsx';
import { api } from '../lib/api.ts';
import { chainColor } from '../lib/colors.ts';
import { age, pct, shortAddr, usd } from '../lib/format.ts';
import { useNow, usePoll, useStored } from '../lib/hooks.ts';
import { useShots } from '../lib/shots.ts';

// Categorical slots in fixed order; a ring keeps its colour by its (stable) id order.
const RING_COLORS = ['var(--eco-ethereum)', 'var(--eco-solana)', 'var(--eco-hyperliquid)', 'var(--eco-bnb)', 'var(--eco-base)', 'var(--eco-robinhood)'];
const WINDOWS = [1, 2, 3, 5];

const INTENT: Record<RingIntention, { label: string; cls: string; hint: string }> = {
  'coordinated-dump': { label: '▼ Dumps together', cls: 'dump', hint: 'Members sell within ~3 min of each other on most shared launches: likely one operator or a bundle farming exits.' },
  'coordinated-hold': { label: '◆ Holds together', cls: 'hold', hint: 'Members keep their bags past the first hour together: often insiders or dev-linked wallets positioning.' },
  mixed: { label: '◇ Mixed exits', cls: '', hint: 'They enter together but exit independently: shared tooling or copy-trading rather than one operator.' },
};

/** Matches `J7…` (prefix), `…pump` (suffix) or any substring of the token / pair address. */
function addrMatch(filter: string, ...addrs: string[]) {
  const f = filter.trim();
  if (!f) return true;
  const lower = f.toLowerCase().replace(/…|\.\.\./g, '*');
  return addrs.some((a) => {
    const x = a.toLowerCase();
    if (lower.endsWith('*')) return x.startsWith(lower.slice(0, -1));
    if (lower.startsWith('*')) return x.endsWith(lower.slice(1));
    return x.startsWith(lower) || x.endsWith(lower) || x.includes(lower);
  });
}

export function SnipersPage({ chains, source, onWallet }: { chains: MemeChain[]; source: string; onWallet: (chain: string, wallet: string) => void }) {
  const [sel, setSel] = useStored<string[]>('snipers.chains', []);
  const [dex, setDex] = useStored('snipers.dex', '');
  const [addr, setAddr] = useStored('snipers.addr', '');
  const [intent, setIntent] = useStored<'' | RingIntention>('snipers.intent', '');
  const [focus, setFocus] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const { data, reload } = usePoll(() => api.snipers(sel), [sel.join(',')], 15_000);
  const allShots = useShots();
  const now = useNow(5_000);

  useEffect(() => void api.settings().then(setSettings), []);
  const setWindow = async (w: number) => {
    if (!settings) return;
    setSettings(await api.saveSettings({ ...settings, sniperWindowSec: w }));
    void reload();
  };

  const ringColor = useMemo(() => {
    const ids = [...(data?.rings ?? [])].map((r) => r.id).sort();
    return (id?: string) => (id && ids.includes(id) ? RING_COLORS[ids.indexOf(id) % RING_COLORS.length] : 'var(--text-muted)');
  }, [data]);
  const ringById = useMemo(() => new Map((data?.rings ?? []).map((r) => [r.id, r])), [data]);

  const launchOk = (l: Launch) =>
    (!dex || l.pair.dex === dex) && addrMatch(addr, l.pair.baseAddress, l.pair.address) && (!intent || l.ringIds.some((id) => ringById.get(id)?.intention === intent));
  const launches = (data?.launches ?? []).filter(launchOk);
  const rings = (data?.rings ?? []).filter((r) => !intent || r.intention === intent);
  const dexes = [...new Set((data?.launches ?? []).map((l) => l.pair.dex))].sort();

  const shots = allShots.filter(
    (s) =>
      (!sel.length || sel.includes(s.chain)) &&
      (!dex || s.dex === dex) &&
      addrMatch(addr, s.token, s.pairId.slice(s.pairId.indexOf(':') + 1)) &&
      (!intent || (s.ringId && ringById.get(s.ringId)?.intention === intent)),
  );

  const groups: ShooterGroup[] = useMemo(() => {
    // The most recently active rings get a seat in the arena.
    const g: ShooterGroup[] = [...rings].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 6).map((r) => ({
      id: r.id,
      title: `${r.name} · ${r.chain}`,
      subtitle: `${r.members.length} wallets`,
      chain: r.chain,
      color: ringColor(r.id),
      intention: r.intention,
      wallets: r.members.map((m) => ({ chain: r.chain, wallet: m })),
    }));
    const solo = (data?.profiles ?? []).filter((p) => !p.ringId).slice(0, 12);
    if (solo.length) g.push({ id: 'solo', title: 'Solo snipers', subtitle: '', color: 'var(--eco-other)', wallets: solo.map((p) => ({ chain: p.chain, wallet: p.wallet, label: p.label })) });
    const watch = (data?.watchlist ?? []).slice(0, 12);
    if (watch.length) g.push({ id: 'watch', title: 'Watchlist · all buys', subtitle: '', color: 'var(--text-primary)', wallets: watch });
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, intent]);

  const perMin = allShots.filter((s) => s.arrived && now - s.arrived < 60_000).length;
  const bundledLaunches = launches.filter((l) => l.bundled > 0).length;
  const dumped = launches.filter((l) => l.dumped).length;
  const toggle = (id: string) => setSel(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
  const watchRing = async (r: SniperRing) => {
    await api.watchMany(r.chain, r.members, r.name);
    void reload();
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Sniper radar</h1>
          <p>
            Wallets that buy within {data?.windowSec ?? 3}s of a pair going live, bundles (several wallets landing in the same block), and rings of wallets that keep sniping the same launches together, with how
            they exit. Each laser is a live buy; red beams back are sells.
          </p>
        </div>
        <div className="spacer" />
        <span className={`badge ${source}`}>{source === 'live' ? 'Live · GeckoTerminal' : 'Simulated market'}</span>
      </div>

      <div className="filters">
        {chains.map((c) => (
          <button key={c.id} className="chip" aria-pressed={sel.includes(c.id)} onClick={() => toggle(c.id)}>
            <i className="swatch" style={{ background: chainColor(c.id), borderRadius: '50%' }} />
            {c.name}
          </button>
        ))}
        <div className="spacer" />
        <div className="seg" role="group" aria-label="Sniper window">
          {WINDOWS.map((w) => (
            <button key={w} aria-pressed={settings?.sniperWindowSec === w} onClick={() => void setWindow(w)} title={`Buys within ${w}s of creation count as snipes`}>
              ≤{w}s
            </button>
          ))}
        </div>
      </div>
      <div className="filters">
        <label className="secondary" style={{ fontSize: 13 }}>
          Launchpad / DEX{' '}
          <select value={dex} onChange={(e) => setDex(e.target.value)}>
            <option value="">All</option>
            {dexes.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="secondary" style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          Token address
          <input type="text" className="mono" placeholder="J7…  or  …pump" value={addr} onChange={(e) => setAddr(e.target.value)} style={{ width: 170 }} />
        </label>
        <div className="seg" role="group" aria-label="Ring intention">
          {([['', 'All rings'], ['coordinated-dump', 'Dump'], ['coordinated-hold', 'Hold'], ['mixed', 'Mixed']] as const).map(([k, l]) => (
            <button key={k} aria-pressed={intent === k} onClick={() => setIntent(k)}>{l}</button>
          ))}
        </div>
        {(dex || addr || intent) && <button className="btn small" onClick={() => (setDex(''), setAddr(''), setIntent(''))}>Clear</button>}
      </div>

      <div className="kpis">
        <div className="card kpi"><div className="label">Launches sniped</div><div className="value">{launches.length}</div><div className="sub">last 30 days, in view</div></div>
        <div className="card kpi"><div className="label">Bundled launches</div><div className="value">{launches.length ? pct(bundledLaunches / launches.length, 0).replace('+', '') : '—'}</div><div className="sub">2+ snipers in one block</div></div>
        <div className="card kpi"><div className="label">Snipers dumped</div><div className="value">{launches.length ? pct(dumped / launches.length, 0).replace('+', '') : '—'}</div><div className="sub">most sniper $ out in 10 min</div></div>
        <div className="card kpi"><div className="label">Linked rings</div><div className="value">{rings.length}</div><div className="sub">{(data?.links.length ?? 0).toLocaleString()} wallet links</div></div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Laser view</h2>
          <div className="hud">
            <span><span className="live-dot" /> Live</span>
            <span><b>{perMin}</b> shots / min</span>
            <span><b>{shots.length}</b> in buffer</span>
            {focus && (
              <button className="btn small" onClick={() => setFocus(null)}>
                Focused: {ringById.get(focus)?.name ?? focus} ✕
              </button>
            )}
          </div>
          <div className="spacer" />
          <div className="legend">
            <span><i className="swatch" style={{ background: 'var(--eco-ethereum)', width: 18, height: 3 }} /> Buy (ring colour)</span>
            <span><i className="swatch" style={{ background: 'var(--flow-out)', width: 18, height: 3 }} /> Sell</span>
          </div>
        </div>
        <div className="card-body">
          <LaserArena groups={groups} shots={shots} focus={focus} onWallet={onWallet} />
          <p className="note">Left: rings, solo snipers and your watchlist. Right: the pairs they're hitting, with how many snipe buys each took and the in/out split. Click a wallet for its trades, or a ring below to focus it.</p>
        </div>
      </div>

      <div className="flows-grid">
        <div className="card">
          <div className="card-head"><h2>Recent sniped launches</h2><span className="note">click a row for the opening buys</span></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Token</th><th className="num">Age</th><th className="num">Snipers</th><th className="num">Bundled</th><th className="num">Sniper share</th><th>Rings</th><th>Outcome</th></tr>
              </thead>
              <tbody>
                {launches.length === 0 && <tr><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 24 }}>No sniped launches match these filters.</td></tr>}
                {launches.slice(0, 60).map((l) => (
                  <Fragment key={l.pair.id}>
                    <tr className="clickable" aria-selected={open === l.pair.id} onClick={() => setOpen(open === l.pair.id ? null : l.pair.id)}>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                          <TokenAvatar symbol={l.pair.baseSymbol} imageUrl={l.pair.imageUrl} fallbackUrl={l.pair.imageFallbackUrl} chain={l.pair.chain} size={30} />
                          <span>
                            <b>{l.pair.baseSymbol}</b> <span className="muted">{l.pair.dex}</span> <LaunchpadTag name={l.pair.launchpad} />
                            <div className="mono muted" style={{ fontSize: 11 }}>{shortAddr(l.pair.baseAddress)}</div>
                          </span>
                        </span>
                      </td>
                      <td className="num">{age(now - l.pair.createdAt)}</td>
                      <td className="num">{l.snipers}</td>
                      <td className="num">{l.bundled || '—'}</td>
                      <td className="num">
                        <span className="meter" style={{ justifyContent: 'flex-end' }}>
                          <span className="meter-bar"><i style={{ width: `${l.share * 100}%`, background: l.share > 0.5 ? 'var(--flow-out)' : 'var(--accent)' }} /></span>
                          <span className="mono">{Math.round(l.share * 100)}%</span>
                        </span>
                      </td>
                      <td>
                        {l.ringIds.map((id) => (
                          <span key={id} className="snipe-tag" style={{ marginRight: 3 }}>
                            <i className="swatch" style={{ background: ringColor(id), borderRadius: '50%' }} />
                            {ringById.get(id)?.name ?? 'ring'}
                          </span>
                        ))}
                      </td>
                      <td>{l.dumped ? <span className="intent dump">▼ Dumped</span> : <span className="intent">Holding</span>}</td>
                    </tr>
                    {open === l.pair.id && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
                          <table>
                            <thead><tr><th>Wallet</th><th className="num">Delay</th><th className="num">Block</th><th className="num">Size</th><th>Bundle</th><th>Ring</th><th className="num">Sold 1h</th><th className="num">Exit</th></tr></thead>
                            <tbody>
                              {l.buys.map((b) => (
                                <tr key={b.wallet} className="clickable" onClick={() => onWallet(l.pair.chain, b.wallet)}>
                                  <td className="mono">{shortAddr(b.wallet)}</td>
                                  <td className="num">{b.delaySec.toFixed(1)}s</td>
                                  <td className="num muted">{b.block ?? '—'}</td>
                                  <td className="num">{usd(b.usd)}</td>
                                  <td>{b.bundled ? '⛓ same block' : '—'}</td>
                                  <td>{b.ringId ? ringById.get(b.ringId)?.name : '—'}</td>
                                  <td className="num">{Math.round(b.soldPct * 100)}%</td>
                                  <td className="num">{b.exitMin !== null ? age(b.exitMin * 60_000) : 'holding'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head"><h2>Linked rings</h2><span className="note">wallets that snipe together far more often than chance</span></div>
          <div className="card-body ring-cards">
            {rings.length === 0 && <div className="muted">No rings detected yet. A ring needs 3+ shared launches.</div>}
            {rings.map((r) => (
              <div key={r.id} className="ring-card" aria-pressed={focus === r.id}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <i className="swatch" style={{ background: ringColor(r.id), width: 12, height: 12, borderRadius: '50%' }} />
                  <b>{r.name}</b>
                  <span className="muted">{r.chain}</span>
                  <span className={`intent ${INTENT[r.intention].cls}`} title={INTENT[r.intention].hint}>{INTENT[r.intention].label}</span>
                  <div className="spacer" />
                  <button className="btn small" onClick={() => setFocus(focus === r.id ? null : r.id)}>{focus === r.id ? 'Unfocus' : 'Focus'}</button>
                  <button className="btn small" onClick={() => void watchRing(r)}>Watch all</button>
                </div>
                <div className="ring-stats">
                  <span><b>{r.members.length}</b> wallets</span>
                  <span><b>{r.sharedLaunches}</b> launches together</span>
                  <span>same block <b>{Math.round(r.sameBlockRate * 100)}%</b></span>
                  <span>cohesion <b>{Math.round(r.cohesion * 100)}%</b></span>
                  <span>exit spread <b>{r.medianExitSpreadMin !== null ? age(r.medianExitSpreadMin * 60_000) : '—'}</b></span>
                  <span>PnL <b>{usd(r.pnlUsd)}</b></span>
                  <span>last <b>{age(now - r.lastSeen)}</b> ago</span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {r.members.map((m) => <button key={m} className="wtag" onClick={() => onWallet(r.chain, m)}>{shortAddr(m)}</button>)}
                </div>
                <div className="note">Recent: {r.recent.slice(0, 6).map((x) => x.symbol).join(', ')}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>Sniper wallets</h2><span className="note">sniped 2+ launches in the window</span></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Wallet</th><th>Ring</th><th className="num">Launches</th><th className="num">Med. delay</th><th className="num">Bundled</th><th className="num">Dumps &lt;10m</th><th className="num">Med. exit</th><th className="num">Avg size</th><th className="num">ROI</th><th /></tr>
            </thead>
            <tbody>
              {(data?.profiles ?? []).filter((p) => !intent || (p.ringId && ringById.get(p.ringId)?.intention === intent)).slice(0, 80).map((p) => (
                <tr key={`${p.chain}:${p.wallet}`} className="clickable" onClick={() => onWallet(p.chain, p.wallet)}>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                      <i className="swatch" style={{ background: chainColor(p.chain), borderRadius: '50%' }} />
                      <span className="mono">{p.label ?? shortAddr(p.wallet)}</span>
                    </span>
                  </td>
                  <td>{p.ringId ? <span className="snipe-tag"><i className="swatch" style={{ background: ringColor(p.ringId), borderRadius: '50%' }} />{ringById.get(p.ringId)?.name}</span> : <span className="muted">solo</span>}</td>
                  <td className="num">{p.launches}</td>
                  <td className="num">{p.medianDelaySec.toFixed(1)}s</td>
                  <td className="num">{Math.round(p.bundleRate * 100)}%</td>
                  <td className="num">{Math.round(p.dumpRate * 100)}%</td>
                  <td className="num">{p.medianExitMin !== null ? age(p.medianExitMin * 60_000) : '—'}</td>
                  <td className="num">{usd(p.avgUsd)}</td>
                  <td className={`num ${p.roi !== null && p.roi >= 0 ? 'up' : 'down'}`}>{p.roi !== null ? pct(p.roi, 0) : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button className="btn small" onClick={() => void (p.watched ? api.unwatch(p.chain, p.wallet) : api.watch(p.chain, p.wallet)).then(reload)}>{p.watched ? 'Unwatch' : 'Watch'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
