import { useState } from 'react';
import { chainColor } from '../lib/colors.ts';

/** Token logo with a chain dot; falls back to initials when there's no image or it fails to load. */
export function TokenAvatar({ symbol, imageUrl, fallbackUrl, chain, size = 38 }: { symbol: string; imageUrl?: string; fallbackUrl?: string; chain: string; size?: number }) {
  // Try the token's logo, then the fallback, then show initials.
  const sources = [imageUrl, fallbackUrl].filter((u): u is string => !!u);
  const [failed, setFailed] = useState(0);
  const src = sources[failed];
  const show = !!src;
  return (
    <div className="avatar" style={{ width: size, height: size, background: show ? 'var(--surface-2)' : `color-mix(in srgb, ${chainColor(chain)} 70%, #000)`, fontSize: size * 0.34 }} aria-hidden>
      {show ? <img key={src} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed((n) => n + 1)} /> : symbol.slice(0, 2)}
      <i className="chain-dot" style={{ background: chainColor(chain) }} />
    </div>
  );
}

export function LaunchpadTag({ name }: { name?: string }) {
  if (!name) return null;
  return (
    <span className="launchpad" title={`Launched on ${name}`}>
      🚀 {name}
    </span>
  );
}
