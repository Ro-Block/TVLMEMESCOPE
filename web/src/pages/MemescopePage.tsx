import { useMemo, useRef } from 'react';
import type { MemeChain, Pair } from '../../../shared/types.ts';
import { api } from '../lib/api.ts';
import { chainColor } from '../lib/colors.ts';
import { age, pct, price, shortAddr, usd } from '../lib/format.ts';
import { useNow, usePoll, useStored } from '../lib/hooks.ts';

const AGES = [1, 6, 24];

export function MemescopePage({ chains, source, onWallet }: { chains: MemeChain[]; source: string; onWallet: (chain: string, wallet: string) => void }) {
  const [sel, setSel] = useStored<string[]>('scope.chains', chains.map((c) => c.id));
  const [maxAge, setMaxAge] = useStored<number>('scope.maxAge', 24);
  const [minLiq, setMinLiq] = useStored<number>('scope.minLiq', 0);
  const [hideSniped, setHideSniped] = useStored('scope.hideSniped', false);
  const active = sel.filter((s) => chains.some((c) => c.id === s));
  const { data } = usePoll(() => api.pairs(active, maxAge), [active.join(','), maxAge], 8_000);
  const now = useNow(1_000);
  const seen = useRef(new Set<string>());

  // "Heavily sniped" = snipers took over half the opening buy volume, or a known ring was in.
  const heavy = (p: Pair) => !!p.snipe && (p.snipe.share > 0.5 || p.snipe.rings > 0);
  const pairs = (data ?? []).filter((p) => p.liquidity >= minLiq && (!hideSniped || !heavy(p)));
  const fresh = pairs.filter((p) => now - p.createdAt < 60 * 60_000).sort((a, b) => b.createdAt - a.createdAt);
  const heating = [...pairs].filter((p) => p.volume.h1 > 0).sort((a, b) => b.volume.h1 - a.volume.h1).slice(0, 40);
  const smart = pairs
    .filter((p) => p.smartWallets.length)
    .sort((a, b) => b.smartWallets.length - a.smartWallets.length || sumUsd(b) - sumUsd(a))
    .slice(0, 40);

  const toggle = (id: string) => setSel(sel.includes(id) ? sel.filter((s) => s !== id) : [...sel, id]);
  // Pairs that appeared since the previous poll get a one-off highlight.
  const newIds = useMemo(() => {
    const prev = seen.current;
    const ids = (data ?? []).map((p) => p.id);
    const added = prev.size ? new Set(ids.filter((i) => !prev.has(i))) : new Set<string>();
    seen.current = new Set([...prev, ...ids]);
    return added;
  }, [data]);
  const isNew = (id: string) => newIds.has(id);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Memescope</h1>
          <p>New pairs across Solana, Base, Robinhood, BNB and HyperEVM. The smart money column shows pairs bought by wallets that pass your ROI and legitimacy filters.</p>
        </div>
        <div className="spacer" />
        <span className={`badge ${source}`}>{source === 'live' ? 'Live · GeckoTerminal' : 'Simulated market'}</span>
      </div>

      <div className="filters">
        {chains.map((c) => (
          <button key={c.id} className="chip" aria-pressed={active.includes(c.id)} onClick={() => toggle(c.id)}>
            <i className="swatch" style={{ background: chainColor(c.id), borderRadius: '50%' }} />
            {c.name}
          </button>
        ))}
        <div className="spacer" />
        <label className="secondary" style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={hideSniped} onChange={(e) => setHideSniped(e.target.checked)} /> Hide sniped / bundled
        </label>
        <label className="secondary" style={{ fontSize: 13 }}>
          Min liquidity{' '}
          <select value={minLiq} onChange={(e) => setMinLiq(+e.target.value)}>
            {[0, 5_000, 10_000, 25_000, 50_000, 100_000].map((v) => (
              <option key={v} value={v}>{v ? usd(v, 0) : 'Any'}</option>
            ))}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Pair age">
          {AGES.map((a) => (
            <button key={a} aria-pressed={a === maxAge} onClick={() => setMaxAge(a)}>
              ≤{a}h
            </button>
          ))}
        </div>
      </div>

      <div className="scope-cols">
        <Column title="New pairs" hint="created in the last hour" pairs={fresh} now={now} isNew={isNew} onWallet={onWallet} />
        <Column title="Heating up" hint="by 1h volume" pairs={heating} now={now} isNew={isNew} onWallet={onWallet} />
        <Column title="Smart money" hint="bought by qualifying wallets" pairs={smart} now={now} isNew={isNew} onWallet={onWallet} highlight />
      </div>
    </div>
  );
}

