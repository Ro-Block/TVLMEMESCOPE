import { useEffect, useState } from 'react';
import type { Alert, AlertSettings, MemeChain, StatusResponse } from '../../../shared/types.ts';
import { LaunchpadTag, TokenAvatar } from '../components/TokenAvatar.tsx';
import { api } from '../lib/api.ts';
import { chainColor } from '../lib/colors.ts';
import { age, pct, shortAddr, timeAgo, usd } from '../lib/format.ts';
import { useNow } from '../lib/hooks.ts';

interface Props {
  alerts: Alert[];
  chains: MemeChain[];
  status: StatusResponse | null;
  sound: boolean;
  setSound: (v: boolean) => void;
  onWallet: (chain: string, wallet: string) => void;
}

export function AlertsPage({ alerts, chains, status, sound, setSound, onWallet }: Props) {
  useNow(15_000);
  const [st, setSt] = useState<AlertSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'denied');
  const [kind, setKind] = useState<'all' | Alert['kind']>('all');

  useEffect(() => void api.settings().then(setSt), []);

  const save = async (next: AlertSettings) => {
    setSt(next);
    setSt(await api.saveSettings(next));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  const numField = (k: keyof AlertSettings, label: string, hint: string, scale = 1, step = 1) =>
    st && (
      <>
        <label htmlFor={k}>
          {label}
          <div className="note">{hint}</div>
        </label>
        <input id={k} type="number" step={step} value={Math.round(((st[k] as number) * scale) * 100) / 100} onChange={(e) => setSt({ ...st, [k]: +e.target.value / scale })} onBlur={() => void save(st)} />
      </>
    );

  const shown = alerts.filter((a) => kind === 'all' || a.kind === kind);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Whale alerts</h1>
          <p>Fires when a qualifying wallet buys a pair younger than your age limit, and when several of them pile into the same pair within a short window.</p>
        </div>
      </div>
      <div className="flows-grid">
        <div className="card">
          <div className="col-head">
            <h2>Feed</h2>
            <div className="spacer" />
            <div className="seg" role="group" aria-label="Alert type">
              {(['all', 'whale_buy', 'cluster', 'ring'] as const).map((k) => (
                <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === 'all' ? 'All' : k === 'whale_buy' ? 'Whale buys' : k === 'cluster' ? 'Clusters' : 'Sniper rings'}</button>
              ))}
            </div>
          </div>
          {shown.length === 0 && <div className="empty">No alerts yet. They appear here live as the scanner finds qualifying buys.</div>}
          {shown.map((a) => (
            <div key={a.id} className="alert-item">
              <div className="ico" aria-hidden>{a.kind === 'ring' ? '🎯' : a.kind === 'cluster' ? '🚨' : a.wallets[0]?.tier === 'whale' ? '🐋' : '🧠'}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <b>{a.kind === 'ring' ? `${a.wallets.length} ring wallets` : a.kind === 'cluster' ? `${a.wallets.length} smart wallets` : a.wallets[0]?.label ?? shortAddr(a.wallets[0]?.wallet ?? '')}</b>
                  <span className="secondary">bought</span>
                  <TokenAvatar symbol={a.pair.symbol} imageUrl={a.pair.imageUrl} chain={a.chain} size={22} />
                  <b>{a.pair.symbol}</b>
                  <LaunchpadTag name={a.pair.launchpad} />
                  <span className="badge" style={{ gap: 6 }}><i className="swatch" style={{ background: chainColor(a.chain), borderRadius: '50%' }} />{a.chain}</span>
                </div>
                <div className="pair-stats">
                  <span>Size <b>{usd(a.usd)}</b></span>
                  <span>Pair age <b>{age(a.pair.ageMin * 60_000)}</b></span>
                  <span>MC <b>{usd(a.pair.mcap)}</b></span>
                  <span>Liq <b>{usd(a.pair.liquidity)}</b></span>
                </div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                  {a.wallets.slice(0, 6).map((w) => (
                    <button key={w.wallet} className="wtag" onClick={() => onWallet(a.chain, w.wallet)}>
                      {w.label ?? shortAddr(w.wallet)} · {usd(w.usd, 0)} · ROI {pct(w.roi, 0)} · {w.legitScore}
                    </button>
                  ))}
                </div>
              </div>
              <div className="pair-right">
                <div className="muted">{timeAgo(a.ts)}</div>
                {a.pair.url && <a href={a.pair.url} target="_blank" rel="noreferrer">chart ↗</a>}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 16, alignContent: 'start' }}>
          <div className="card">
            <div className="card-head"><h2>Delivery</h2></div>
            <div className="card-body" style={{ display: 'grid', gap: 10 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>Browser notifications</span>
                <div className="spacer" />
                {perm === 'granted' ? <span className="badge live">On</span> : (
                  <button className="btn small" onClick={() => void Notification.requestPermission().then(setPerm)} disabled={perm === 'denied'}>
                    {perm === 'denied' ? 'Blocked in browser' : 'Enable'}
                  </button>
                )}
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span>Sound</span><div className="spacer" /><input type="checkbox" checked={sound} onChange={(e) => setSound(e.target.checked)} />
              </label>
              {st && (
                <>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>Telegram {status?.notify.telegram ? '' : <span className="note">(set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)</span>}</span>
                    <div className="spacer" />
                    <input type="checkbox" disabled={!status?.notify.telegram} checked={st.telegram && !!status?.notify.telegram} onChange={(e) => void save({ ...st, telegram: e.target.checked })} />
                  </label>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span>Discord {status?.notify.discord ? '' : <span className="note">(set DISCORD_WEBHOOK_URL)</span>}</span>
                    <div className="spacer" />
                    <input type="checkbox" disabled={!status?.notify.discord} checked={st.discord && !!status?.notify.discord} onChange={(e) => void save({ ...st, discord: e.target.checked })} />
                  </label>
                </>
              )}
              <button className="btn" onClick={() => void api.testAlert()}>Send test alert</button>
            </div>
          </div>

          {st && (
            <div className="card">
              <div className="card-head"><h2>Rules</h2><div className="spacer" />{saved && <span className="badge live">Saved</span>}</div>
              <div className="card-body">
                <div className="filters" style={{ marginBottom: 14 }}>
                  {chains.map((c) => (
                    <button key={c.id} className="chip" aria-pressed={st.chains.includes(c.id)} onClick={() => void save({ ...st, chains: st.chains.includes(c.id) ? st.chains.filter((x) => x !== c.id) : [...st.chains, c.id] })}>
                      <i className="swatch" style={{ background: chainColor(c.id), borderRadius: '50%' }} />
                      {c.name}
                    </button>
                  ))}
                </div>
                <div className="form-grid">
                  {numField('minBuyUsd', 'Min buy size (USD)', 'Ignore buys smaller than this')}
                  {numField('maxPairAgeHours', 'Max pair age (hours)', 'Only new pairs count')}
                  {numField('minRoi', `Min ${status?.roiWindowDays ?? 60}d ROI (%)`, '100 = the wallet doubled its money', 100, 10)}
                  {numField('minLegitScore', 'Min legit score', '0–100; 65+ filters most noise')}
                  {numField('minTokens', 'Min tokens traded', 'Sample size in the window')}
                  {numField('clusterSize', 'Cluster size', 'Qualifying wallets in one pair')}
                  {numField('clusterWindowMin', 'Cluster window (min)', 'How close together the buys must be')}
                  {numField('sniperWindowSec', 'Sniper window (seconds)', 'Buys this soon after pair creation count as snipes', 1, 0.5)}
                  <label htmlFor="xs">Exclude snipers from smart money<div className="note">Wallets that usually buy in the first seconds never count as smart money</div></label>
                  <input id="xs" type="checkbox" checked={st.excludeSnipers} onChange={(e) => void save({ ...st, excludeSnipers: e.target.checked })} />
                  <label htmlFor="ra">Sniper ring alerts<div className="note">Linked sniper wallets hitting the same new pair</div></label>
                  <input id="ra" type="checkbox" checked={st.ringAlerts} onChange={(e) => void save({ ...st, ringAlerts: e.target.checked })} />
                  {numField('ringMinMembers', 'Ring members to alert', 'How many ring wallets must snipe the pair')}
                  <label htmlFor="wl">Always alert on watchlist<div className="note">Ignore score and ROI for wallets you watch</div></label>
                  <input id="wl" type="checkbox" checked={st.includeWatchlist} onChange={(e) => void save({ ...st, includeWatchlist: e.target.checked })} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
