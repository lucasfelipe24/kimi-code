import {
  createKimiHarness,
  createKimiHarnessV2,
  maskTelegramToken,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { createKimiCodeHostIdentity } from '#/cli/version';

import { isKimiV2Enabled } from '../experimental-v2';

interface WritableLike {
  write(chunk: string): boolean;
}

interface ReadStreamLike {
  isRaw?: boolean;
  setRawMode?(mode: boolean): void;
  resume(): void;
  on(event: string, listener: (data: Buffer) => void): void;
  off(event: string, listener: (data: Buffer) => void): void;
}

export interface NotifyDeps {
  readonly getHarness: () => KimiHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly env: NodeJS.ProcessEnv;
  readonly promptToken: (input: ReadStreamLike, output: WritableLike) => Promise<string>;
  readonly close: () => Promise<void>;
}

interface SetupOptions {
  readonly token?: string;
  readonly chatId?: string;
}

export async function handleNotifySetup(
  deps: NotifyDeps,
  options: SetupOptions,
): Promise<void> {
  const token = await resolveToken(deps, options.token);
  if (token.length === 0) {
    deps.stderr.write('Telegram bot token is required.\n');
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();

  const result = await harness.runTelegramSetup({
    token,
    chatId: options.chatId,
    interactive: true,
  });

  if (!result.ok) {
    deps.stderr.write(`${result.detail}\n`);
    deps.exit(1);
  }

  deps.stdout.write(
    `Telegram notifications configured.\n  Chat: ${result.chatId}\n  Token fingerprint: ${result.tokenFingerprint}\n`,
  );
}

export async function handleNotifyStatus(deps: NotifyDeps): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getTelegramConfig();

  if (config.botToken === undefined || config.botToken.length === 0) {
    deps.stdout.write('Telegram notifications are not configured.\n');
    deps.stdout.write(`Run "kimi notify setup" to configure them.\n`);
    return;
  }

  const lines: string[] = [
    'Telegram notifications',
    `  Token: ${maskTelegramToken(config.botToken)}`,
    `  Chat ID: ${config.chatId ?? '(not set)'}`,
    `  Enabled: ${config.enabled === false ? 'no' : 'yes'}`,
  ];

  deps.stdout.write(`${lines.join('\n')}\n`);
}

export function registerNotifyCommand(parent: Command, deps?: Partial<NotifyDeps>): void {
  const notify = parent.command('notify').description('Configure Telegram notifications.');

  notify
    .command('setup')
    .description('Pair a Telegram bot and save the notification config.')
    .option('--token <token>', 'Telegram bot token. Falls back to interactive prompt.')
    .option('--chat-id <chatId>', 'Existing private-chat ID. If omitted, pair by messaging the bot.')
    .action(async (options: { token?: string; chatId?: string }) => {
      const resolved = resolveNotifyDeps(deps);
      try {
        await handleNotifySetup(resolved, {
          token: options.token,
          chatId: options.chatId,
        });
      } catch (error) {
        resolved.stderr.write(`${formatError(error)}\n`);
        resolved.exit(1);
      } finally {
        await resolved.close();
      }
    });

  notify
    .command('status')
    .description('Show the Telegram notification config.')
    .action(async () => {
      const resolved = resolveNotifyDeps(deps);
      try {
        await handleNotifyStatus(resolved);
      } catch (error) {
        resolved.stderr.write(`${formatError(error)}\n`);
        resolved.exit(1);
      } finally {
        await resolved.close();
      }
    });
}

function resolveNotifyDeps(overrides: Partial<NotifyDeps> = {}): NotifyDeps {
  let harness: KimiHarness | undefined;
  const identity = createKimiCodeHostIdentity();

  return {
    getHarness:
      overrides.getHarness ??
      (() => {
        harness ??= (isKimiV2Enabled() ? createKimiHarnessV2 : createKimiHarness)({ identity });
        return harness;
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    env: overrides.env ?? process.env,
    promptToken: overrides.promptToken ?? promptMaskedToken,
    close: async () => {
      await harness?.close();
    },
  };
}

async function resolveToken(deps: NotifyDeps, flag: string | undefined): Promise<string> {
  if (flag !== undefined) return flag.trim();

  const input = deps.env['__NOTIFY_TEST_STDIN__']
    ? (JSON.parse(deps.env['__NOTIFY_TEST_STDIN__']) as ReadStreamLike)
    : process.stdin;
  if (!input.isRaw && typeof input.setRawMode !== 'function') {
    deps.stderr.write('Non-interactive terminal: pass --token <token>.\n');
    deps.exit(1);
  }

  return deps.promptToken(input, deps.stdout);
}

async function promptMaskedToken(
  input: ReadStreamLike,
  output: WritableLike,
): Promise<string> {
  output.write('Telegram bot token: ');
  const hadRawMode = input.isRaw ?? false;
  if (typeof input.setRawMode === 'function') {
    input.setRawMode(true);
  }
  input.resume();

  return new Promise<string>((resolve, reject) => {
    const chars: string[] = [];

    const cleanup = (): void => {
      input.off('data', onData);
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(hadRawMode);
      }
      output.write('\n');
    };

    const onData = (buffer: Buffer): void => {
      const str = buffer.toString('utf8');
      for (const ch of str) {
        const code = ch.codePointAt(0) ?? 0;
        if (code === 13 || code === 10) {
          cleanup();
          resolve(chars.join(''));
          return;
        }
        if (code === 3) {
          cleanup();
          reject(new Error('Cancelled'));
          return;
        }
        if (code === 127 || code === 8) {
          if (chars.length > 0) {
            chars.pop();
            output.write('\b \b');
          }
          continue;
        }
        if (code >= 32) {
          chars.push(ch);
          output.write('*');
        }
      }
    };

    input.on('data', onData);
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
