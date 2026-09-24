import { useMemo, useState } from 'react';
import { ECOSYSTEMS, type ChainNode, type Flow } from '../../../shared/types.ts';
import { ecoColor } from '../lib/colors.ts';
import { pct, signedUsd, usd } from '../lib/format.ts';
import { TipRows, useTooltip } from './Tooltip.tsx';

const W = 760;
const H = 620;
const CX = W / 2;
const CY = H / 2;
const R = 220;

interface Props {
  chains: ChainNode[];
  flows: Flow[];
  windowLabel: string;
  selected: string | null;
  onSelect: (id: string) => void;
}

/**
 * Chord-style liquidity map: chains sit on a ring grouped by ecosystem, sized by TVL.
 * Curves are net chain-to-chain flows; the moving dashes travel from source to destination.
 */
export function LiquidityMap({ chains, flows, windowLabel, selected, onSelect }: Props) {
  const tip = useTooltip();
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? selected;

  const layout = useMemo(() => {
    const ordered = [...chains].sort((a, b) => ECOSYSTEMS.indexOf(a.ecosystem) - ECOSYSTEMS.indexOf(b.ecosystem) || b.tvl - a.tvl);
    const maxTvl = Math.max(...chains.map((c) => c.tvl), 1);
    const pos = new Map<string, { x: number; y: number; r: number; a: number; c: ChainNode }>();
    ordered.forEach((c, i) => {
      const a = -Math.PI / 2 + (i / ordered.length) * Math.PI * 2;
      pos.set(c.id, { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a), r: 9 + 30 * Math.sqrt(c.tvl / maxTvl), a, c });
    });
    return pos;
  }, [chains]);

  const maxFlow = Math.max(...flows.map((f) => f.usd), 1);
  const total = chains.reduce((s, c) => s + c.inflow, 0);

  const path = (f: Flow) => {
    const a = layout.get(f.from)!;
    const b = layout.get(f.to)!;
    // Control point pulled toward the centre, like a chord diagram.
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const k = 0.62;
    return `M${a.x},${a.y} Q${mx + (CX - mx) * k},${my + (CY - my) * k} ${b.x},${b.y}`;
  };

  // The strongest routes carry the story; the long tail just adds noise.
  const drawable = flows.filter((f) => layout.has(f.from) && layout.has(f.to));
  const visible = focus ? drawable.filter((f, i) => i < 18 || f.from === focus || f.to === focus) : drawable.slice(0, 18);

  return (
    <div className="map-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Net cross-chain flows over ${windowLabel}`}>
        <circle cx={CX} cy={CY} r={R} fill="none" stroke="var(--grid)" strokeDasharray="2 6" />


        {visible.map((f) => {
          const on = !focus || f.from === focus || f.to === focus;
          const w = 1.5 + 11 * Math.sqrt(f.usd / maxFlow);
          const color = ecoColor(layout.get(f.from)!.c.ecosystem);
          const d = path(f);
          const src = layout.get(f.from)!.c;
          const dst = layout.get(f.to)!.c;
          return (
            <g key={`${f.from}-${f.to}`} style={{ opacity: on ? 1 : 0.07 }}>
              {/* wide invisible hit target */}
              <path
                d={d}
                stroke="transparent"
                strokeWidth={Math.max(w, 12)}
                className="flow-path"
                onMouseMove={(e) => tip.show(e, <TipRows title={`${src.name} → ${dst.name}`} rows={[['Net moved', usd(f.usd)], ['Window', windowLabel]]} />)}
                onMouseLeave={tip.hide}
              />
              <path d={d} stroke={color} strokeOpacity={0.28} strokeWidth={w} className="flow-path" pointerEvents="none" />
              <path d={d} stroke={color} strokeWidth={Math.max(1.5, w * 0.45)} className="flow-dash" style={{ animationDuration: `${2.4 - 1.4 * Math.sqrt(f.usd / maxFlow)}s` }} />
            </g>
          );
        })}

        <rect x={CX - 78} y={CY - 30} width={156} height={60} rx={12} fill="var(--surface-1)" fillOpacity={0.88} pointerEvents="none" />
        <text x={CX} y={CY - 8} textAnchor="middle" fill="var(--text-secondary)" fontSize="12">
          Bridged in, {windowLabel}
        </text>
        <text x={CX} y={CY + 18} textAnchor="middle" fill="var(--text-primary)" fontSize="26" fontWeight="600" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {usd(total)}
        </text>

        {[...layout.values()].map(({ x, y, r, a, c }) => {
          const cos = Math.cos(a);
          const lx = x + (r + 12) * cos;
          const ly = y + (r + 12) * Math.sin(a);
          const anchor = Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end';
          const dy = Math.abs(cos) < 0.3 ? (Math.sin(a) > 0 ? 12 : -18) : -2;
          const dim = focus && focus !== c.id && !visible.some((f) => (f.from === focus && f.to === c.id) || (f.to === focus && f.from === c.id));
          return (
            <g
              key={c.id}
              className="node"
              style={{ opacity: dim ? 0.35 : 1 }}
              onMouseEnter={() => setHover(c.id)}
              onMouseMove={(e) =>
                tip.show(
                  e,
                  <TipRows
                    title={c.name}
                    rows={[
                      ['TVL', usd(c.tvl)],
                      ['7d change', pct(c.tvlChange7d)],
                      [`In (${windowLabel})`, usd(c.inflow)],
                      [`Out (${windowLabel})`, usd(c.outflow)],
                      ['Net', signedUsd(c.net)],
                    ]}
                  />,
                )
              }
              onMouseLeave={() => {
                setHover(null);
                tip.hide();
              }}
              onClick={() => onSelect(c.id)}
            >
              <circle cx={x} cy={y} r={r + 10} fill="transparent" />
              <circle className="body" cx={x} cy={y} r={r} fill={ecoColor(c.ecosystem)} />
              {selected === c.id && <circle cx={x} cy={y} r={r + 5} fill="none" stroke="var(--text-primary)" strokeWidth={2} />}
              <text x={lx} y={ly + dy} textAnchor={anchor}>
                {c.name}
              </text>
              <text className="sub" x={lx} y={ly + dy + 14} textAnchor={anchor}>
                {c.net >= 0 ? '▲' : '▼'} {signedUsd(c.net)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function EcosystemLegend({ present }: { present: Set<string> }) {
  return (
    <div className="legend">
      {ECOSYSTEMS.filter((e) => present.has(e)).map((e) => (
        <span key={e}>
          <i className="swatch" style={{ background: ecoColor(e), borderRadius: '50%' }} />
          {e}
        </span>
      ))}
    </div>
  );
}
