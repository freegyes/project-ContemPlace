import type { Config } from './config';

export async function sendTelegramMessage(
  config: Config,
  chatId: number,
  text: string,
  parseMode?: 'HTML',
): Promise<void> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode) payload['parse_mode'] = parseMode;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(JSON.stringify({
      event: 'telegram_send_error',
      status: response.status,
      body,
      chatId,
    }));
  }
}

export async function sendTypingAction(
  config: Config,
  chatId: number,
): Promise<void> {
  await fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendChatAction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  });
}
