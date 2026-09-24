import { useEffect, useMemo, useRef, useState } from 'react';
import { ECOSYSTEMS, type ChainNode, type Ecosystem, type Flow } from '../../../shared/types.ts';
import { ecoColor } from '../lib/colors.ts';
import { pct, signedUsd, usd } from '../lib/format.ts';
import { drawComet, drawPlanet, drawRing, drawSun, hex, planetTexture, rgba, skyTexture, sunTexture, type PlanetKind } from './solar/render.ts';
import { TipRows, useTooltip } from './Tooltip.tsx';

const W = 760;
const H = 620;
const CX = W / 2;
const CY = H / 2 + 6;
const TILT = 0.62; // orbits seen at an angle
const SUN_R = 40;

/** Orbits are TVL classes, so where a planet sits tells you its size class at a glance. */
const ORBITS = [
  { r: 145, min: 5e9, period: 260 },
  { r: 222, min: 1e9, period: 380 },
  { r: 300, min: 0, period: 520 },
];

// The map is always rendered on a dark sky, so it uses the dark-theme ecosystem colours.
const ECO_HEX: Record<Ecosystem, string> = {
  Ethereum: '#3987e5', Solana: '#d95926', Hyperliquid: '#199e70', BNB: '#c98500', Base: '#d55181', Robinhood: '#008300', Other: '#7a8196',
};

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
  ringed: boolean;
  tex: HTMLCanvasElement;
}

const pos = (p: Planet, t: number) => {
  const o = ORBITS[p.orbit];
  const a = p.phase + (t / o.period) * Math.PI * 2;
  const depth = Math.sin(a); // -1 far side, +1 near side
  return { x: CX + o.r * Math.cos(a), y: CY + o.r * TILT * depth, depth, scale: 0.86 + (0.14 * (depth + 1)) / 2 };
};

// Comet route: a quadratic curve that bows outward so it swings around the sun instead of crossing it.
const CLEAR = SUN_R + 38;
function route(a: { x: number; y: number }, b: { x: number; y: number }) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  let vx = mx - CX;
  let vy = my - CY;
  let d = Math.hypot(vx, vy);
  if (d < 1) {
    vx = -(b.y - a.y);
    vy = b.x - a.x;
    d = Math.hypot(vx, vy) || 1;
  }
  const reach = Math.max(d + 16, CLEAR);
  // For a quadratic Bézier the curve midpoint is (mid + control) / 2.
  const q = { x: 2 * (CX + (vx / d) * reach) - mx, y: 2 * (CY + (vy / d) * reach) - my };
  return { q, d: `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${q.x.toFixed(1)},${q.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}` };
}

