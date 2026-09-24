import { scaleBand, scaleLinear, scaleTime } from 'd3-scale';
import { area, curveMonotoneX, line } from 'd3-shape';
import { useRef, useState } from 'react';
import type { ChainNode } from '../../../shared/types.ts';
import { date, signedUsd, usd } from '../lib/format.ts';
import { TipRows, useTooltip } from './Tooltip.tsx';

/** Diverging horizontal bars: net inflow right (blue), net outflow left (red). */
export function NetFlowBars({ chains, onSelect, selected }: { chains: ChainNode[]; onSelect: (id: string) => void; selected: string | null }) {
  const tip = useTooltip();
  const rows = [...chains].sort((a, b) => b.net - a.net);
  const W = 420;
  const rowH = 30;
  const labelW = 118;
  const valueW = 78;
  const H = rows.length * rowH + 8;
  const max = Math.max(...rows.map((r) => Math.abs(r.net)), 1);
  const x = scaleLinear().domain([-max, max]).range([labelW, W - valueW]);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Net bridge flow by chain">
      <line x1={x(0)} x2={x(0)} y1={0} y2={H} stroke="var(--border)" />
      {rows.map((c, i) => {
        const y = 4 + i * rowH;
        const x0 = Math.min(x(0), x(c.net));
        const w = Math.max(2, Math.abs(x(c.net) - x(0)));
        const pos = c.net >= 0;
        return (
          <g
            key={c.id}
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(c.id)}
            onMouseMove={(e) => tip.show(e, <TipRows title={c.name} rows={[['Inflow', usd(c.inflow)], ['Outflow', usd(c.outflow)], ['Net', signedUsd(c.net)]]} />)}
            onMouseLeave={tip.hide}
          >
            <rect x={0} y={y} width={W} height={rowH - 2} fill={selected === c.id ? 'var(--surface-2)' : 'transparent'} rx={6} />
            <text x={8} y={y + rowH / 2 + 3} fontSize="12" fill="var(--text-primary)">
              {c.name}
            </text>
            <rect x={x0} y={y + 8} width={w} height={rowH - 18} rx={3} fill={pos ? 'var(--flow-in)' : 'var(--flow-out)'} />
            <text x={W - 6} y={y + rowH / 2 + 3} fontSize="12" textAnchor="end" fill="var(--text-secondary)" fontFamily="var(--mono)">
              {pos ? '▲' : '▼'} {signedUsd(c.net)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Single-series area with a hover crosshair. */
export function AreaChart({ data, height = 200, label }: { data: { t: number; v: number }[]; height?: number; label: string }) {
  const tip = useTooltip();
  const ref = useRef<SVGSVGElement>(null);
  const [hi, setHi] = useState<number | null>(null);
  if (data.length < 2) return <div className="note">Not enough history.</div>;
  const W = 680;
  const m = { l: 8, r: 56, t: 10, b: 22 };
  const x = scaleTime()
    .domain([data[0].t, data.at(-1)!.t])
    .range([m.l, W - m.r]);
  const ext = [Math.min(...data.map((d) => d.v)), Math.max(...data.map((d) => d.v))];
  const pad = (ext[1] - ext[0]) * 0.1 || ext[1] * 0.1;
  const y = scaleLinear()
    .domain([Math.max(0, ext[0] - pad), ext[1] + pad])
    .range([height - m.b, m.t])
    .nice(4);
  const a = area<{ t: number; v: number }>().x((d) => x(d.t)).y0(y.range()[0]).y1((d) => y(d.v)).curve(curveMonotoneX);
  const l = line<{ t: number; v: number }>().x((d) => x(d.t)).y((d) => y(d.v)).curve(curveMonotoneX);
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const t = x.invert(px).getTime();
    let best = 0;
    for (let i = 1; i < data.length; i++) if (Math.abs(data[i].t - t) < Math.abs(data[best].t - t)) best = i;
    setHi(best);
    tip.show(e, <TipRows title={date(data[best].t)} rows={[[label, usd(data[best].v, 2)]]} />);
  };
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${height}`} width="100%" onMouseMove={onMove} onMouseLeave={() => (setHi(null), tip.hide())} role="img" aria-label={label}>
      {y.ticks(4).map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
          <text x={W - m.r + 6} y={y(v) + 4} fontSize="11" fill="var(--text-muted)" fontFamily="var(--mono)">
            {usd(v, 0)}
          </text>
        </g>
      ))}
      {x.ticks(5).map((t) => (
        <text key={+t} x={x(t)} y={height - 6} fontSize="11" fill="var(--text-muted)" textAnchor="middle">
          {date(+t)}
        </text>
      ))}
      <path d={a(data)!} fill="var(--accent)" fillOpacity={0.14} />
      <path d={l(data)!} fill="none" stroke="var(--accent)" strokeWidth={2} />
      {hi !== null && (
        <>
          <line x1={x(data[hi].t)} x2={x(data[hi].t)} y1={m.t} y2={height - m.b} stroke="var(--text-muted)" strokeDasharray="3 3" />
          <circle cx={x(data[hi].t)} cy={y(data[hi].v)} r={4} fill="var(--accent)" stroke="var(--surface-1)" strokeWidth={2} />
        </>
      )}
    </svg>
  );
}

/** Daily bridge inflow (up) vs outflow (down) on one shared axis. */
export function MirrorBars({ data, height = 190 }: { data: { t: number; inflow: number; outflow: number }[]; height?: number }) {
  const tip = useTooltip();
  const W = 680;
  const m = { l: 8, r: 56, t: 8, b: 22 };
  const x = scaleBand<number>()
    .domain(data.map((d) => d.t))
    .range([m.l, W - m.r])
    .paddingInner(0.25);
  const max = Math.max(...data.map((d) => Math.max(d.inflow, d.outflow)), 1);
  const y = scaleLinear().domain([-max, max]).range([height - m.b, m.t]).nice(2);
  const bw = x.bandwidth();
  const r = Math.min(3, bw / 2);
  // Bars grow away from the zero baseline, so only the far end is rounded.
  const bar = (x0: number, y0: number, y1: number) => {
    const up = y1 < y0;
    const h = Math.abs(y1 - y0);
    if (h < r) return `M${x0},${y0}h${bw}v${up ? -h : h}h${-bw}Z`;
    return up
      ? `M${x0},${y0}V${y1 + r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bw - r}Q${x0 + bw},${y1} ${x0 + bw},${y1 + r}V${y0}Z`
      : `M${x0},${y0}V${y1 - r}Q${x0},${y1} ${x0 + r},${y1}H${x0 + bw - r}Q${x0 + bw},${y1} ${x0 + bw},${y1 - r}V${y0}Z`;
  };
  const ticks = data.filter((_, i) => i % Math.ceil(data.length / 6) === 0);
  return (
    <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" aria-label="Daily bridge inflow and outflow">
      {y.ticks(4).map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? 'var(--border)' : 'var(--grid)'} />
          <text x={W - m.r + 6} y={y(v) + 4} fontSize="11" fill="var(--text-muted)" fontFamily="var(--mono)">
            {usd(Math.abs(v), 0)}
          </text>
        </g>
      ))}
      {data.map((d) => (
        <g
          key={d.t}
          onMouseMove={(e) => tip.show(e, <TipRows title={date(d.t)} rows={[['Inflow', usd(d.inflow)], ['Outflow', usd(d.outflow)], ['Net', signedUsd(d.inflow - d.outflow)]]} />)}
          onMouseLeave={tip.hide}
        >
          <rect x={x(d.t)! - 1} y={m.t} width={bw + 2} height={height - m.t - m.b} fill="transparent" />
          <path d={bar(x(d.t)!, y(0) - 1, y(d.inflow))} fill="var(--flow-in)" />
          <path d={bar(x(d.t)!, y(0) + 1, y(-d.outflow))} fill="var(--flow-out)" />
        </g>
      ))}
      {ticks.map((d, i) => (
        <text key={d.t} x={i === 0 ? x(d.t)! : x(d.t)! + bw / 2} y={height - 6} fontSize="11" fill="var(--text-muted)" textAnchor={i === 0 ? 'start' : 'middle'}>
          {date(d.t)}
        </text>
      ))}
    </svg>
  );
}
