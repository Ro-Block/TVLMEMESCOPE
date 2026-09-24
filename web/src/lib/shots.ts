import { useSyncExternalStore } from 'react';
import type { Shot } from '../../../shared/types.ts';

// Tiny external store so a burst of shots re-renders only the sniper view, not the whole app.
export type LiveShot = Shot & { arrived: number };
let shots: LiveShot[] = [];
const listeners = new Set<() => void>();

export const shotStore = {
  push(s: Shot) {
    if (shots.some((x) => x.id === s.id)) return;
    shots = [...shots, { ...s, arrived: Date.now() }].slice(-400);
    listeners.forEach((l) => l());
  },
  seed(list: Shot[]) {
    const ids = new Set(shots.map((s) => s.id));
    shots = [...list.filter((s) => !ids.has(s.id)).map((s) => ({ ...s, arrived: 0 })), ...shots].sort((a, b) => a.ts - b.ts).slice(-400);
    listeners.forEach((l) => l());
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useShots = () => useSyncExternalStore(subscribe, () => shots);