function hashStr(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Liquidity solar system. The sun is the total liquidity bridged in the window; chains are planets
 * on TVL-class orbits, sized by TVL and lit by the sun. Comets are net chain-to-chain flows heading
 * to the receiver; the thin ring around each planet shows net inflow (blue) or outflow (red).
 * The scene is painted on a canvas; names, rings and hit targets sit on an SVG layer above it.
 */
export function LiquidityMap({ chains, flows, windowLabel, selected, onSelect }: Props) {
  const tip = useTooltip();
  const [hover, setHover] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const focus = hover ?? selected;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const planetRefs = useRef(new Map<string, SVGGElement>());
  const flowRefs = useRef(new Map<string, SVGPathElement>());
  const t = useRef(0);
  const live = useRef({ halt: false, focus: null as string | null });
  live.current = { halt: paused || hover !== null, focus };

  const planets = useMemo(() => {
    const maxTvl = Math.max(...chains.map((c) => c.tvl), 1);
    const biggest = chains.reduce((a, b) => (b.tvl > a.tvl ? b : a), chains[0]);
    const byOrbit: ChainNode[][] = [[], [], []];
    for (const c of chains) byOrbit[ORBITS.findIndex((o) => c.tvl >= o.min)].push(c);
    const out = new Map<string, Planet>();
    byOrbit.forEach((list, orbit) => {
      list.sort((a, b) => ECOSYSTEMS.indexOf(a.ecosystem) - ECOSYSTEMS.indexOf(b.ecosystem) || b.tvl - a.tvl);
      list.forEach((c, i) => {
        const seed = hashStr(c.id);
        // Big chains are gas giants; the rest are rocky or ocean worlds.
        const kind: PlanetKind = c.tvl >= 5e9 ? 'gas' : seed % 2 ? 'rocky' : 'ocean';
        out.set(c.id, {
          c,
          orbit,
          phase: orbit * 0.9 + (i / list.length) * Math.PI * 2,
          r: 7 + 23 * Math.sqrt(c.tvl / maxTvl),
          ringed: c.id === biggest?.id,
          tex: planetTexture(ECO_HEX[c.ecosystem], kind, seed),
        });
      });
    });
    return out;
  }, [chains]);

  const visible = useMemo(() => {
    const drawable = flows.filter((f) => planets.has(f.from) && planets.has(f.to));
    return focus ? drawable.filter((f, i) => i < 18 || f.from === focus || f.to === focus) : drawable.slice(0, 18);
  }, [flows, planets, focus]);
  const maxFlow = Math.max(...flows.map((f) => f.usd), 1);
  const maxNet = Math.max(...chains.map((c) => Math.abs(c.net)), 1);
  const total = chains.reduce((s, c) => s + c.inflow, 0);

  // Render loop: canvas scene + SVG overlay positions, without React re-renders.
  useEffect(() => {
    const cv = canvas.current!;
    const ctx = cv.getContext('2d')!;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const sunTex = sunTexture();
    let sky: HTMLCanvasElement | null = null;
    let k = 1;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = wrap.current?.clientWidth || W;
      k = (cssW / W) * dpr;
      cv.width = Math.round(W * k);
      cv.height = Math.round(H * k);
      sky = skyTexture(W, H, k);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (wrap.current) ro.observe(wrap.current);

    const flowList = visible.map((f) => {
      const s = Math.sqrt(f.usd / maxFlow);
      return { f, w: 1.1 + 3.4 * s, n: 1 + Math.round(3 * s), speed: 0.07 + 0.1 * s, color: hex(ECO_HEX[planets.get(f.from)!.c.ecosystem]) };
    });

    let raf = 0;
    let last = performance.now();
    let anim = 0; // comets keep flying while orbits are paused
    const frame = (now: number) => {
      const dt = Math.min(now - last, 100) / 1000;
      last = now;
      if (!reduce) {
        anim += dt;
        if (!live.current.halt) t.current += dt;
      }
      const f = live.current.focus;
      const at = new Map<string, ReturnType<typeof pos>>();
      for (const [id, p] of planets) at.set(id, pos(p, t.current));

      ctx.setTransform(k, 0, 0, k, 0, 0);
      if (sky) ctx.drawImage(sky, 0, 0, W, H);

      ORBITS.forEach((o, i) => {
        ctx.beginPath();
        ctx.ellipse(CX, CY, o.r, o.r * TILT, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(170,185,255,${i === 0 ? 0.2 : 0.13})`;
        ctx.lineWidth = 0.8;
        ctx.setLineDash(i === 0 ? [] : [2, 5]);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      const related = (id: string) => !f || id === f || visible.some((x) => (x.from === f && x.to === id) || (x.to === f && x.from === id));
      const paint = (id: string) => {
        const p = planets.get(id)!;
        const q = at.get(id)!;
        const r = p.r * q.scale;
        const col = hex(ECO_HEX[p.c.ecosystem]);
        ctx.globalAlpha = related(id) ? 1 : 0.28;
        if (p.ringed) drawRing(ctx, q.x, q.y, r, col, 'back');
        drawPlanet(ctx, p.tex, q.x, q.y, r, CX, CY, col);
        if (p.ringed) drawRing(ctx, q.x, q.y, r, col, 'front');
        ctx.globalAlpha = 1;
      };
      // Far-side planets pass behind the sun, near-side ones in front of it.
      const order = [...planets.keys()].sort((a, b) => at.get(a)!.depth - at.get(b)!.depth);
      for (const id of order) if (at.get(id)!.depth < 0) paint(id);

      drawSun(ctx, CX, CY, SUN_R, anim, sunTex);

      for (const x of flowList) {
        const a = at.get(x.f.from)!;
        const b = at.get(x.f.to)!;
        const { q, d } = route(a, b);
        flowRefs.current.get(`${x.f.from}>${x.f.to}`)?.setAttribute('d', d);
        ctx.globalAlpha = !f || x.f.from === f || x.f.to === f ? 1 : 0.07;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(q.x, q.y, b.x, b.y);
        ctx.strokeStyle = rgba(x.color, 0.14);
        ctx.lineWidth = x.w * 1.3;
        ctx.stroke();
        for (let i = 0; i < x.n; i++) drawComet(ctx, a, q, b, (anim * x.speed + i / x.n) % 1, x.w, x.color);
        ctx.globalAlpha = 1;
      }

      for (const id of order) if (at.get(id)!.depth >= 0) paint(id);

      for (const [id, el] of planetRefs.current) {
        const q = at.get(id);
        if (q) el.setAttribute('transform', `translate(${q.x.toFixed(1)},${q.y.toFixed(1)}) scale(${q.scale.toFixed(3)})`);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [planets, visible, maxFlow]);

  const isRelated = (id: string) => !focus || id === focus || visible.some((f) => (f.from === focus && f.to === id) || (f.to === focus && f.from === id));

  return (
    <div className="space" ref={wrap}>
      <canvas ref={canvas} aria-hidden />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Liquidity solar system: net cross-chain flows over ${windowLabel}`}>
        <g aria-hidden>
          <text x={CX} y={CY + SUN_R + 20} textAnchor="middle" className="sun-value">
            {usd(total)}
          </text>
          <text x={CX} y={CY + SUN_R + 34} textAnchor="middle" className="sun-label">
            bridged · {windowLabel}
          </text>
        </g>

        {visible.map((f) => {
          const src = planets.get(f.from)!.c;
          const dst = planets.get(f.to)!.c;
          const k = `${f.from}>${f.to}`;
          return (
            <path
              key={k}
              ref={(el) => {
                if (el) flowRefs.current.set(k, el);
                else flowRefs.current.delete(k);
              }}
              stroke="transparent"
              strokeWidth={12}
              fill="none"
              onMouseMove={(e) => tip.show(e, <TipRows title={`${src.name} → ${dst.name}`} rows={[['Net moved', usd(f.usd)], ['Window', windowLabel]]} />)}
              onMouseLeave={tip.hide}
            />
          );
        })}

        {[...planets.values()].map(({ c, r }) => {
          const halo = 1 + 2.5 * (Math.abs(c.net) / maxNet);
          return (
            <g
              key={c.id}
              ref={(el) => {
                if (el) planetRefs.current.set(c.id, el);
                else planetRefs.current.delete(c.id);
              }}
              className="planet"
              style={{ opacity: isRelated(c.id) ? 1 : 0.35 }}
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
              <circle r={r + 5} fill="none" stroke={c.net >= 0 ? 'var(--flow-in)' : 'var(--flow-out)'} strokeWidth={halo} strokeOpacity={0.7} strokeDasharray={c.net >= 0 ? undefined : '3 2'} />
              {selected === c.id && <circle r={r + halo + 9} fill="none" stroke="#fff" strokeWidth={1.2} strokeDasharray="3 3" className="target-ring" />}
              <text y={r + halo + 17} textAnchor="middle" className="planet-name">
                {c.name}
              </text>
              <text y={r + halo + 31} textAnchor="middle" className="planet-net">
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

/** How to read the map. */
export function SpaceKey() {
  return (
    <div className="space-key">
      <span>
        <svg width="26" height="14" aria-hidden><ellipse cx="13" cy="7" rx="12" ry="5" fill="none" stroke="currentColor" strokeOpacity=".5" /></svg>
        Orbit = TVL: inner &gt; $5B · middle $1–5B · outer &lt; $1B
      </span>
      <span>
        <svg width="18" height="14" aria-hidden><circle cx="5" cy="9" r="3" fill="currentColor" /><circle cx="13" cy="7" r="5" fill="currentColor" /></svg>
        Planet size = TVL
      </span>
      <span>
        <svg width="30" height="14" aria-hidden>
          <defs><linearGradient id="comet-key" x1="0" x2="1"><stop offset="0" stopColor="currentColor" stopOpacity="0" /><stop offset="1" stopColor="currentColor" /></linearGradient></defs>
          <path d="M2 11 Q15 2 25 6" stroke="url(#comet-key)" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <circle cx="26" cy="6" r="2.4" fill="currentColor" />
        </svg>
        Comet = net flow, flying to the receiver
      </span>
      <span>
        <svg width="16" height="16" aria-hidden><circle cx="8" cy="8" r="6" fill="none" stroke="var(--flow-in)" strokeWidth="2" /></svg>
        Ring: net in
      </span>
      <span>
        <svg width="16" height="16" aria-hidden><circle cx="8" cy="8" r="6" fill="none" stroke="var(--flow-out)" strokeWidth="2" strokeDasharray="3 2" /></svg>
        net out
      </span>
    </div>
  );
}
