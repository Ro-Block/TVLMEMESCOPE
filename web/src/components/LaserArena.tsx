import { useEffect, useMemo, useRef, useState } from 'react';
import type { RingIntention } from '../../../shared/types.ts';
import { age, shortAddr, usd } from '../lib/format.ts';
import type { LiveShot } from '../lib/shots.ts';
import { TipRows, useTooltip } from './Tooltip.tsx';

export interface ShooterGroup {
  id: string;
  title: string;
  subtitle?: string;
  chain?: string;
  color: string;
  intention?: RingIntention;
  wallets: { chain: string; wallet: string; label?: string }[];
}

interface Props {
  groups: ShooterGroup[];
  shots: LiveShot[];
  focus: string | null;
  onWallet: (chain: string, wallet: string) => void;
}

interface Beam {
  id: string;
  d: string;
  color: string;
  sell: boolean;
  x: number;
  y: number;
}

const W = 1000;
const LEFT = 24;
const COLS = 7;
const STEP = 32;
const GW = COLS * STEP + 12; // group box width
const COL_X = [LEFT, LEFT + GW + 20]; // two columns of groups
const TX = 580; // target column x
const TW = W - TX - 20;
const TH = 50;
const TGAP = 10;
const OTHER = '__other';

export function LaserArena({ groups, shots, focus, onWallet }: Props) {
  const tip = useTooltip();
  const [beams, setBeams] = useState<Beam[]>([]);
  const [firing, setFiring] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // ----- shooter layout (left) -----
  const { nodes, blocks, height } = useMemo(() => {
    const nodes = new Map<string, { x: number; y: number; color: string; group: string; chain: string; wallet: string; label?: string }>();
    const blocks: { g: ShooterGroup; x: number; y: number; h: number }[] = [];
    const colY = [16, 16];
    for (const g of [...groups, { id: OTHER, title: 'Untracked snipers', subtitle: '', color: 'var(--text-muted)', wallets: [] } as ShooterGroup]) {
      const rows = Math.max(1, Math.ceil(g.wallets.length / COLS));
      const h = 26 + rows * STEP;
      const c = colY[0] <= colY[1] ? 0 : 1; // shorter column first
      const x = COL_X[c];
      const y = colY[c];
      blocks.push({ g, x, y, h });
      g.wallets.forEach((w, i) => {
        nodes.set(`${w.chain}:${w.wallet}`, { x: x + 14 + (i % COLS) * STEP, y: y + 34 + Math.floor(i / COLS) * STEP, color: g.color, group: g.id, chain: w.chain, wallet: w.wallet, label: w.label });
      });
      if (g.id === OTHER) nodes.set(OTHER, { x: x + 14, y: y + 34, color: g.color, group: OTHER, chain: '', wallet: '' });
      colY[c] += h + 8;
    }
    return { nodes, blocks, height: Math.max(Math.max(...colY) + 8, 6 * (TH + TGAP) + 30) };
  }, [groups]);

  // ----- targets (right): most recently hit pairs -----
  const maxTargets = Math.floor((height - 30) / (TH + TGAP));
  const targets = useMemo(() => {
    const by = new Map<string, { pairId: string; symbol: string; chain: string; dex: string; last: number; first: number; hits: number; buy: number; sell: number; minDelay: number }>();
    for (const s of shots) {
      const t = by.get(s.pairId) ?? { pairId: s.pairId, symbol: s.symbol, chain: s.chain, dex: s.dex, last: 0, first: s.ts, hits: 0, buy: 0, sell: 0, minDelay: Infinity };
      t.last = Math.max(t.last, s.arrived || s.ts);
      if (s.kind === 'buy') {
        t.hits++;
        t.buy += s.usd;
        t.minDelay = Math.min(t.minDelay, s.delaySec);
      } else t.sell += s.usd;
      by.set(s.pairId, t);
    }
    return [...by.values()].sort((a, b) => b.last - a.last).slice(0, maxTargets);
  }, [shots, maxTargets]);
  const targetY = (pairId: string) => {
    const i = targets.findIndex((t) => t.pairId === pairId);
    return i < 0 ? null : 20 + i * (TH + TGAP) + TH / 2;
  };

  // ----- fire beams for shots that arrived since the last render -----
  useEffect(() => {
    if (!seen.current) {
      seen.current = new Set(shots.map((s) => s.id));
      return;
    }
    const fresh = shots.filter((s) => !seen.current!.has(s.id));
    if (!fresh.length) return;
    const add: Beam[] = [];
    const fire = new Set<string>();
    for (const s of fresh) {
      seen.current.add(s.id);
      const k = `${s.chain}:${s.wallet}`;
      const n = nodes.get(k) ?? nodes.get(OTHER)!;
      const ty = targetY(s.pairId);
      if (ty === null) continue;
      if (focus && n.group !== focus) continue;
      const [x1, y1, x2, y2] = s.kind === 'buy' ? [n.x, n.y, TX, ty] : [TX, ty, n.x, n.y];
      add.push({
        id: s.id,
        d: `M${x1},${y1} C${x1 + (x2 - x1) * 0.45},${y1} ${x1 + (x2 - x1) * 0.55},${y2} ${x2},${y2}`,
        color: s.kind === 'buy' ? n.color : 'var(--flow-out)',
        sell: s.kind === 'sell',
        x: x2,
        y: y2,
      });
      fire.add(nodes.has(k) ? k : OTHER);
    }
    if (!add.length) return;
    setBeams((b) => [...b, ...add].slice(-80));
    setFiring((f) => new Set([...f, ...fire]));
    const ids = new Set(add.map((b) => b.id));
    // Timers must outlive the next burst, so they're only cleared on unmount.
    timers.current.push(
      setTimeout(() => setBeams((bs) => bs.filter((x) => !ids.has(x.id))), 1_500),
      setTimeout(() => setFiring((f) => new Set([...f].filter((x) => !fire.has(x)))), 500),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shots]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);

  const now = Date.now();
  const intentGlyph = (i?: RingIntention) => (i === 'coordinated-dump' ? '▼ dump' : i === 'coordinated-hold' ? '◆ hold' : i === 'mixed' ? '◇ mixed' : '');

  return (
    <svg className="arena" viewBox={`0 0 ${W} ${height}`} role="img" aria-label="Live sniper shots">
      <defs>
        <pattern id="arena-grid" width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="var(--grid)" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x={0} y={0} width={W} height={height} fill="url(#arena-grid)" opacity={0.6} />

      {blocks.map(({ g, x, y, h }) => {
        const dim = focus && focus !== g.id && g.id !== OTHER;
        return (
          <g key={g.id} style={{ opacity: dim ? 0.25 : 1, transition: 'opacity .2s' }}>
            <rect x={x - 8} y={y} width={GW} height={h} rx={10} fill="var(--surface-1)" stroke="var(--border)" />
            <text x={x} y={y + 17} fontSize="12" fontWeight={600} fill="var(--text-primary)">
              {g.title}
            </text>
            <text x={x + GW - 20} y={y + 17} fontSize="11" textAnchor="end" fill="var(--text-secondary)">
              {g.intention ? intentGlyph(g.intention) : g.subtitle}
            </text>
          </g>
        );
      })}

      {[...nodes.entries()].map(([k, n]) => {
        const dim = focus && focus !== n.group && n.group !== OTHER;
        return (
          <g
            key={k}
            className={`shooter ${firing.has(k) ? 'firing' : ''}`}
            style={{ opacity: dim ? 0.25 : 1, cursor: n.wallet ? 'pointer' : 'default' }}
            onClick={() => n.wallet && onWallet(n.chain, n.wallet)}
            onMouseMove={(e) => tip.show(e, n.wallet ? <TipRows title={n.label ?? shortAddr(n.wallet)} rows={[['Wallet', shortAddr(n.wallet)], ['Chain', n.chain]]} /> : <TipRows title="Untracked snipers" rows={[['', 'buys within the window by wallets not yet profiled']]} />)}
            onMouseLeave={tip.hide}
          >
            <circle cx={n.x} cy={n.y} r={13} fill="transparent" />
            <circle className="muzzle" cx={n.x} cy={n.y} r={9} fill={n.color} />
            <circle cx={n.x} cy={n.y} r={9} fill={n.color} stroke="var(--surface-1)" strokeWidth={2} />
          </g>
        );
      })}

      {targets.map((t, i) => {
        const y = 20 + i * (TH + TGAP);
        const tot = t.buy + t.sell || 1;
        const bw = 110;
        return (
          <g key={t.pairId} className="target" style={{ transform: `translateY(${y}px)` }}>
            <rect x={TX} y={0} width={TW} height={TH} rx={10} fill="var(--surface-1)" stroke="var(--border)" />
            <text x={TX + 14} y={20} fontSize="14" fontWeight={700} fill="var(--text-primary)">
              {t.symbol}
            </text>
            <text x={TX + 14} y={38} fontSize="11" fill="var(--text-secondary)">
              {t.chain} · {t.dex} · 1st shot {Number.isFinite(t.minDelay) ? `${t.minDelay.toFixed(1)}s` : '—'} · {age(now - t.first)}
            </text>
            <text x={TX + TW - 12} y={20} fontSize="13" textAnchor="end" fill="var(--text-primary)" fontFamily="var(--mono)">
              ×{t.hits}
            </text>
            <g transform={`translate(${TX + TW - 12 - bw},28)`}>
              <rect width={(bw * t.buy) / tot} height={6} rx={3} fill="var(--flow-in)" />
              {t.sell > 0 && <rect x={(bw * t.buy) / tot + 2} width={Math.max(2, (bw * t.sell) / tot - 2)} height={6} rx={3} fill="var(--flow-out)" />}
            </g>
            <text x={TX + TW - 12} y={45} fontSize="10" textAnchor="end" fill="var(--text-muted)" fontFamily="var(--mono)">
              in {usd(t.buy, 0)} · out {usd(t.sell, 0)}
            </text>
          </g>
        );
      })}

      {beams.map((b) => (
        <g key={b.id} pointerEvents="none">
          <path d={b.d} pathLength={1} className="beam-glow" stroke={b.color} />
          <path d={b.d} pathLength={1} className={`beam ${b.sell ? 'sell' : ''}`} stroke={b.color} />
          <g style={{ transform: `translate(${b.x}px, ${b.y}px)` }}>
            <circle className="impact" r={14} fill="none" stroke={b.color} strokeWidth={2} />
          </g>
        </g>
      ))}
    </svg>
  );
}
