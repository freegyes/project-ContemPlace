import type { Env } from './types';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Send a failure alert to Telegram. Best-effort — returns silently if
 * alert secrets are not configured or if the Telegram API call fails.
 * Never throws.
 */
export async function sendAlert(env: Env, error: unknown): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_ALERT_CHAT_ID) return;

  const detail = escapeHtml(String(error).slice(0, 1000));
  const text = `<b>Gardener failed</b>\n<pre>${detail}</pre>`;

  try {
    await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_ALERT_CHAT_ID,
          text,
          parse_mode: 'HTML',
        }),
      },
    );
  } catch {
    // Alert delivery failed — original error is already in console.error.
    // Nothing useful to do here.
  }
}
