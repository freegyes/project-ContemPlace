import type { Env, TelegramUpdate, ServiceCaptureResult } from './types';
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
        sendTelegramMessage(config, chatId, 'ContemPlace is running. Send me any text to capture it as a note.')
      );
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
      'Something went wrong capturing your note. Check the Worker logs for details.',
    );
  }
}

// ── Visual indicators for Telegram reply ─────────────────────────────────────
// Emojis give each classification a consistent visual anchor so the user can
// spot behavioral patterns at a glance without reading every label.

const TYPE_EMOJI: Record<string, string> = {
  idea: '💡', reflection: '🪞', source: '📎', lookup: '🔍',
};
const INTENT_EMOJI: Record<string, string> = {
  reflect: '🧘', plan: '🗺️', create: '🛠️', remember: '📌', reference: '📖', log: '📝',
};
const LINK_EMOJI: Record<string, string> = {
  extends: '🔗', contradicts: '⚡', supports: '🤝', 'is-example-of': '📐', 'duplicate-of': '♊',
};
const ENTITY_EMOJI: Record<string, string> = {
  person: '👤', place: '📍', tool: '🔧', project: '📦', concept: '💠',
};

function formatTelegramReply(result: ServiceCaptureResult): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const sep = '──────────────────────';

  const typeIcon = TYPE_EMOJI[result.type] ?? '❓';
  const intentIcon = INTENT_EMOJI[result.intent] ?? '❓';

  // Title and body are prominent — everything else is italic metadata
  const lines: string[] = [
    `<b>${esc(result.title)}</b>`,
    '',
    esc(result.body),
    '',
    sep,
    `<i>${typeIcon} ${result.type} · ${intentIcon} ${result.intent} · ${result.modality}</i>`,
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

  if (result.entities.length > 0) {
    const entityEntries = result.entities.map(e => {
      const icon = ENTITY_EMOJI[e.type] ?? '•';
      return `${icon} ${esc(e.name)}`;
    });
    lines.push(`<i>${entityEntries.join(', ')}</i>`);
  }

  return lines.join('\n').slice(0, 4096);
}
