import { describe, expect, it, vi } from 'vitest';

import { Error2 } from '#/errors';
import {
  TelegramBotApiClient,
  TELEGRAM_MESSAGE_LIMIT,
} from '#/features/telegram/botApi';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: headers ?? { 'Content-Type': 'application/json' },
  });
}

function makeClient(fetchImpl: typeof fetch): TelegramBotApiClient {
  return new TelegramBotApiClient({ botToken: 'secret-token', fetchImpl, timeoutMs: 100 });
}

describe('TelegramBotApiClient', () => {
  it('getMe returns bot user', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, result: { id: 1, is_bot: true, first_name: 'Bot', username: 'bot' } }),
    );
    const client = makeClient(fetchImpl);
    const bot = await client.getMe();

    expect(bot.id).toBe(1);
    expect(bot.username).toBe('bot');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = new URL(fetchImpl.mock.calls[0]![0]);
    expect(url.pathname).toContain('/botsecret-token/getMe');
  });

  it('getUpdates normalizes messages and callback queries', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        result: [
          {
            update_id: 10,
            message: {
              message_id: 100,
              chat: { id: 42, type: 'private' },
              text: 'hello',
            },
          },
          {
            update_id: 11,
            callback_query: { id: 'cq1', from: { id: 7 }, message: { message_id: 100, chat: { id: 42, type: 'private' } }, data: 'a:b' },
          },
          { update_id: 12 },
        ],
      }),
    );
    const client = makeClient(fetchImpl);
    const updates = await client.getUpdates({});

    expect(updates).toHaveLength(2);
    expect(updates[0]!.updateId).toBe(10);
    expect(updates[0]!.message?.text).toBe('hello');
    expect(updates[1]!.callbackQuery?.id).toBe('cq1');
  });

  it('sendMessage returns message id and truncates text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 7 } }));
    const client = makeClient(fetchImpl);
    const id = await client.sendMessage({ chatId: 42, text: 'hi' });

    expect(id).toBe(7);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { chat_id: number; text: string };
    expect(body.chat_id).toBe(42);
    expect(body.text).toBe('hi');
  });

  it('retries on 429 with Retry-After and succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'Too Many Requests' }), { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 9 } }));
    const client = makeClient(fetchImpl);
    const id = await client.sendMessage({ chatId: 1, text: 'x' });

    expect(id).toBe(9);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('honors retry_after from 429 response body', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 1 } }), { status: 429 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 10 } }));
    const client = makeClient(fetchImpl);
    const id = await client.sendMessage({ chatId: 1, text: 'x' });

    expect(id).toBe(10);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  }, 5000);

  it('honors large Retry-After values without clamping', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: 'Too Many Requests' }), { status: 429, headers: { 'Retry-After': '2' } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 11 } }));
    const client = new TelegramBotApiClient({ botToken: 'secret-token', fetchImpl, timeoutMs: 100, retryAfterMaxMs: 100 });
    const start = Date.now();
    const id = await client.sendMessage({ chatId: 1, text: 'x' });
    const elapsed = Date.now() - start;

    expect(id).toBe(11);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(1500);
  }, 5000);

  it('backs off on 409 conflicts across attempts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Conflict' }), { status: 409 }),
    );
    const client = makeClient(fetchImpl);
    const start = Date.now();
    await expect(client.sendMessage({ chatId: 1, text: 'x' })).rejects.toThrow(Error2);
    const elapsed = Date.now() - start;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeGreaterThanOrEqual(3000);
  }, 5000);

  it('throws TelegramApiError for non-retryable HTTP errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Bad Request' }), { status: 400 }),
    );
    const client = makeClient(fetchImpl);

    await expect(client.sendMessage({ chatId: 1, text: 'x' })).rejects.toThrow(Error2);
  });

  it('sendPhoto posts multipart form and returns message id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 3 } }));
    const client = makeClient(fetchImpl);
    const blob = new Blob(['pixels'], { type: 'image/png' });
    const id = await client.sendPhoto({ chatId: 5, file: blob, filename: 'pic.png', caption: 'cat' });

    expect(id).toBe(3);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('respects the message limit', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 1 } }));
    const client = makeClient(fetchImpl);
    const longText = 'a'.repeat(TELEGRAM_MESSAGE_LIMIT + 100);
    await client.sendMessage({ chatId: 1, text: longText });

    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as { text: string };
    expect(body.text.length).toBe(TELEGRAM_MESSAGE_LIMIT);
  });

  it('includes api base override in request url', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { id: 1 } }));
    const client = new TelegramBotApiClient({ botToken: 't', apiBase: 'https://tg.example.com/api', fetchImpl });
    await client.getMe();

    const url = fetchImpl.mock.calls[0]![0] as string;
    expect(url.startsWith('https://tg.example.com/api/bott/getMe')).toBe(true);
  });
});
