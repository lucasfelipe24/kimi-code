/**
 * `kimi notify` CLI unit tests. The handlers receive injected deps so we test
 * the wiring end-to-end without booting a real harness or hitting the network.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

import {
  handleNotifySetup,
  handleNotifyStatus,
  maskToken,
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
  supportsAtomicSectionReplace: () => boolean;
  replaceConfigSections: (sections: Record<string, unknown>) => Promise<void>;
  configPath: string;
  close: () => Promise<void>;
}

function makeHarness(): {
  harness: FakeHarness;
  replacedSections: Record<string, unknown>[];
} {
  const replacedSections: Record<string, unknown>[] = [];
  const harness: FakeHarness = {
    ensureConfigFile: async () => {},
    supportsAtomicSectionReplace: () => true,
    replaceConfigSections: async (sections) => {
      replacedSections.push(sections);
    },
    configPath: '/home/test/.kimi-code/config.toml',
    close: async () => {},
  };
  return { harness, replacedSections };
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
    fetch: vi.fn(),
    readTextFile: vi.fn(),
    resolveConfigPath: async () => harness.configPath,
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

function telegramFetch(responses: Record<string, unknown>): typeof fetch {
  return vi.fn(async (url: string) => {
    const method = url.split('/').pop() ?? '';
    const result = responses[method];
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ ok: true, result }),
    } as Response;
  }) as unknown as typeof fetch;
}

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('maskToken', () => {
  it('masks a long token to prefix and length', () => {
    expect(maskToken('1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ')).toMatch(/^1234…\(len \d+\)$/);
  });

  it('shows length for short tokens', () => {
    expect(maskToken('abc')).toBe('…(len 3)');
  });

  it('marks unset tokens', () => {
    expect(maskToken('')).toBe('(unset)');
  });
});

describe('handleNotifyStatus', () => {
  it('reports unconfigured when no token exists', async () => {
    const { harness } = makeHarness();
    const { deps, stdout } = makeDeps(harness, {
      readTextFile: async () => '[providers]\n',
    });

    await handleNotifyStatus(deps);

    expect(stdout.join('')).toContain('not configured');
  });

  it('shows masked token and chat id from config.toml', async () => {
    const { harness } = makeHarness();
    const { deps, stdout } = makeDeps(harness, {
      readTextFile: async () =>
        '[telegram]\nbot_token = "1234567890:SECRET"\nchat_id = "987654321"\nenabled = true\n',
      fetch: telegramFetch({ getMe: { id: 1, username: 'testbot' } }),
    });

    await handleNotifyStatus(deps);

    const output = stdout.join('');
    expect(output).toContain('Token: 1234…(len 17)');
    expect(output).toContain('Chat ID: 987654321');
    expect(output).toContain('Enabled: yes');
    expect(output).toContain('connected as @testbot');
  });

  it('falls back to environment variables', async () => {
    const { harness } = makeHarness();
    const { deps, stdout } = makeDeps(harness, {
      readTextFile: async () => '[providers]\n',
      env: {
        KIMI_TELEGRAM_BOT_TOKEN: '1234567890:ENVSECRET',
        KIMI_TELEGRAM_CHAT_ID: '111',
      },
      fetch: telegramFetch({ getMe: { id: 2, first_name: 'EnvBot' } }),
    });

    await handleNotifyStatus(deps);

    const output = stdout.join('');
    expect(output).toContain('Token: 1234…(len 20)');
    expect(output).toContain('Chat ID: 111');
  });
});

describe('handleNotifySetup', () => {
  it('writes telegram config when token and chat-id are provided', async () => {
    const { harness, replacedSections } = makeHarness();
    const { deps } = makeDeps(harness, {
      fetch: telegramFetch({
        getMe: { id: 1, username: 'testbot' },
        getChat: { id: 987654321, type: 'private' },
      }),
    });

    await handleNotifySetup(deps, { token: '1234567890:SECRET', chatId: '987654321' });

    expect(replacedSections).toHaveLength(1);
    expect(replacedSections[0]).toEqual({
      telegram: { botToken: '1234567890:SECRET', chatId: '987654321', enabled: true },
    });
  });

  it('discovers private chat when chat-id is omitted', async () => {
    const { harness, replacedSections } = makeHarness();
    let callCount = 0;
    const { deps } = makeDeps(harness, {
      fetch: vi.fn(async (url: string) => {
        callCount += 1;
        const method = url.split('/').pop() ?? '';
        const result = method === 'getMe' ? { id: 1, username: 'testbot' } : [{ update_id: 5, message: { chat: { id: 111, type: 'private' } } }];
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ ok: true, result }),
        } as Response;
      }) as unknown as typeof fetch,
    });

    await handleNotifySetup(deps, { token: '1234567890:SECRET' });

    expect(replacedSections[0]).toEqual({
      telegram: { botToken: '1234567890:SECRET', chatId: '111', enabled: true },
    });
  });

  it('rejects non-private explicit chat ids', async () => {
    const { harness } = makeHarness();
    const { deps } = makeDeps(harness, {
      fetch: telegramFetch({
        getMe: { id: 1, username: 'testbot' },
        getChat: { id: -1, type: 'group', title: 'Group' },
      }),
    });

    await expect(handleNotifySetup(deps, { token: '1234567890:SECRET', chatId: '-1' })).rejects.toThrow(
      'group chat',
    );
  });

  it('reports invalid tokens', async () => {
    const { harness } = makeHarness();
    const { deps } = makeDeps(harness, {
      fetch: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        json: async () => ({ ok: false, description: 'Unauthorized' }),
      } as Response),
    });

    await expect(handleNotifySetup(deps, { token: 'bad' })).rejects.toThrow('Invalid bot token');
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
