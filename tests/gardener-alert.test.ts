import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendAlert } from '../gardener/src/alert';
import type { Env } from '../gardener/src/types';

const BASE_ENV: Env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  GARDENER_SIMILARITY_THRESHOLD: '0.70',
  TELEGRAM_BOT_TOKEN: 'test-bot-token',
  TELEGRAM_ALERT_CHAT_ID: '12345',
};

function env(overrides: Partial<Env> = {}): Env {
  return { ...BASE_ENV, ...overrides };
}

// ── sendAlert ────────────────────────────────────────────────────────────────

describe('sendAlert', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends a POST to the Telegram API with the error message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendAlert(env(), new Error('DB connection timeout'));

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://api.telegram.org/bottest-bot-token/sendMessage');
    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.chat_id).toBe('12345');
    expect(body.parse_mode).toBe('HTML');
    expect(body.text).toContain('Gardener failed');
    expect(body.text).toContain('DB connection timeout');
  });

  it('does nothing when TELEGRAM_BOT_TOKEN is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendAlert(env({ TELEGRAM_BOT_TOKEN: undefined }), 'some error');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does nothing when TELEGRAM_ALERT_CHAT_ID is missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendAlert(env({ TELEGRAM_ALERT_CHAT_ID: undefined }), 'some error');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does nothing when both alert secrets are missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendAlert(env({ TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_ALERT_CHAT_ID: undefined }), 'err');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('escapes HTML characters in the error message', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendAlert(env(), new Error('Expected <tag> & "value"'));

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain('&lt;tag&gt;');
    expect(body.text).toContain('&amp;');
    expect(body.text).not.toContain('<tag>');
  });

  it('truncates long error messages to 1000 characters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
    const longError = 'x'.repeat(2000);

    await sendAlert(env(), longError);

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    // The <pre> content should be at most 1000 chars of the error
    const preMatch = body.text.match(/<pre>(.*?)<\/pre>/s);
    expect(preMatch).toBeTruthy();
    expect(preMatch![1].length).toBeLessThanOrEqual(1000);
  });

  it('never throws even when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    // Should not throw
    await expect(sendAlert(env(), 'gardener broke')).resolves.toBeUndefined();
  });

  it('never throws even when fetch throws synchronously', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('sync explosion');
    });

    await expect(sendAlert(env(), 'gardener broke')).resolves.toBeUndefined();
  });

  it('handles non-Error objects as the error argument', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendAlert(env(), { code: 'ECONNREFUSED', message: 'refused' });

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain('Gardener failed');
    // String({code: ...}) produces [object Object], but that's fine — it's a fallback
    expect(body.text).toContain('<pre>');
  });

  it('handles string errors', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));

    await sendAlert(env(), 'plain string error');

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toContain('plain string error');
  });
});
