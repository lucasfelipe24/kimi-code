/**
 * `/notify` slash-command tests.
 */

import { describe, expect, it, vi } from 'vitest';

import { handleNotifyCommand } from '#/tui/commands/notify';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

function makeHost(overrides: Partial<SlashCommandHost> = {}): {
  host: SlashCommandHost;
  notices: { title: string; detail?: string }[];
  errors: string[];
} {
  const notices: { title: string; detail?: string }[] = [];
  const errors: string[] = [];
  const host = {
    harness: { configPath: '/home/test/.kimi-code/config.toml' } as SlashCommandHost['harness'],
    showNotice: (title: string, detail?: string) => {
      notices.push({ title, detail });
    },
    showError: (msg: string) => {
      errors.push(msg);
    },
    ...overrides,
  } as SlashCommandHost;
  return { host, notices, errors };
}

describe('handleNotifyCommand', () => {
  it('shows setup instructions for /notify setup', async () => {
    const { host, notices } = makeHost();
    await handleNotifyCommand(host, 'setup');

    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain('Configure');
    expect(notices[0]!.detail).toContain('kimi notify setup');
  });

  it('reports unconfigured status', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockRejectedValue(new Error('not found'));

    const { host, notices } = makeHost();
    await handleNotifyCommand(host, 'status');

    expect(notices).toHaveLength(1);
    expect(notices[0]!.title).toContain('Telegram notifications');
    expect(notices[0]!.title).toContain('Telegram notifications');
  });

  it('shows masked token and chat id from config', async () => {
    const { readFile } = await import('node:fs/promises');
    vi.mocked(readFile).mockResolvedValue(
      '[telegram]\nbot_token = "1234567890:SECRET"\nchat_id = "987654321"\nenabled = true\n',
    );

    const { host, notices } = makeHost();
    await handleNotifyCommand(host, 'status');

    expect(notices[0]!.detail).toContain('Token: 1234…(len 17)');
    expect(notices[0]!.detail).toContain('Chat ID: 987654321');
    expect(notices[0]!.detail).toContain('Enabled: yes');
  });

  it('rejects unknown subcommands', async () => {
    const { host, errors } = makeHost();
    await handleNotifyCommand(host, 'bogus');

    expect(errors).toEqual(['Unknown /notify subcommand: bogus']);
  });
});
