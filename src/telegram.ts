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

/**
 * Call Telegram Bot API getFile to resolve a file_id to a downloadable file_path.
 * Returns the file_path on success, null on failure.
 */
export async function getFilePath(
  config: Config,
  fileId: string,
): Promise<string | null> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/getFile`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  if (!response.ok) {
    console.error(JSON.stringify({ event: 'telegram_get_file_error', status: response.status, fileId }));
    return null;
  }

  const result = await response.json() as { ok: boolean; result?: { file_path?: string } };
  return result.result?.file_path ?? null;
}

/**
 * Download a file from Telegram's file server.
 * Returns the Response (for streaming to R2), or null on failure.
 */
export async function downloadTelegramFile(
  config: Config,
  filePath: string,
): Promise<Response | null> {
  const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  const response = await fetch(url);

  if (!response.ok) {
    console.error(JSON.stringify({ event: 'telegram_download_error', status: response.status, filePath }));
    return null;
  }

  return response;
}
