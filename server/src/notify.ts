import type { Alert, AlertSettings } from '../../shared/types.ts';
import { NOTIFY } from './config.ts';
import { postJson } from './http.ts';

export const notifyChannels = () => ({
  telegram: Boolean(NOTIFY.telegramToken && NOTIFY.telegramChat),
  discord: Boolean(NOTIFY.discordWebhook),
});

function text(a: Alert) {
  const lines = [a.message, ...a.wallets.slice(0, 5).map((w) => `• ${w.label ?? w.wallet} — $${Math.round(w.usd).toLocaleString()} (ROI ${(w.roi * 100).toFixed(0)}%, score ${w.legitScore})`)];
  if (a.pair.url) lines.push(a.pair.url);
  return lines.join('\n');
}

/** Push an alert to the configured external channels. The web UI gets it separately over SSE. */
export async function notify(a: Alert, st: AlertSettings) {
  const ch = notifyChannels();
  const jobs: Promise<void>[] = [];
  if (ch.telegram && st.telegram) {
    jobs.push(postJson(`https://api.telegram.org/bot${NOTIFY.telegramToken}/sendMessage`, { chat_id: NOTIFY.telegramChat, text: text(a), disable_web_page_preview: true }));
  }
  if (ch.discord && st.discord) jobs.push(postJson(NOTIFY.discordWebhook, { content: text(a).slice(0, 1900) }));
  await Promise.all(jobs);
}
