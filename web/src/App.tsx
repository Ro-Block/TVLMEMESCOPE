import { useEffect, useRef, useState } from 'react';
import type { Alert } from '../../shared/types.ts';
import { TooltipProvider } from './components/Tooltip.tsx';
import { api } from './lib/api.ts';
import { usePoll, useStored } from './lib/hooks.ts';
import { AlertsPage } from './pages/AlertsPage.tsx';
import { FlowsPage } from './pages/FlowsPage.tsx';
import { MemescopePage } from './pages/MemescopePage.tsx';
import { SnipersPage } from './pages/SnipersPage.tsx';
import { shotStore } from './lib/shots.ts';
import { flowEventStore } from './lib/flowEvents.ts';
import { isStatic, onStaticAlert, startReplay } from './lib/static.ts';
import { TradersPage, WalletDrawer } from './pages/TradersPage.tsx';

type Tab = 'flows' | 'scope' | 'snipers' | 'traders' | 'alerts';
const TABS: [Tab, string][] = [['flows', 'Flows'], ['scope', 'Memescope'], ['snipers', 'Sniper radar'], ['traders', 'Top traders'], ['alerts', 'Alerts']];
const tabFromHash = (): Tab => (TABS.find(([t]) => `#${t}` === location.hash)?.[0] ?? 'flows');

function beep() {
  try {
    const ctx = new AudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(1320, ctx.currentTime + 0.12);
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.35);
  } catch {
    /* audio blocked until the user interacts */
  }
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [theme, setTheme] = useStored<'system' | 'light' | 'dark'>('theme', 'system');
  const [sound, setSound] = useStored('alerts.sound', true);
  const [wallet, setWallet] = useState<{ chain: string; wallet: string } | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [toasts, setToasts] = useState<Alert[]>([]);
  const [unseen, setUnseen] = useState(0);
  const { data: status } = usePoll(() => api.status(), [], 30_000);
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Live alerts over SSE: feed + toast + browser notification + sound.
  useEffect(() => {
    void api.alerts().then(setAlerts);
    void api.shots().then(shotStore.seed).catch(() => {});
    void api.flowEvents().then(flowEventStore.seed).catch(() => {});
    const onAlert = (a: Alert) => {
      setAlerts((xs) => [a, ...xs.filter((x) => x.id !== a.id)].slice(0, 300));
      setToasts((xs) => [a, ...xs].slice(0, 4));
      setTimeout(() => setToasts((xs) => xs.filter((x) => x.id !== a.id)), 9_000);
      if (tabRef.current !== 'alerts') setUnseen((n) => n + 1);
      if (soundRef.current) beep();
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
        new Notification(a.kind === 'cluster' ? 'Smart money cluster' : a.kind === 'ring' ? 'Sniper ring' : 'Whale buy', { body: a.message, tag: a.id });
      }
    };
    if (isStatic()) {
      const stop = startReplay(shotStore.push, onAlert, flowEventStore.push);
      const off = onStaticAlert(onAlert);
      return () => (stop(), off());
    }
    const es = new EventSource('/api/stream');
    es.addEventListener('shot', (ev) => shotStore.push(JSON.parse((ev as MessageEvent).data)));
    es.addEventListener('flow', (ev) => flowEventStore.push(JSON.parse((ev as MessageEvent).data)));
    es.addEventListener('alert', (ev) => onAlert(JSON.parse((ev as MessageEvent).data) as Alert));
    return () => es.close();
  }, []);

  const go = (t: Tab) => {
    location.hash = t;
    setTab(t);
    if (t === 'alerts') setUnseen(0);
  };
  const openWallet = (chain: string, w: string) => setWallet({ chain, wallet: w });
  const chains = status?.chains ?? [];

  return (
    <TooltipProvider>
      <header className="topbar">
        <div className="brand">
          <svg className="brand-mark" viewBox="0 0 22 22" aria-hidden>
            <circle cx="11" cy="11" r="4" fill="#ffc35e" />
            <ellipse cx="11" cy="11" rx="9.5" ry="9.5" fill="none" stroke="var(--accent)" strokeOpacity=".55" />
            <g className="moon"><circle cx="11" cy="1.5" r="2.2" fill="var(--accent)" /></g>
          </svg>
          TVL Memescope
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" className="tab" aria-selected={tab === t} onClick={() => go(t)}>
              {label}
              {t === 'alerts' && unseen > 0 && <span className="count">{unseen}</span>}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        {isStatic() && <span className="badge demo" title="Recorded from the built-in simulator; run the app locally for live data">Demo snapshot</span>}
        {status && <span className="note mono">{status.ledger.trades.toLocaleString()} trades · {status.ledger.wallets.toLocaleString()} wallets</span>}
        <button className="icon-btn" aria-label="Toggle theme" title={`Theme: ${theme}`} onClick={() => setTheme(theme === 'system' ? 'dark' : theme === 'dark' ? 'light' : 'system')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 3v18" /><path d="M12 3a9 9 0 0 1 0 18" fill="currentColor" /></svg>
        </button>
      </header>

      {tab === 'flows' && <FlowsPage />}
      {tab === 'scope' && status && <MemescopePage chains={chains} source={status.memescope} onWallet={openWallet} />}
      {tab === 'snipers' && status && <SnipersPage chains={chains} source={status.memescope} onWallet={openWallet} />}
      {tab === 'traders' && status && <TradersPage chains={chains} windowDays={status.roiWindowDays} onWallet={openWallet} />}
      {tab === 'alerts' && <AlertsPage alerts={alerts} chains={chains} status={status} sound={sound} setSound={setSound} onWallet={openWallet} />}

      {wallet && <WalletDrawer chain={wallet.chain} wallet={wallet.wallet} onClose={() => setWallet(null)} />}

      <div className="toasts" aria-live="polite">
        {toasts.map((a) => (
          <div key={a.id} className={`toast ${a.kind}`} onClick={() => go('alerts')}>
            {a.message}
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}
