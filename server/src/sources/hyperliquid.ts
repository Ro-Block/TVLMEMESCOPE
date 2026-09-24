import { getJson, num } from '../http.ts';

// Public Hyperliquid leaderboard (same data as app.hyperliquid.xyz/leaderboard). The same address
// controls the user's HyperEVM wallet, so top HL traders are watched on HyperEVM pairs.
const URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';

export interface HlTrader {
  wallet: string;
  label?: string;
  accountValue: number;
  monthPnl: number;
  monthRoi: number;
  monthVolume: number;
  allTimePnl: number;
}

interface Row {
  ethAddress: string;
  accountValue: string;
  displayName?: string | null;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
}

export async function leaderboard(limit = 200): Promise<HlTrader[]> {
  const res = await getJson<{ leaderboardRows: Row[] }>('hyperliquid', URL, { timeoutMs: 30_000 });
  return (res.leaderboardRows ?? [])
    .map((r) => {
      const w = Object.fromEntries(r.windowPerformances ?? []);
      return {
        wallet: r.ethAddress.toLowerCase(),
        label: r.displayName ?? undefined,
        accountValue: num(r.accountValue),
        monthPnl: num(w.month?.pnl),
        monthRoi: num(w.month?.roi),
        monthVolume: num(w.month?.vlm),
        allTimePnl: num(w.allTime?.pnl),
      };
    })
    // "Legit" filter: real size, positive month and all-time, not a pure volume farmer.
    .filter((t) => t.accountValue > 250_000 && t.monthPnl > 0 && t.allTimePnl > 0 && t.monthVolume < t.accountValue * 400)
    .sort((a, b) => b.monthPnl - a.monthPnl)
    .slice(0, limit);
}
