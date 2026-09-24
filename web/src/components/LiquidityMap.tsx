import { useEffect, useMemo, useRef, useState } from 'react';
import { ECOSYSTEMS, type ChainNode, type Flow } from '../../../shared/types.ts';
import { ecoColor } from '../lib/colors.ts';
import { pct, signedUsd, usd } from '../lib/format.ts';
import { mulberry32 } from '../lib/rand.ts';
import { TipRows, useTooltip } from './Tooltip.tsx';

const W = 760;
const H = 620;
const CX = W / 2;
const CY = H / 2 + 6;
const TILT = 0.72; // orbits drawn as ellipses for a bit of depth
const SUN_R = 46;

/** Orbits are TVL classes, so where a planet sits tells you its size class at a glance. */
const ORBITS = [
  { r: 140, label: '> $5B TVL', min: 5e9, period: 260 },
  { r: 215, label: '$1B – $5B', min: 1e9, period: 380 },
  { r: 290, label: '< $1B', min: 0, period: 520 },
];

interface Props {
  chains: ChainNode[];
  flows: Flow[];
  windowLabel: string;
  selected: string | null;
  onSelect: (id: string) => void;
}

interface Planet {
  c: ChainNode;
  orbit: number;
  phase: number;
  r: number;
}

const pos = (p: Planet, t: number) => {
  const o = ORBITS[p.orbit];
  const a = p.phase + (t / o.period) * Math.PI * 2;
  const y = Math.sin(a);
  return { x: CX + o.r * Math.cos(a), y: CY + o.r * TILT * y, depth: y };
};

// Comet arc from one planet to another. It bows outward so it swings around the sun instead of
// crossing it: the curve's midpoint is kept at least CLEAR px from the centre.
const CLEAR = SUN_R + 34;
const arc = (a: { x: number; y: number }, b: { x: number; y: number }) => {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  let vx = mx - CX;
  let vy = my - CY;
  let d = Math.hypot(vx, vy);
  if (d < 1) {
    // Planets on opposite sides: go round via the chord's perpendicular.
    vx = -(b.y - a.y);
    vy = b.x - a.x;
    d = Math.hypot(vx, vy) || 1;
  }
  const reach = Math.max(d + 14, CLEAR);
  const tx = CX + (vx / d) * reach;
  const ty = CY + (vy / d) * reach;
  // For a quadratic Bézier the curve midpoint is (mid + control) / 2.
  const qx = 2 * tx - mx;
  const qy = 2 * ty - my;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
};

/**
 * Liquidity solar system. The sun is the total liquidity bridged in the window; chains are planets on
 * TVL-class orbits, sized by TVL. Comets are net chain-to-chain flows, moving toward the receiver;
 * each planet's halo shows whether it is a net receiver (blue) or sender (red).
 */
