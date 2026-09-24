import { useSyncExternalStore } from 'react';
import type { FlowEvent } from '../../../shared/types.ts';

// Live super-comet / supernova events for the solar map, kept outside React state.
export type LiveFlowEvent = FlowEvent & { arrived: number };
let events: LiveFlowEvent[] = [];
const listeners = new Set<() => void>();

export const flowEventStore = {
  push(e: FlowEvent) {
    if (events.some((x) => x.id === e.id)) return;
    events = [{ ...e, arrived: Date.now() }, ...events].slice(0, 40);
    listeners.forEach((l) => l());
  },
  seed(list: FlowEvent[]) {
    const ids = new Set(events.map((e) => e.id));
    events = [...events, ...list.filter((e) => !ids.has(e.id)).map((e) => ({ ...e, arrived: 0 }))].slice(0, 40);
    listeners.forEach((l) => l());
  },
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const useFlowEvents = () => useSyncExternalStore(subscribe, () => events);
