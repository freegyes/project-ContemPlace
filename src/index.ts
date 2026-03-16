import type { Env, TelegramUpdate, ServiceCaptureResult, UndoResult } from './types';
import { loadConfig } from './config';
import { sendTelegramMessage, sendTypingAction } from './telegram';
import { createSupabaseClient, tryClaimUpdate } from './db';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const config = loadConfig(env);

    // ── 1. Verify webhook secret ─────────────────────────────────────────────
    const incomingSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!incomingSecret || incomingSecret !== config.telegramWebhookSecret) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── 2. Parse body ────────────────────────────────────────────────────────
    let update: TelegramUpdate;
    try {
      const raw: unknown = await request.json();
      update = raw as TelegramUpdate;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // ── 3. Guard non-message updates ─────────────────────────────────────────
    if (!update.message) {
      return new Response('ok', { status: 200 });
    }

    const message = update.message;
    const chatId = message.chat.id;

    // ── 4. Chat ID whitelist ─────────────────────────────────────────────────
    if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(chatId)) {
      console.warn(JSON.stringify({ event: 'unauthorized_chat', chatId }));
      return new Response('ok', { status: 200 });
    }

    // ── 5. Guard non-text messages ───────────────────────────────────────────
    const text = message.text ?? message.caption;
    if (!text) {
      ctx.waitUntil(
        sendTelegramMessage(config, chatId, 'I can only process text for now. Send a text message.')
      );
      return new Response('ok', { status: 200 });
    }

    // ── 6. /start command ────────────────────────────────────────────────────
    if (text.trim() === '/start') {
      ctx.waitUntil(
        sendTelegramMessage(config, chatId, 'ContemPlace is running. Send me any text to capture it.')
      );
      return new Response('ok', { status: 200 });
    }

    // ── 6b. /undo command ──────────────────────────────────────────────────
    if (text.trim() === '/undo') {
      ctx.waitUntil(processUndo(env, config, chatId));
      return new Response('ok', { status: 200 });
    }

    // ── 7. Dedup check ───────────────────────────────────────────────────────
    const db = createSupabaseClient(config);
    const isNew = await tryClaimUpdate(db, update.update_id);
    if (!isNew) {
      return new Response('ok', { status: 200 });
    }

    // ── 8. Return 200, process in background ─────────────────────────────────
    ctx.waitUntil(processCapture(env, config, chatId, text));
    return new Response('ok', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function processCapture(
  env: Env,
  config: { telegramBotToken: string; telegramWebhookSecret: string; allowedChatIds: number[]; supabaseUrl: string; supabaseServiceRoleKey: string },
  chatId: number,
  text: string,
): Promise<void> {
  try {
    // Send typing indicator while the pipeline runs
    await sendTypingAction(config, chatId);

    // Delegate capture to MCP Worker via Service Binding RPC
    const result: ServiceCaptureResult = await env.CAPTURE_SERVICE.capture(text, 'telegram');

    if (result.corrections?.length) {
      console.log(JSON.stringify({ event: 'corrections', corrections: result.corrections, chatId }));
    }

    // Format HTML reply from the rich result
    const reply = formatTelegramReply(result);

    await sendTelegramMessage(config, chatId, reply, 'HTML');
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      event: 'capture_error',
      error: errorMessage,
      chatId,
      textPreview: text.slice(0, 100),
    }));
    await sendTelegramMessage(
      config,
      chatId,
      'Something went wrong capturing that. Check the Worker logs for details.',
    );
  }
}

async function processUndo(
  env: Env,
  config: { telegramBotToken: string; telegramWebhookSecret: string; allowedChatIds: number[]; supabaseUrl: string; supabaseServiceRoleKey: string },
  chatId: number,
): Promise<void> {
  try {
    const result: UndoResult = await env.CAPTURE_SERVICE.undoLatest();

    let reply: string;
    switch (result.action) {
      case 'deleted':
        reply = `Undone: <b>${escapeHtml(result.title!)}</b>`;
        break;
      case 'grace_period_passed':
        reply = 'The grace period has passed. To archive a note, use an MCP session.';
        break;
      case 'none':
        reply = 'Nothing to undo — no recent Telegram captures.';
        break;
    }

    await sendTelegramMessage(config, chatId, reply, 'HTML');
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: 'undo_error', error: errorMessage, chatId }));
    await sendTelegramMessage(config, chatId, 'Something went wrong with undo. Try again.');
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Visual indicators for Telegram reply ─────────────────────────────────────
// Emojis give each classification a consistent visual anchor so the user can
// spot behavioral patterns at a glance without reading every label.

const LINK_EMOJI: Record<string, string> = {
  contradicts: '⚡', related: '🔗',
};
function formatTelegramReply(result: ServiceCaptureResult): string {
  const esc = escapeHtml;
  const sep = '──────────────────────';

  // Title and body are prominent — everything else is italic metadata
  const lines: string[] = [
    `<b>${esc(result.title)}</b>`,
    '',
    esc(result.body),
    '',
    sep,
    `<i>🏷️ ${result.tags.map(esc).join(', ')}</i>`,
  ];

  const linkedEntries = result.links
    .filter(l => l.to_title)
    .map(l => {
      const icon = LINK_EMOJI[l.link_type] ?? '🔗';
      return `<i>${icon} ${esc(l.to_title)} (${l.link_type})</i>`;
    });

  if (linkedEntries.length > 0) {
    lines.push(linkedEntries.join('\n'));
  }

  if (result.corrections?.length) {
    lines.push(`<i>✏️ ${result.corrections.map(esc).join(', ')}</i>`);
  }

  if (result.source_ref) {
    lines.push(`<i>📎 ${esc(result.source_ref)}</i>`);
  }

  return lines.join('\n').slice(0, 4096);
}
