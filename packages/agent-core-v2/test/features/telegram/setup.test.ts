import { describe, expect, it, vi } from 'vitest';

import { TelegramBotApiClient } from '#/features/telegram/botApi';
import {
  discoverPrivateTelegramChat,
  runTelegramSetup,
  validateTelegramBotToken,
  validateTelegramPrivateChat,
} from '#/features/telegram/setup';

function makeClient(fetchImpl: typeof fetch): TelegramBotApiClient {
  return new TelegramBotApiClient({ botToken: 'secret-token', fetchImpl, timeoutMs: 100 });
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { headers: { 'Content-Type': 'application/json' } });
}

describe('validateTelegramBotToken', () => {
  it('rejects an empty token', async () => {
    const result = await validateTelegramBotToken({ token: '   ', client: makeClient(vi.fn()) });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe('error');
  });

  it('returns bot info for a valid token', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(ok({ id: 1, is_bot: true, first_name: 'Bot' })));
    const result = await validateTelegramBotToken({ token: 'tok', client });

    expect(result.ok).toBe(true);
    expect(result.ok && result.bot.id).toBe(1);
  });
});

describe('validateTelegramPrivateChat', () => {
  it('accepts a private chat', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(ok({ id: 42, type: 'private' })));
    const result = await validateTelegramPrivateChat({ token: 'tok', chatId: '42', client });

    expect(result.ok).toBe(true);
    expect(result.ok && result.chatId).toBe('42');
  });

  it('rejects a group chat', async () => {
    const client = makeClient(vi.fn().mockResolvedValue(ok({ id: -1, type: 'supergroup' })));
    const result = await validateTelegramPrivateChat({ token: 'tok', chatId: '-1', client });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe('error');
  });
});

describe('discoverPrivateTelegramChat', () => {
  it('finds a private chat from updates', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([{ update_id: 1, message: { message_id: 1, chat: { id: 99, type: 'private' }, text: 'hi' } }]));
    const client = makeClient(fetchImpl);
    const result = await discoverPrivateTelegramChat({ token: 'tok', client, pollTimeoutMs: 500, pollIntervalMs: 10 });

    expect(result.ok).toBe(true);
    expect(result.ok && result.chatId).toBe('99');
  });

  it('rejects a discovered group chat', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok([{ update_id: 1, message: { message_id: 1, chat: { id: -2, type: 'supergroup' }, text: 'hi' } }]));
    const client = makeClient(fetchImpl);
    const result = await discoverPrivateTelegramChat({ token: 'tok', client, pollTimeoutMs: 100, pollIntervalMs: 10 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe('error');
  });

  it('times out when no messages arrive', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]));
    const client = makeClient(fetchImpl);
    const result = await discoverPrivateTelegramChat({ token: 'tok', client, pollTimeoutMs: 50, pollIntervalMs: 10 });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.status).toBe('error');
  });
});

describe('runTelegramSetup', () => {
  it('pairs with a provided chat id', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ id: 1, is_bot: true }))
      .mockResolvedValueOnce(ok({ id: 42, type: 'private' }));
    vi.stubGlobal('fetch', fetchImpl);
    const result = await runTelegramSetup({ token: 'tok', chatId: '42', pollTimeoutMs: 50, pollIntervalMs: 10 });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(true);
    expect(result.ok && result.chatId).toBe('42');
    expect(result.ok && result.tokenFingerprint.length > 0).toBe(true);
  });

  it('fails for an invalid token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const result = await runTelegramSetup({ token: 'bad', chatId: '42', pollTimeoutMs: 50, pollIntervalMs: 10 });
    vi.unstubAllGlobals();

    expect(result.ok).toBe(false);
  });
});