export function LiquidityMap({ chains, flows, windowLabel, selected, onSelect }: Props) {
  const tip = useTooltip();
  const [hover, setHover] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const focus = hover ?? selected;
  const planetRefs = useRef(new Map<string, SVGGElement>());
  const flowRefs = useRef(new Map<string, SVGPathElement[]>());
  const t = useRef(0);
  const halt = useRef(false);
  halt.current = paused || hover !== null;

  const planets = useMemo(() => {
    const maxTvl = Math.max(...chains.map((c) => c.tvl), 1);
    const byOrbit: ChainNode[][] = [[], [], []];
    for (const c of chains) byOrbit[ORBITS.findIndex((o) => c.tvl >= o.min)].push(c);
    const out = new Map<string, Planet>();
    byOrbit.forEach((list, orbit) => {
      list.sort((a, b) => ECOSYSTEMS.indexOf(a.ecosystem) - ECOSYSTEMS.indexOf(b.ecosystem) || b.tvl - a.tvl);
      const offset = orbit * 0.9;
      list.forEach((c, i) => out.set(c.id, { c, orbit, phase: offset + (i / list.length) * Math.PI * 2, r: 7 + 25 * Math.sqrt(c.tvl / maxTvl) }));
    });
    return out;
  }, [chains]);

  const stars = useMemo(() => {
    const rng = mulberry32(7);
    return Array.from({ length: 150 }, (_, i) => ({ x: rng() * W, y: rng() * H, r: rng() < 0.9 ? 0.5 + rng() * 0.7 : 1.3 + rng() * 0.6, o: 0.25 + rng() * 0.6, twinkle: i % 9 === 0, delay: rng() * 4 }));
  }, []);

  const visible = useMemo(() => {
    const drawable = flows.filter((f) => planets.has(f.from) && planets.has(f.to));
    return focus ? drawable.filter((f, i) => i < 18 || f.from === focus || f.to === focus) : drawable.slice(0, 18);
  }, [flows, planets, focus]);
  const maxFlow = Math.max(...flows.map((f) => f.usd), 1);
  const maxNet = Math.max(...chains.map((c) => Math.abs(c.net)), 1);
  const total = chains.reduce((s, c) => s + c.inflow, 0);

  // Orbit motion: DOM updates only, so a 60fps drift never re-renders React.
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    const place = () => {
      const at = new Map<string, { x: number; y: number; depth: number }>();
      for (const [id, p] of planets) {
        const q = pos(p, t.current);
        at.set(id, q);
        const el = planetRefs.current.get(id);
        if (el) el.setAttribute('transform', `translate(${q.x.toFixed(1)},${q.y.toFixed(1)}) scale(${(0.9 + 0.1 * q.depth).toFixed(3)})`);
      }
      for (const [k, els] of flowRefs.current) {
        const [from, to] = k.split('>');
        const a = at.get(from);
        const b = at.get(to);
        if (a && b) {
          const d = arc(a, b);
          for (const el of els) el.setAttribute('d', d);
        }
      }
    };
    const frame = (now: number) => {
      if (!halt.current && !reduce) t.current += Math.min(now - last, 100) / 1000;
      last = now;
      place();
      raf = requestAnimationFrame(frame);
    };
    place();
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [planets, visible]);

  const related = (id: string) => visible.some((f) => (f.from === focus && f.to === id) || (f.to === focus && f.from === id));

  return (
    <div className="space">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Liquidity solar system: net cross-chain flows over ${windowLabel}`}>
        <defs>
          <radialGradient id="sun-core" cx="42%" cy="38%" r="65%">
            <stop offset="0%" stopColor="#fff6d8" />
            <stop offset="55%" stopColor="#ffcf6b" />
            <stop offset="100%" stopColor="#f39a3a" />
          </radialGradient>
          <radialGradient id="sun-corona">
            <stop offset="45%" stopColor="#ffb54a" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#ffb54a" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="nebula-a" cx="78%" cy="18%" r="55%">
            <stop offset="0%" stopColor="#5b4bd6" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#5b4bd6" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="nebula-b" cx="12%" cy="88%" r="50%">
            <stop offset="0%" stopColor="#1f8fb8" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#1f8fb8" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="planet-shade" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.45" />
            <stop offset="45%" stopColor="#fff" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.55" />
          </radialGradient>
        </defs>

        <rect width={W} height={H} fill="var(--space-bg)" />
        <rect width={W} height={H} fill="url(#nebula-a)" />
        <rect width={W} height={H} fill="url(#nebula-b)" />
        <g aria-hidden>
          {stars.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#dfe6ff" opacity={s.o} className={s.twinkle ? 'twinkle' : undefined} style={s.twinkle ? { animationDelay: `${s.delay}s` } : undefined} />
          ))}
        </g>

        {ORBITS.map((o, i) => (
          <g key={o.label} aria-hidden>
            <ellipse cx={CX} cy={CY} rx={o.r} ry={o.r * TILT} fill="none" stroke="var(--space-orbit)" strokeDasharray={i === 0 ? undefined : '2 5'} />
            <text x={CX} y={CY - o.r * TILT - 5} textAnchor="middle" className="orbit-label">
              {o.label}
            </text>
          </g>
        ))}

        <g aria-hidden>
          <circle cx={CX} cy={CY} r={SUN_R * 2.1} fill="url(#sun-corona)" className="corona" />
          <circle cx={CX} cy={CY} r={SUN_R} fill="url(#sun-core)" />
          <text x={CX} y={CY - 2} textAnchor="middle" className="sun-value">
            {usd(total)}
          </text>
          <text x={CX} y={CY + 15} textAnchor="middle" className="sun-label">
            bridged · {windowLabel}
          </text>
        </g>

        {visible.map((f) => {
          const k = `${f.from}>${f.to}`;
          const on = !focus || f.from === focus || f.to === focus;
          const w = 1.2 + 9 * Math.sqrt(f.usd / maxFlow);
          const color = ecoColor(planets.get(f.from)!.c.ecosystem);
          const src = planets.get(f.from)!.c;
          const dst = planets.get(f.to)!.c;
          const reg = (i: number) => (el: SVGPathElement | null) => {
            const arr = flowRefs.current.get(k) ?? [];
            if (el) arr[i] = el;
            flowRefs.current.set(k, arr);
          };
          return (
            <g key={k} style={{ opacity: on ? 1 : 0.06, transition: 'opacity .25s' }}>
              <path
                ref={reg(0)}
                stroke="transparent"
                strokeWidth={Math.max(w, 12)}
                fill="none"
                onMouseMove={(e) => tip.show(e, <TipRows title={`${src.name} → ${dst.name}`} rows={[['Net moved', usd(f.usd)], ['Window', windowLabel]]} />)}
                onMouseLeave={tip.hide}
              />
              <path ref={reg(1)} stroke={color} strokeOpacity={0.22} strokeWidth={w} fill="none" strokeLinecap="round" pointerEvents="none" />
              <path ref={reg(2)} stroke={color} strokeWidth={Math.max(1.4, w * 0.5)} fill="none" className="comet" pointerEvents="none" style={{ animationDuration: `${2.6 - 1.5 * Math.sqrt(f.usd / maxFlow)}s` }} />
            </g>
          );
        })}

        {[...planets.values()].map(({ c, r }) => {
          const dim = focus && focus !== c.id && !related(c.id);
          const halo = 1.2 + 4.5 * (Math.abs(c.net) / maxNet);
          return (
            <g
              key={c.id}
              ref={(el) => {
                if (el) planetRefs.current.set(c.id, el);
                else planetRefs.current.delete(c.id);
              }}
              className="planet"
              style={{ opacity: dim ? 0.3 : 1 }}
              tabIndex={0}
              role="button"
              aria-label={`${c.name}: TVL ${usd(c.tvl)}, net ${signedUsd(c.net)}`}
              onMouseEnter={() => setHover(c.id)}
              onFocus={() => setHover(c.id)}
              onBlur={() => setHover(null)}
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
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect(c.id)}
            >
              <circle r={r + 14} fill="transparent" />
              <circle r={r + 3 + halo / 2} fill="none" stroke={c.net >= 0 ? 'var(--flow-in)' : 'var(--flow-out)'} strokeWidth={halo} strokeOpacity={0.75} />
              <circle r={r} fill={ecoColor(c.ecosystem)} />
              <circle r={r} fill="url(#planet-shade)" />
              {selected === c.id && <circle r={r + halo + 8} fill="none" stroke="#fff" strokeWidth={1.5} strokeDasharray="3 3" className="target-ring" />}
              <text y={r + halo + 16} textAnchor="middle" className="planet-name">
                {c.name}
              </text>
              <text y={r + halo + 30} textAnchor="middle" className="planet-net">
                {c.net >= 0 ? '▲' : '▼'} {signedUsd(c.net)}
              </text>
            </g>
          );
        })}
      </svg>
      <button className="space-btn" onClick={() => setPaused(!paused)} aria-pressed={paused}>
        {paused ? '▶ Resume orbits' : '❚❚ Pause orbits'}
      </button>
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

/** How to read the map, drawn with the same marks it uses. */
export function SpaceKey() {
  return (
    <div className="space-key">
      <span>
        <svg width="26" height="14" aria-hidden><ellipse cx="13" cy="7" rx="12" ry="5" fill="none" stroke="currentColor" strokeOpacity=".5" /></svg>
        Orbit = TVL class
      </span>
      <span>
        <svg width="18" height="14" aria-hidden><circle cx="5" cy="9" r="3" fill="currentColor" /><circle cx="13" cy="7" r="5" fill="currentColor" /></svg>
        Planet size = TVL
      </span>
      <span>
        <svg width="30" height="14" aria-hidden><path d="M2 11 Q15 1 28 7" stroke="currentColor" strokeWidth="2" strokeDasharray="2 4" fill="none" /></svg>
        Comet = net flow, heading to the receiver
      </span>
      <span>
        <svg width="16" height="16" aria-hidden><circle cx="8" cy="8" r="6" fill="none" stroke="var(--flow-in)" strokeWidth="2.5" /></svg>
        Halo: net in
      </span>
      <span>
        <svg width="16" height="16" aria-hidden><circle cx="8" cy="8" r="6" fill="none" stroke="var(--flow-out)" strokeWidth="2.5" /></svg>
        net out
      </span>
    </div>
  );
}