const sumUsd = (p: Pair) => p.smartWallets.reduce((s, w) => s + w.usd, 0);

function Column({ title, hint, pairs, now, isNew, onWallet, highlight }: { title: string; hint: string; pairs: Pair[]; now: number; isNew: (id: string) => boolean; onWallet: (c: string, w: string) => void; highlight?: boolean }) {
  return (
    <section className="card">
      <div className="col-head">
        <h2>{title}</h2>
        <span className="note">{hint}</span>
        <div className="spacer" />
        <span className="badge">{pairs.length}</span>
      </div>
      <div className="col-list">
        {pairs.length === 0 && <div className="empty">{highlight ? 'No qualifying wallets have bought yet. Loosen the filters on the Alerts tab.' : 'Nothing yet, waiting for the next scan.'}</div>}
        {pairs.map((p) => (
          <PairRow key={p.id} p={p} now={now} flash={isNew(p.id)} onWallet={onWallet} />
        ))}
      </div>
    </section>
  );
}

function PairRow({ p, now, flash, onWallet }: { p: Pair; now: number; flash: boolean; onWallet: (c: string, w: string) => void }) {
  const ch = p.change.h1;
  return (
    <div className={`pair ${flash ? 'flash' : ''}`}>
      <div className="avatar" style={{ background: `color-mix(in srgb, ${chainColor(p.chain)} 70%, #000)` }} aria-hidden>
        {p.baseSymbol.slice(0, 2)}
        <i className="chain-dot" style={{ background: chainColor(p.chain) }} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="pair-name">
          <b>{p.baseSymbol}</b>
          <span className="muted">/{p.quoteSymbol} · {p.dex}</span>
        </div>
        <div className="pair-stats">
          <span>MC <b>{usd(p.mcap)}</b></span>
          <span>Liq <b>{usd(p.liquidity)}</b></span>
          <span>V1h <b>{usd(p.volume.h1)}</b></span>
          <span>
            <b className="up">{p.txns.h1.buys}</b>/<b className="down">{p.txns.h1.sells}</b>
          </span>
        </div>
        {p.snipe && p.snipe.snipers > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
            <span className={`snipe-tag ${p.snipe.share > 0.5 || p.snipe.rings ? 'heavy' : ''}`} title="Buys within the sniper window of pair creation">
              🎯 {p.snipe.snipers} sniper{p.snipe.snipers > 1 ? 's' : ''} · {Math.round(p.snipe.share * 100)}% of opening buys
            </span>
            {p.snipe.bundled > 0 && <span className="snipe-tag heavy" title="Wallets that landed in the same block">⛓ {p.snipe.bundled} bundled</span>}
            {p.snipe.rings > 0 && <span className="snipe-tag heavy">ring × {p.snipe.rings}</span>}
            {p.snipe.dumped && <span className="snipe-tag heavy">▼ snipers dumped</span>}
          </div>
        )}
        {p.smartWallets.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 5 }}>
            <span className="smart-tag">{p.smartWallets.some((w) => w.tier === 'whale') ? '🐋' : '🧠'} {p.smartWallets.length} smart</span>
            {p.smartWallets.slice(0, 3).map((w) => (
              <button key={w.wallet} className="wtag" onClick={() => onWallet(p.chain, w.wallet)} title={`${w.wallet} bought ${usd(w.usd)}`}>
                {shortAddr(w.wallet)} {usd(w.usd, 0)}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="pair-right">
        <div className="mono">{age(now - p.createdAt)}</div>
        <div className={ch >= 0 ? 'up' : 'down'}>{ch >= 0 ? '▲' : '▼'} {pct(ch, 0)}</div>
        <div className="muted mono">{price(p.priceUsd)}</div>
        {p.url && (
          <a href={p.url} target="_blank" rel="noreferrer" style={{ fontSize: 11 }}>
            chart ↗
          </a>
        )}
      </div>
    </div>
  );
}
