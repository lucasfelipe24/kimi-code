/**
 * Telegram config + pairing SDK surface (agent-core-v2 only).
 *
 * Wiring: real v2 engine bootstrapped on a temp KIMI_CODE_HOME; the Bot API is
 * stubbed through the `fetchImpl` seam so these tests never hit Telegram.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createKimiHarnessV2,
  maskTelegramToken,
  telegramTokenFingerprint,
} from '#/index';
import {
  drainQueryStoreDisposals,
  drainSessionIndexMirror,
} from '@moonshot-ai/agent-core-v2';

import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await drainSessionIndexMirror();
  await drainQueryStoreDisposals();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function makeHarness(): Promise<{ harness: ReturnType<typeof createKimiHarnessV2>; homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-telegram-'));
  tempDirs.push(homeDir);
  return { harness: createKimiHarnessV2({ homeDir, identity: TEST_IDENTITY }), homeDir };
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function botResponse(bot: unknown): Response {
  return okResponse(bot);
}

function chatResponse(chat: unknown): Response {
  return okResponse(chat);
}

function updatesResponse(updates: unknown): Response {
  return okResponse(updates);
}

function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('SDK telegram config', () => {
  it('reads an empty telegram section by default', async () => {
    const { harness } = await makeHarness();

    const config = await harness.getTelegramConfig();

    expect(config).toEqual({});
  });

  it('deep-merges a telegram config patch and persists it', async () => {
    const { harness, homeDir } = await makeHarness();

    await harness.setTelegramConfig({ enabled: true, chatId: '12345' });
    const config = await harness.getTelegramConfig();

    expect(config.enabled).toBe(true);
    expect(config.chatId).toBe('12345');

    await harness.setTelegramConfig({ threaded: true });
    const merged = await harness.getTelegramConfig();

    expect(merged.enabled).toBe(true);
    expect(merged.chatId).toBe('12345');
    expect(merged.threaded).toBe(true);

    const toml = await readFile(join(homeDir, 'config.toml'), 'utf-8');
    expect(toml).toContain('[telegram]');
    expect(toml).toContain('chat_id = "12345"');
    expect(toml).toContain('enabled = true');
    expect(toml).toContain('threaded = true');
  });

  it('preserves other fields when runTelegramSetup writes token + chatId + enabled', async () => {
    const { harness } = await makeHarness();
    await harness.setTelegramConfig({ threaded: true, verbosity: 'verbose' });

    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(botResponse({ id: 1, is_bot: true, first_name: 'Bot' }))
      .mockResolvedValueOnce(chatResponse({ id: 42, type: 'private' }));

    const result = await harness.runTelegramSetup({
      token: '12345:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      chatId: '42',
      fetchImpl,
    });

    expect(result.ok).toBe(true);

    const config = await harness.getTelegramConfig();
    expect(config.enabled).toBe(true);
    expect(config.chatId).toBe('42');
    expect(config.botToken).toBe('12345:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(config.threaded).toBe(true);
    expect(config.verbosity).toBe('verbose');
  });
});

describe('SDK telegram setup', () => {
  it('validates an explicit private chat id and persists the section', async () => {
    const { harness, homeDir } = await makeHarness();
    const token = '12345:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(botResponse({ id: 1, is_bot: true }))
      .mockResolvedValueOnce(chatResponse({ id: 42, type: 'private' }));

    const result = await harness.runTelegramSetup({ token, chatId: '42', fetchImpl });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe('42');
    expect(result.tokenFingerprint).toBe(telegramTokenFingerprint(token));

    const config = await harness.getTelegramConfig();
    expect(config.botToken).toBe(token);
    expect(config.chatId).toBe('42');
    expect(config.enabled).toBe(true);

    const toml = await readFile(join(homeDir, 'config.toml'), 'utf-8');
    expect(toml).toContain('[telegram]');
    expect(toml).toContain('chat_id = "42"');
    expect(toml).toContain('enabled = true');
  });

  it('discovers a private chat from updates when no chat id is given', async () => {
    const { harness } = await makeHarness();
    const token = '12345:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(botResponse({ id: 1, is_bot: true }))
      .mockResolvedValueOnce(updatesResponse([]))
      .mockResolvedValueOnce(
        updatesResponse([
          {
            update_id: 1,
            message: { message_id: 1, chat: { id: 99, type: 'private' }, text: 'hi' },
          },
        ]),
      );

    const result = await harness.runTelegramSetup({
      token,
      pollTimeoutMs: 500,
      pollIntervalMs: 10,
      fetchImpl,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.chatId).toBe('99');

    const config = await harness.getTelegramConfig();
    expect(config.chatId).toBe('99');
    expect(config.enabled).toBe(true);
  });

  it('returns a failure when the token is invalid', async () => {
    const { harness } = await makeHarness();
    const fetchImpl = vi.fn().mockResolvedValue(unauthorizedResponse());

    const result = await harness.runTelegramSetup({
      token: 'bad-token',
      chatId: '42',
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('error');
    expect(result.detail).not.toContain('bad-token');
  });

  it('returns a failure when the provided chat id is a group', async () => {
    const { harness } = await makeHarness();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(botResponse({ id: 1, is_bot: true }))
      .mockResolvedValueOnce(chatResponse({ id: -1, type: 'supergroup' }));

    const result = await harness.runTelegramSetup({
      token: '12345:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      chatId: '-1',
      fetchImpl,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe('error');
  });
});

describe('SDK telegram token masking', () => {
  it('masks a non-empty token', () => {
    const token = '12345:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const masked = maskTelegramToken(token);
    expect(masked.startsWith('1234…')).toBe(true);
    expect(masked).toContain(`len ${String(token.length)}`);
    expect(masked).not.toContain(token.slice(4));
  });

  it('reports unset for missing or empty tokens', () => {
    expect(maskTelegramToken(undefined)).toBe('(unset)');
    expect(maskTelegramToken('')).toBe('(unset)');
  });
});
