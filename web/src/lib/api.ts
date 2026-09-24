import type { Alert, AlertSettings, Shot, SnipersResponse, ChainDetail, FlowWindow, FlowsResponse, Pair, StatusResponse, TraderStats, WalletDetail } from '../../../shared/types.ts';

import { isStatic, staticReq } from './static.ts';

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  if (isStatic()) return staticReq(path, init) as Promise<T>;
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `${res.status}`);
  return res.json() as Promise<T>;
}

export type RankedTrader = TraderStats & { qualifies: boolean };

export const api = {
  status: () => req<StatusResponse>('/api/status'),
  flows: (w: FlowWindow) => req<FlowsResponse>(`/api/flows?window=${w}`),
  chain: (id: string, w: FlowWindow) => req<ChainDetail>(`/api/chains/${id}?window=${w}`),
  pairs: (chains: string[], maxAgeHours: number) => req<Pair[]>(`/api/pairs?chains=${chains.join(',')}&maxAgeHours=${maxAgeHours}`),
  traders: (q: { chains: string[]; sort: string; minScore: number; hideBots: boolean }) =>
    req<RankedTrader[]>(`/api/traders?chains=${q.chains.join(',')}&sort=${q.sort}&minScore=${q.minScore}&hideBots=${q.hideBots ? 1 : 0}`),
  wallet: (chain: string, wallet: string) => req<WalletDetail>(`/api/wallets/${chain}/${wallet}`),
  watch: (chain: string, wallet: string, label?: string) => req('/api/watchlist', { method: 'POST', body: JSON.stringify({ chain, wallet, label }) }),
  unwatch: (chain: string, wallet: string) => req(`/api/watchlist/${chain}/${wallet}`, { method: 'DELETE' }),
  snipers: (chains: string[]) => req<SnipersResponse>(`/api/snipers?chains=${chains.join(',')}`),
  shots: () => req<Shot[]>('/api/snipers/shots'),
  watchMany: (chain: string, wallets: string[], label?: string) => req('/api/watchlist/bulk', { method: 'POST', body: JSON.stringify({ chain, wallets, label }) }),
  alerts: () => req<Alert[]>('/api/alerts'),
  settings: () => req<AlertSettings>('/api/settings'),
  saveSettings: (s: AlertSettings) => req<AlertSettings>('/api/settings', { method: 'PUT', body: JSON.stringify(s) }),
  testAlert: () => req('/api/alerts/test', { method: 'POST' }),
};
