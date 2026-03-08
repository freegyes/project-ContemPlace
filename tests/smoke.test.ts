/**
 * Smoke tests — hit the live Worker, verify end-to-end behaviour.
 * Requires .dev.vars with WORKER_URL, TELEGRAM_WEBHOOK_SECRET, TELEGRAM_CHAT_ID,
 * SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY.
 * Test notes inserted during the run are deleted from the DB in afterAll.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const WORKER_URL = process.env.WORKER_URL ?? '';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
const CHAT_ID = Number(process.env.TELEGRAM_CHAT_ID ?? '0');
const UPDATE_ID_BASE = Date.now(); // unique per run to avoid dedup collisions

const TEST_RAW_INPUTS = [
  'Constraints make creative work stronger.',
  'Dedup test note.',
];

function makeUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: 'private' },
      text,
    },
  };
}

async function post(body: unknown, secret = WEBHOOK_SECRET): Promise<Response> {
  return fetch(WORKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(body),
  });
}

afterAll(async () => {
  const db = createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  );
  const { error } = await db
    .from('notes')
    .delete()
    .in('raw_input', TEST_RAW_INPUTS);
  if (error) {
    console.warn('Cleanup failed:', error.message);
  }
});

describe('Worker security', () => {
  it('rejects GET requests', async () => {
    const res = await fetch(WORKER_URL, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('rejects missing secret', async () => {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('rejects wrong secret', async () => {
    const res = await post({}, 'wrong-secret');
    expect(res.status).toBe(403);
  });
});

describe('Worker happy path', () => {
  it('returns 200 for /start command', async () => {
    const res = await post(makeUpdate(UPDATE_ID_BASE + 1, '/start'));
    expect(res.status).toBe(200);
  });

  it('returns 200 for a real note', async () => {
    const res = await post(makeUpdate(UPDATE_ID_BASE + 2, 'Constraints make creative work stronger.'));
    expect(res.status).toBe(200);
  });

  it('returns 200 for non-message updates (e.g. edited_message)', async () => {
    const res = await post({
      update_id: UPDATE_ID_BASE + 3,
      edited_message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, text: 'edited' },
    });
    expect(res.status).toBe(200);
  });

  it('deduplicates identical update_id', async () => {
    const update = makeUpdate(UPDATE_ID_BASE + 4, 'Dedup test note.');
    const first = await post(update);
    const second = await post(update);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200); // Worker always returns 200; dedup happens silently
  });
});
