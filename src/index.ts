import type { Env, TelegramUpdate } from './types';
import { loadConfig, type Config } from './config';
import { sendTelegramMessage, sendTypingAction } from './telegram';
import { createOpenAIClient, embedText } from './embed';
import { createSupabaseClient, tryClaimUpdate, findRelatedNotes, insertNote, insertLinks, type SupabaseClientType } from './db';
import { runCaptureAgent } from './capture';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Only accept POST
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

    // ── 7. Dedup check (sync — fast DB call before returning 200) ────────────
    const db = createSupabaseClient(config);
    const isNew = await tryClaimUpdate(db, update.update_id);
    if (!isNew) {
      return new Response('ok', { status: 200 });
    }

    // ── 8. Return 200, process in background ─────────────────────────────────
    ctx.waitUntil(processCapture(config, chatId, text, db));
    return new Response('ok', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function processCapture(
  config: Config,
  chatId: number,
  text: string,
  db: SupabaseClientType,
): Promise<void> {
  try {
    const openai = createOpenAIClient(config);

    // Embed and send typing indicator concurrently
    const [embedding] = await Promise.all([
      embedText(openai, config, text),
      sendTypingAction(config, chatId),
    ]);

    // Find related notes
    const relatedNotes = await findRelatedNotes(db, embedding, config.matchThreshold);

    // Run capture LLM
    const capture = await runCaptureAgent(openai, config, text, relatedNotes);

    // Log corrections if the LLM found any
    if (capture.corrections?.length) {
      console.log(JSON.stringify({ event: 'corrections', corrections: capture.corrections, chatId }));
    }

    // Insert note and links
    const noteId = await insertNote(db, capture, embedding, text);
    await insertLinks(db, noteId, capture.links);

    // Build HTML confirmation reply
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sep = '──────────────────────';

    const lines: string[] = [
      `<b>${esc(capture.title)}</b>`,
      sep,
      esc(capture.body),
      '',
      `<i>${capture.type} · ${capture.tags.join(', ')}</i>`,
    ];

    const linkedTitles = capture.links
      .map(l => {
        const matched = relatedNotes.find(n => n.id === l.to_id);
        return matched ? `[[${esc(matched.title)}]]` : null;
      })
      .filter((t): t is string => t !== null);

    if (linkedTitles.length > 0) {
      lines.push(`Linked: ${linkedTitles.join(', ')}`);
    }

    if (capture.corrections?.length) {
      lines.push(`Corrections: ${capture.corrections.map(esc).join(', ')}`);
    }

    if (capture.source_ref) {
      lines.push(`Source: ${esc(capture.source_ref)}`);
    }

    await sendTelegramMessage(config, chatId, lines.join('\n'), 'HTML');
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
      `Something went wrong capturing your note.\n\nError: ${errorMessage}\n\nPlease try again.`,
    );
  }
}
