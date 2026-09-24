// Canvas rendering for the liquidity solar system: procedural planet textures, sun, sky and comets.
// Everything is drawn in the map's own coordinate space (viewBox units); the caller sets the DPR scale.

import { mulberry32 } from '../../lib/rand.ts';

// ---------- colour helpers ----------

type RGB = [number, number, number];
export const hex = (h: string): RGB => {
  const n = parseInt(h.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

// ---------- value noise ----------

function makeNoise(seed: number) {
  const rng = mulberry32(seed);
  const perm = new Uint8Array(512);
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    vals[i] = rng();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [perm[i], perm[j]] = [perm[j], perm[i]];
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const s = (t: number) => t * t * (3 - 2 * t);
  const v = (x: number, y: number) => vals[perm[(perm[x & 255] + y) & 511]];
  const noise = (x: number, y: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = s(x - xi);
    const yf = s(y - yi);
    const a = v(xi, yi) + (v(xi + 1, yi) - v(xi, yi)) * xf;
    const b = v(xi, yi + 1) + (v(xi + 1, yi + 1) - v(xi, yi + 1)) * xf;
    return a + (b - a) * yf;
  };
  return (x: number, y: number, oct = 4) => {
    let sum = 0;
    let amp = 0.5;
    let f = 1;
    for (let o = 0; o < oct; o++) {
      sum += amp * noise(x * f, y * f);
      amp *= 0.5;
      f *= 2.03;
    }
    return sum / (1 - Math.pow(0.5, oct));
  };
}

// ---------- planet textures ----------

export type PlanetKind = 'gas' | 'rocky' | 'ocean';

/** A lit-independent surface disc (limb darkening baked in); lighting is added per frame. */
export function planetTexture(base: string, kind: PlanetKind, seed: number, size = 160): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const fbm = makeNoise(seed);
  const col = hex(base);
  const light = mix(col, WHITE, 0.38);
  const dark = mix(col, BLACK, 0.5);
  const deep = mix(col, BLACK, 0.72);
  const pale = mix(col, [238, 226, 205], 0.45);
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - R + 0.5) / R;
      const dy = (y - R + 0.5) / R;
      const d2 = dx * dx + dy * dy;
      const i = (y * size + x) * 4;
      if (d2 > 1) {
        img.data[i + 3] = 0;
        continue;
      }
      // Sphere-ish mapping: stretch towards the limb so features wrap around.
      const z = Math.sqrt(1 - d2);
      const u = dx / (z + 0.35);
      const v = dy / (z + 0.35);
      let c3: RGB;
      if (kind === 'gas') {
        // Turbulent latitude bands: warped by noise so they swirl rather than read as stripes.
        const warp = fbm(u * 3.1, v * 4.5, 5) * 3.2 + fbm(u * 9, v * 12, 3) * 0.8;
        const band = Math.sin(v * 8.5 + warp) * 0.5 + 0.5;
        const fine = fbm(u * 6, v * 18, 3);
        c3 = mix(mix(dark, light, 0.25 + band * 0.55), pale, Math.max(0, fine - 0.58) * 1.3);
        // A storm spot on some giants.
        const sx = u - 0.35;
        const sy = v - 0.28;
        if (seed % 3 === 0 && sx * sx * 0.6 + sy * sy * 3 < 0.018) c3 = mix(c3, mix(col, [200, 90, 60], 0.5), 0.55);
      } else if (kind === 'rocky') {
        const n = fbm(u * 3.2 + 7, v * 3.2, 5);
        const crater = fbm(u * 9, v * 9, 2);
        c3 = n < 0.45 ? mix(deep, dark, n / 0.45) : mix(dark, light, (n - 0.45) / 0.55);
        if (crater > 0.72) c3 = mix(c3, BLACK, 0.25);
      } else {
        const n = fbm(u * 2.6 + 3, v * 2.6, 5);
        const cloud = fbm(u * 4 + 11, v * 7, 4);
        c3 = n < 0.52 ? mix(deep, col, n / 0.52) : mix(mix(col, [150, 140, 105], 0.35), light, (n - 0.52) / 0.48);
        if (cloud > 0.6) c3 = mix(c3, WHITE, Math.min(0.75, (cloud - 0.6) * 2.6));
      }
      const limb = 0.55 + 0.45 * Math.pow(z, 0.6);
      img.data[i] = c3[0] * limb;
      img.data[i + 1] = c3[1] * limb;
      img.data[i + 2] = c3[2] * limb;
      // Soft edge for anti-aliasing.
      img.data[i + 3] = Math.min(1, (1 - Math.sqrt(d2)) * R * 1.5) * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------- sky ----------

/** Milky Way band, coloured stars and faint nebulae, rendered once per size. */
export function skyTexture(w: number, h: number, scale: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d')!;
  ctx.scale(scale, scale);
  const rng = mulberry32(42);
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#03050c');
  g.addColorStop(1, '#070a14');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // Nebulae.
  const neb = (x: number, y: number, r: number, color: string) => {
    const n = ctx.createRadialGradient(x, y, 0, x, y, r);
    n.addColorStop(0, color);
    n.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = n;
    ctx.fillRect(0, 0, w, h);
  };
  neb(w * 0.86, h * 0.12, w * 0.38, 'rgba(92,70,190,0.16)');
  neb(w * 0.08, h * 0.92, w * 0.34, 'rgba(30,120,160,0.13)');
  neb(w * 0.7, h * 0.95, w * 0.22, 'rgba(170,70,90,0.07)');

  // Milky Way: a diagonal band of glow, dust lanes and dense faint stars.
  const angle = -0.42;
  const cx = w * 0.5;
  const cy = h * 0.5;
  const along = (t: number, off: number) => [cx + Math.cos(angle) * t - Math.sin(angle) * off, cy + Math.sin(angle) * t + Math.cos(angle) * off];
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.scale(1, 0.16);
  const band = ctx.createRadialGradient(0, 0, 0, 0, 0, w * 0.75);
  band.addColorStop(0, 'rgba(200,190,230,0.13)');
  band.addColorStop(0.5, 'rgba(150,150,210,0.06)');
  band.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = band;
  ctx.fillRect(-w, -w, 2 * w, 2 * w);
  ctx.restore();
  const fbm = makeNoise(9);
  for (let i = 0; i < 900; i++) {
    const t = (rng() - 0.5) * w * 1.5;
    const off = (rng() + rng() + rng() - 1.5) * h * 0.1;
    const [x, y] = along(t, off);
    const dust = fbm(t / 60 + 5, off / 25, 3);
    if (dust > 0.62) continue; // dark lane
    ctx.fillStyle = `rgba(215,215,240,${0.05 + rng() * 0.12})`;
    ctx.fillRect(x, y, 0.8, 0.8);
  }
  for (let i = 0; i < 60; i++) {
    const t = (rng() - 0.5) * w * 1.4;
    const off = (rng() - 0.5) * h * 0.08;
    const [x, y] = along(t, off);
    if (fbm(t / 60 + 5, off / 25, 3) < 0.6) continue;
    const r = 12 + rng() * 26;
    const d = ctx.createRadialGradient(x, y, 0, x, y, r);
    d.addColorStop(0, 'rgba(2,3,8,0.35)');
    d.addColorStop(1, 'rgba(2,3,8,0)');
    ctx.fillStyle = d;
    ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  }

  // Field stars with colour temperature.
  const temps: RGB[] = [[170, 190, 255], [215, 225, 255], [255, 255, 255], [255, 240, 215], [255, 210, 170]];
  for (let i = 0; i < 520; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const big = rng() < 0.05;
    const r = big ? 0.9 + rng() * 0.9 : 0.25 + rng() * 0.55;
    const col = temps[Math.floor(rng() * temps.length)];
    const a = big ? 0.85 : 0.25 + rng() * 0.55;
    if (big) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 5);
      glow.addColorStop(0, rgba(col, 0.35));
      glow.addColorStop(1, rgba(col, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(x - r * 5, y - r * 5, r * 10, r * 10);
      ctx.strokeStyle = rgba(col, 0.25);
      ctx.lineWidth = 0.4;
      ctx.beginPath();
      ctx.moveTo(x - r * 6, y);
      ctx.lineTo(x + r * 6, y);
      ctx.moveTo(x, y - r * 6);
      ctx.lineTo(x, y + r * 6);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(col, a);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  return c;
}

/** Granulation pattern for the sun's surface. */
export function sunTexture(size = 256): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const fbm = makeNoise(3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / 9, y / 9, 3) * 0.7 + fbm(x / 40, y / 40, 2) * 0.3;
      const i = (y * size + x) * 4;
      const v = 150 + n * 105;
      img.data[i] = v;
      img.data[i + 1] = v * 0.86;
      img.data[i + 2] = v * 0.62;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// ---------- per-frame drawing ----------

export function drawSun(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, t: number, tex: HTMLCanvasElement) {
  const pulse = 1 + Math.sin(t * 0.8) * 0.03;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (const [rr, a] of [[r * 4.2 * pulse, 0.1], [r * 2.4 * pulse, 0.2], [r * 1.5, 0.35]] as const) {
    const g = ctx.createRadialGradient(x, y, r * 0.8, x, y, rr);
    g.addColorStop(0, `rgba(255,190,90,${a})`);
    g.addColorStop(1, 'rgba(255,140,40,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(t * 0.01);
  ctx.drawImage(tex, -r * 1.5, -r * 1.5, r * 3, r * 3);
  ctx.restore();
  // Limb darkening: bright core, deep orange edge.
  const limb = ctx.createRadialGradient(x - r * 0.15, y - r * 0.15, 0, x, y, r);
  limb.addColorStop(0, 'rgba(255,250,225,0.85)');
  limb.addColorStop(0.55, 'rgba(255,205,110,0.35)');
  limb.addColorStop(0.9, 'rgba(235,110,30,0.55)');
  limb.addColorStop(1, 'rgba(170,60,10,0.9)');
  ctx.fillStyle = limb;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();
}

export function drawRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: RGB, half: 'back' | 'front') {
  ctx.save();
  ctx.beginPath();
  // Back half = upper arc of the tilted ring, front half = lower arc.
  if (half === 'back') ctx.rect(x - r * 3, y - r * 3, r * 6, r * 3);
  else ctx.rect(x - r * 3, y, r * 6, r * 3);
  ctx.clip();
  ctx.translate(x, y);
  ctx.rotate(-0.28);
  for (const [rr, w, a] of [[1.55, 0.18, 0.45], [1.85, 0.22, 0.32], [2.15, 0.08, 0.2]] as const) {
    ctx.beginPath();
    ctx.ellipse(0, 0, r * rr, r * rr * 0.28, 0, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(mix(color, [235, 225, 200], 0.55), a);
    ctx.lineWidth = r * w;
    ctx.stroke();
  }
  ctx.restore();
}

/** Draws a textured planet lit from the sun's direction, with a thin atmosphere on the lit limb. */
export function drawPlanet(ctx: CanvasRenderingContext2D, tex: HTMLCanvasElement, x: number, y: number, r: number, sunX: number, sunY: number, atmo: RGB) {
  const dx = sunX - x;
  const dy = sunY - y;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d;
  const uy = dy / d;
  ctx.drawImage(tex, x - r, y - r, r * 2, r * 2);

  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  // Day side faces the sun; the terminator falls just past the planet's centre.
  const sh = ctx.createRadialGradient(x + ux * r * 0.6, y + uy * r * 0.6, 0, x + ux * r * 0.6, y + uy * r * 0.6, r * 1.6);
  sh.addColorStop(0, 'rgba(255,245,225,0.16)');
  sh.addColorStop(0.3, 'rgba(0,0,0,0)');
  sh.addColorStop(0.55, 'rgba(0,0,8,0.35)');
  sh.addColorStop(0.72, 'rgba(0,0,8,0.86)');
  sh.addColorStop(1, 'rgba(0,0,8,0.96)');
  ctx.fillStyle = sh;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
  ctx.restore();

  // Atmosphere: a soft rim that is brightest where sunlight grazes it.
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const rim = ctx.createRadialGradient(x, y, r * 0.92, x, y, r * 1.28);
  rim.addColorStop(0, rgba(atmo, 0));
  rim.addColorStop(0.25, rgba(atmo, 0.22));
  rim.addColorStop(1, rgba(atmo, 0));
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.3, 0, Math.PI * 2);
  ctx.fill();
  const lit = ctx.createRadialGradient(x + ux * r, y + uy * r, 0, x + ux * r, y + uy * r, r * 0.9);
  lit.addColorStop(0, rgba(mix(atmo, WHITE, 0.4), 0.35));
  lit.addColorStop(1, rgba(atmo, 0));
  ctx.fillStyle = lit;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.08, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export const quad = (p0: number, p1: number, p2: number, s: number) => (1 - s) * (1 - s) * p0 + 2 * (1 - s) * s * p1 + s * s * p2;

/** A comet head with a fading tail travelling along a quadratic route. */
export function drawComet(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, q: { x: number; y: number }, b: { x: number; y: number }, s: number, width: number, color: RGB) {
  const TAIL = 0.14;
  const STEPS = 14;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  let px = quad(a.x, q.x, b.x, Math.max(0, s - TAIL));
  let py = quad(a.y, q.y, b.y, Math.max(0, s - TAIL));
  for (let i = 1; i <= STEPS; i++) {
    const u = Math.max(0, s - TAIL + (TAIL * i) / STEPS);
    const x = quad(a.x, q.x, b.x, u);
    const y = quad(a.y, q.y, b.y, u);
    const k = i / STEPS;
    ctx.strokeStyle = rgba(mix(color, WHITE, k * 0.5), k * k * 0.85);
    ctx.lineWidth = width * (0.25 + k * 0.75);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
    ctx.stroke();
    px = x;
    py = y;
  }
  const hx = quad(a.x, q.x, b.x, s);
  const hy = quad(a.y, q.y, b.y, s);
  const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, width * 3);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.3, rgba(mix(color, WHITE, 0.4), 0.6));
  g.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(hx - width * 3, hy - width * 3, width * 6, width * 6);
  ctx.restore();
}

// ---------- event effects ----------

const ease = (x: number) => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 2.2);

/**
 * Super comet: a white-hot head with a long, wide tail and sparks, flying the route over ~4.5s,
 * then a flash where it lands. `p` runs 0→1 for the flight and 1→1.35 for the impact.
 */
export function drawSuperComet(ctx: CanvasRenderingContext2D, a: { x: number; y: number }, q: { x: number; y: number }, b: { x: number; y: number }, p: number, color: RGB, seed: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  if (p <= 1) {
    const s = ease(p);
    const TAIL = 0.4;
    const STEPS = 34;
    let px = quad(a.x, q.x, b.x, Math.max(0, s - TAIL));
    let py = quad(a.y, q.y, b.y, Math.max(0, s - TAIL));
    for (let i = 1; i <= STEPS; i++) {
      const u = Math.max(0, s - TAIL + (TAIL * i) / STEPS);
      const x = quad(a.x, q.x, b.x, u);
      const y = quad(a.y, q.y, b.y, u);
      const k = i / STEPS;
      ctx.strokeStyle = rgba(mix(color, WHITE, k * 0.7), k * k * 0.9);
      ctx.lineWidth = 2 + k * 9;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();
      px = x;
      py = y;
    }
    const hx = quad(a.x, q.x, b.x, s);
    const hy = quad(a.y, q.y, b.y, s);
    // Sparks shed behind the head.
    const rng = mulberry32(seed + Math.floor(p * 60));
    for (let i = 0; i < 14; i++) {
      const u = Math.max(0, s - rng() * TAIL * 0.7);
      const sx = quad(a.x, q.x, b.x, u) + (rng() - 0.5) * 22;
      const sy = quad(a.y, q.y, b.y, u) + (rng() - 0.5) * 22;
      ctx.fillStyle = rgba(mix(color, WHITE, 0.6), 0.5 * rng());
      ctx.fillRect(sx, sy, 1.6, 1.6);
    }
    const g = ctx.createRadialGradient(hx, hy, 0, hx, hy, 34);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, rgba(mix(color, WHITE, 0.6), 0.85));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(hx - 34, hy - 34, 68, 68);
  } else {
    const k = (p - 1) / 0.35;
    const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, 20 + 60 * k);
    g.addColorStop(0, rgba(WHITE, 0.9 * (1 - k)));
    g.addColorStop(0.4, rgba(color, 0.5 * (1 - k)));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.fillRect(b.x - 90, b.y - 90, 180, 180);
    ctx.strokeStyle = rgba(mix(color, WHITE, 0.5), 0.8 * (1 - k));
    ctx.lineWidth = 2.5 * (1 - k) + 0.5;
    ctx.beginPath();
    ctx.arc(b.x, b.y, 14 + 55 * k, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Supernova: flash, three shockwaves, flying debris and a fading remnant. `p` runs 0→1 over ~4s. */
export function drawSupernova(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, p: number, color: RGB, seed: number) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const flash = Math.max(0, 1 - p / 0.12);
  if (flash > 0) {
    const f = ctx.createRadialGradient(x, y, 0, x, y, r * 9);
    f.addColorStop(0, `rgba(255,255,255,${flash})`);
    f.addColorStop(0.3, `rgba(255,230,180,${0.7 * flash})`);
    f.addColorStop(1, 'rgba(255,200,120,0)');
    ctx.fillStyle = f;
    ctx.fillRect(x - r * 9, y - r * 9, r * 18, r * 18);
  }
  // Remnant nebula.
  const rem = ctx.createRadialGradient(x, y, 0, x, y, r * 2 + 150 * ease(p));
  rem.addColorStop(0, rgba(mix(color, [255, 120, 60], 0.5), 0.35 * (1 - p)));
  rem.addColorStop(0.6, rgba(mix(color, [180, 60, 160], 0.4), 0.18 * (1 - p)));
  rem.addColorStop(1, rgba(color, 0));
  ctx.fillStyle = rem;
  ctx.fillRect(x - 200, y - 200, 400, 400);
  // Shockwaves.
  for (let i = 0; i < 3; i++) {
    const k = ease(p * (1.25 - i * 0.18) - i * 0.05);
    if (k <= 0) continue;
    ctx.strokeStyle = i === 0 ? `rgba(255,245,230,${0.9 * (1 - k)})` : rgba(mix(color, [255, 150, 80], 0.5), 0.7 * (1 - k));
    ctx.lineWidth = (4 - i) * (1 - k) + 0.4;
    ctx.beginPath();
    ctx.ellipse(x, y, r + 190 * k, (r + 190 * k) * 0.8, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Debris.
  const rng = mulberry32(seed);
  for (let i = 0; i < 70; i++) {
    const ang = rng() * Math.PI * 2;
    const speed = 60 + rng() * 170;
    const d = r + speed * ease(p);
    const a = (1 - p) * (0.5 + rng() * 0.5);
    ctx.fillStyle = rgba(rng() < 0.4 ? WHITE : mix(color, [255, 170, 90], rng()), a);
    const s = 1 + rng() * 2;
    ctx.fillRect(x + Math.cos(ang) * d, y + Math.sin(ang) * d * 0.8, s, s);
  }
  ctx.restore();
}
