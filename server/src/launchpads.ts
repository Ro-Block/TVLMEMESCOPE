// Works out which launchpad minted a token, from the DEX GeckoTerminal reports and the vanity
// suffix several launchpads grind into their token addresses. Suffix matches are heuristics.

interface Rule {
  name: string;
  chains: string[];
  dex?: RegExp;
  suffix?: RegExp;
}

const RULES: Rule[] = [
  { name: 'pump.fun', chains: ['solana'], dex: /^(pump-?fun|pumpswap|pump-swap)/i, suffix: /pump$/ },
  { name: 'letsbonk.fun', chains: ['solana'], dex: /launchlab|bonk/i, suffix: /bonk$/ },
  { name: 'boop.fun', chains: ['solana'], suffix: /boop$/ },
  { name: 'Bags', chains: ['solana'], suffix: /BAGS$/ },
  { name: 'Meteora DBC', chains: ['solana'], dex: /meteora-?dbc/i },
  { name: 'Moonshot', chains: ['solana'], dex: /moonshot/i },
  { name: 'Clanker', chains: ['base'], dex: /clanker/i, suffix: /b07$/i },
  { name: 'Zora', chains: ['base'], dex: /zora/i },
  { name: 'Virtuals', chains: ['base'], dex: /virtuals/i },
  { name: 'four.meme', chains: ['bsc'], dex: /four-?meme/i, suffix: /4444$/ },
  { name: 'Flap', chains: ['bsc'], dex: /flap/i },
  { name: 'LiquidLaunch', chains: ['hyperevm'], dex: /liquid-?launch/i },
];

export function detectLaunchpad(chain: string, dex: string, token: string): string | undefined {
  for (const r of RULES) {
    if (!r.chains.includes(chain)) continue;
    if ((r.dex && r.dex.test(dex)) || (r.suffix && r.suffix.test(token))) return r.name;
  }
  return undefined;
}
