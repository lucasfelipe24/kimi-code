/**
 * `kimi notify` CLI unit tests. The handlers receive injected deps so we test
 * the wiring end-to-end without booting a real harness or hitting the network.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { maskTelegramToken, type TelegramConfig } from '@moonshot-ai/kimi-code-sdk';

import {
  handleNotifySetup,
  handleNotifyStatus,
  registerNotifyCommand,
  type NotifyDeps,
} from '#/cli/sub/notify';

const harnessRouting = vi.hoisted(() => ({
  kimiHarnessConstructor: vi.fn(),
  kimiHarnessV2Constructor: vi.fn(),
  harness: undefined as unknown,
}));

vi.mock('@moonshot-ai/kimi-code-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@moonshot-ai/kimi-code-sdk')>();
  return {
    ...actual,
    createKimiHarness: (...args: unknown[]) => {
      harnessRouting.kimiHarnessConstructor(...args);
      return harnessRouting.harness;
    },
    createKimiHarnessV2: (...args: unknown[]) => {
      harnessRouting.kimiHarnessV2Constructor(...args);
      return harnessRouting.harness;
    },
  };
});

class ExitCalled extends Error {
  constructor(public readonly code: number) {
    super(`exit(${code})`);
  }
}

interface FakeHarness {
  ensureConfigFile: () => Promise<void>;
  getTelegramConfig: () => Promise<TelegramConfig>;
  setTelegramConfig: (patch: TelegramConfig) => Promise<TelegramConfig>;
  runTelegramSetup: (input: {
    token: string;
    chatId?: string;
    interactive?: boolean;
  }) => Promise<{ readonly ok: true; readonly chatId: string; readonly tokenFingerprint: string } | { readonly ok: false; readonly status: string; readonly detail: string }>;
  close: () => Promise<void>;
}

function makeHarness(): FakeHarness {
  return {
    ensureConfigFile: async () => {},
    getTelegramConfig: async () => ({}),
    setTelegramConfig: async (patch) => patch,
    runTelegramSetup: async () => ({ ok: true, chatId: '111', tokenFingerprint: 'fp' }),
    close: async () => {},
  };
}

function makeDeps(
  harness: FakeHarness,
  overrides: Partial<NotifyDeps> = {},
): {
  deps: NotifyDeps;
  stdout: string[];
  stderr: string[];
  exitCodes: number[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const deps: NotifyDeps = {
    getHarness: () => harness as unknown as NotifyDeps extends { getHarness: () => infer R } ? R : never,
    stdout: {
      write: (chunk: string) => {
        stdout.push(chunk);
        return true;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr.push(chunk);
        return true;
      },
    },
    exit: ((code: number) => {
      exitCodes.push(code);
      throw new ExitCalled(code);
    }) as NotifyDeps['exit'],
    env: {},
    promptToken: async () => {
      throw new Error('Unexpected interactive prompt');
    },
    close: async () => {},
    ...overrides,
  };
  return { deps, stdout, stderr, exitCodes };
}

async function tryRun<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ExitCalled) return undefined;
    throw error;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maskTelegramToken', () => {
  it('masks a long token to prefix and length', () => {
    expect(maskTelegramToken('1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toMatch(/^1234…\(len \d+\)$/);
  });

  it('shows length for short tokens', () => {
    expect(maskTelegramToken('abc')).toBe('…(len 3)');
  });

  it('marks unset tokens', () => {
    expect(maskTelegramToken('')).toBe('(unset)');
  });
});

describe('handleNotifyStatus', () => {
  it('reports unconfigured when no token exists', async () => {
    const harness = makeHarness();
    const { deps, stdout } = makeDeps(harness);

    await handleNotifyStatus(deps);

    expect(stdout.join('')).toContain('not configured');
  });

  it('shows masked token and chat id from effective config', async () => {
    const harness = makeHarness();
    harness.getTelegramConfig = async () => ({
      botToken: '1234567890:SECRET',
      chatId: '987654321',
      enabled: true,
    });
    const { deps, stdout } = makeDeps(harness);

    await handleNotifyStatus(deps);

    const output = stdout.join('');
    expect(output).toContain('Token: 1234…(len 17)');
    expect(output).toContain('Chat ID: 987654321');
    expect(output).toContain('Enabled: yes');
  });

  it('reports disabled when enabled is false', async () => {
    const harness = makeHarness();
    harness.getTelegramConfig = async () => ({
      botToken: '1234567890:SECRET',
      chatId: '987654321',
      enabled: false,
    });
    const { deps, stdout } = makeDeps(harness);

    await handleNotifyStatus(deps);

    expect(stdout.join('')).toContain('Enabled: no');
  });
});

describe('handleNotifySetup', () => {
  it('calls SDK runTelegramSetup when token and chat-id are provided', async () => {
    const harness = makeHarness();
    const run = vi.fn().mockResolvedValue({
      ok: true,
      chatId: '987654321',
      tokenFingerprint: 'abc123',
    });
    harness.runTelegramSetup = run;
    const { deps, stdout } = makeDeps(harness);

    await handleNotifySetup(deps, { token: '1234567890:SECRET', chatId: '987654321' });

    expect(run).toHaveBeenCalledWith({
      token: '1234567890:SECRET',
      chatId: '987654321',
      interactive: true,
    });
    expect(stdout.join('')).toContain('Telegram notifications configured');
    expect(stdout.join('')).toContain('Chat: 987654321');
  });

  it('discovers private chat when chat-id is omitted', async () => {
    const harness = makeHarness();
    harness.runTelegramSetup = async (input) => ({
      ok: true,
      chatId: input.chatId ?? '111',
      tokenFingerprint: 'fp',
    });
    const { deps, stdout } = makeDeps(harness);

    await handleNotifySetup(deps, { token: '1234567890:SECRET' });

    expect(stdout.join('')).toContain('Chat: 111');
  });

  it('exits with SDK failure detail on failure', async () => {
    const harness = makeHarness();
    harness.runTelegramSetup = async () => ({
      ok: false,
      status: 'error',
      detail: 'Invalid bot token',
    });
    const { deps, stderr, exitCodes } = makeDeps(harness);

    await tryRun(() => handleNotifySetup(deps, { token: 'bad' }));

    expect(exitCodes).toEqual([1]);
    expect(stderr.join('')).toContain('Invalid bot token');
  });
});

describe('registerNotifyCommand', () => {
  it('registers setup and status subcommands', () => {
    const program = new Command();
    registerNotifyCommand(program);

    const notify = program.commands.find((c) => c.name() === 'notify');
    expect(notify).toBeDefined();
    expect(notify!.commands.map((c) => c.name())).toContain('setup');
    expect(notify!.commands.map((c) => c.name())).toContain('status');
  });
});
