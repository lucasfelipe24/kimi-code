import { readFile } from 'node:fs/promises';

import {
  createKimiHarness,
  createKimiHarnessV2,
  createKimiConfigRpc,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';
import { parse as parseToml } from 'smol-toml';

import { createKimiCodeHostIdentity } from '#/cli/version';

import { isKimiV2Enabled } from '../experimental-v2';

const TELEGRAM_API_BASE = 'https://api.telegram.org';
const DEFAULT_SETUP_TIMEOUT_MS = 60_000;
const DEFAULT_SETUP_INTERVAL_MS = 1_000;
const TELEGRAM_BOT_TOKEN_ENV = 'KIMI_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID_ENV = 'KIMI_TELEGRAM_CHAT_ID';

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
  readonly fetch: typeof fetch;
  readonly readTextFile: (path: string) => Promise<string>;
  readonly resolveConfigPath: () => Promise<string>;
  readonly promptToken: (input: ReadStreamLike, output: WritableLike) => Promise<string>;
  readonly close: () => Promise<void>;
}

interface TelegramConfigSection {
  readonly botToken?: string;
  readonly chatId?: string;
  readonly enabled?: boolean;
}

interface TelegramBotUser {
  readonly id: number;
  readonly username?: string;
  readonly first_name?: string;
}

interface TelegramChat {
  readonly id: number | string;
  readonly type: string;
}

interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: {
    readonly chat: TelegramChat;
  };
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

  const bot = await validateToken(deps, token);
  const chatId = await resolveChatId(deps, token, options.chatId);

  await writeTelegramConfig(harness, { botToken: token, chatId, enabled: true });

  deps.stdout.write(
    `Telegram notifications configured.\n` +
      `  Bot: @${bot.username ?? String(bot.id)}\n` +
      `  Chat: ${chatId}\n`,
  );
}

export async function handleNotifyStatus(deps: NotifyDeps): Promise<void> {
  const config = await readTelegramConfig(deps);
  const effectiveToken = config?.botToken ?? deps.env[TELEGRAM_BOT_TOKEN_ENV];
  const effectiveChatId = config?.chatId ?? deps.env[TELEGRAM_CHAT_ID_ENV];

  if (effectiveToken === undefined || effectiveToken.length === 0) {
    deps.stdout.write('Telegram notifications are not configured.\n');
    deps.stdout.write(`Run "kimi notify setup" to configure them.\n`);
    return;
  }

  const lines: string[] = [
    'Telegram notifications',
    `  Token: ${maskToken(effectiveToken)}`,
  ];

  if (effectiveChatId !== undefined && effectiveChatId.length > 0) {
    lines.push(`  Chat ID: ${effectiveChatId}`);
  } else {
    lines.push(`  Chat ID: (not set)`);
  }

  lines.push(`  Enabled: ${config?.enabled === false ? 'no' : 'yes'}`);

  const connection = await testConnection(deps, effectiveToken);
  lines.push(`  Connection: ${connection}`);

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
    .description('Show the Telegram notification config and connection state.')
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
  const configRpc = createKimiConfigRpc();

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
    fetch: overrides.fetch ?? globalThis.fetch.bind(globalThis),
    readTextFile: overrides.readTextFile ?? ((path) => readFile(path, 'utf-8')),
    resolveConfigPath: overrides.resolveConfigPath ?? (() => configRpc.resolveConfigPath()),
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

async function validateToken(deps: NotifyDeps, token: string): Promise<TelegramBotUser> {
  try {
    const response = await telegramRequest<TelegramBotUser>(deps, token, 'getMe');
    return response;
  } catch (error) {
    throw new Error(`Invalid bot token: ${redactInMessage(formatError(error), token)}`, {
      cause: error,
    });
  }
}

async function resolveChatId(
  deps: NotifyDeps,
  token: string,
  explicitChatId: string | undefined,
): Promise<string> {
  if (explicitChatId !== undefined && explicitChatId.trim().length > 0) {
    const chatId = explicitChatId.trim();
    try {
      const chat = await telegramRequest<TelegramChat>(deps, token, 'getChat', { chat_id: chatId });
      if (chat.type !== 'private') {
        throw new Error(
          `Provided chat id ${chatId} is a ${chat.type} chat; pairing requires a private Telegram chat.`,
        );
      }
      return String(chat.id);
    } catch (error) {
      throw new Error(
        `Could not validate chat: ${redactInMessage(formatError(error), token)}`,
        { cause: error },
      );
    }
  }

  return discoverPrivateChat(deps, token);
}

async function discoverPrivateChat(deps: NotifyDeps, token: string): Promise<string> {
  const timeoutMs = DEFAULT_SETUP_TIMEOUT_MS;
  const intervalMs = DEFAULT_SETUP_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(intervalMs, 1)) + 1);
  let sawRejectedChatType: string | undefined;

  try {
    await flushStaleUpdates(deps, token);
    let offset: number | undefined;

    for (let attempt = 0; attempt < maxAttempts && Date.now() <= deadline; attempt++) {
      const updates = await telegramRequest<TelegramUpdate[]>(
        deps,
        token,
        'getUpdates',
        {
          offset,
          timeout: 0,
          allowed_updates: ['message'],
        },
        AbortSignal.timeout(Math.max(0, deadline - Date.now())),
      );
      offset = nextOffset(updates, offset);

      for (const update of updates) {
        const chat = update.message?.chat;
        if (chat === undefined) continue;
        if (chat.type === 'private') return String(chat.id);
        if (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel') {
          sawRejectedChatType = chat.type;
        }
      }

      if (attempt + 1 >= maxAttempts) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, remaining));
    }

    if (sawRejectedChatType !== undefined) {
      throw new Error(
        `Pairing rejected ${sawRejectedChatType} chat; message the bot from a private chat.`,
      );
    }
    throw new Error('Timed out waiting for a private Telegram message to pair notifications.');
  } catch (error) {
    if (error instanceof Error && /aborted|timeout/i.test(error.message)) {
      throw new Error('Telegram setup timed out.', { cause: error });
    }
    throw new Error(redactInMessage(formatError(error), token), { cause: error });
  }
}

async function flushStaleUpdates(deps: NotifyDeps, token: string): Promise<void> {
  const stale = await telegramRequest<TelegramUpdate[]>(deps, token, 'getUpdates', {
    offset: undefined,
    timeout: 0,
    allowed_updates: ['message'],
  });
  nextOffset(stale);
}

async function telegramRequest<T>(
  deps: NotifyDeps,
  token: string,
  method: string,
  body: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const url = `${TELEGRAM_API_BASE}/bot${token}/${method}`;
  const response = await deps.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  let payload: unknown;
  try {
    payload = (await response.json()) as { ok: boolean; result?: T; description?: string };
  } catch {
    throw new Error(`Telegram ${method} returned invalid JSON.`);
  }

  if (
    payload === null ||
    typeof payload !== 'object' ||
    !('ok' in payload) ||
    !(payload as { ok: boolean }).ok
  ) {
    const description =
      payload !== null && typeof payload === 'object' && 'description' in payload
        ? String((payload as { description?: string }).description)
        : response.statusText;
    throw new Error(`Telegram ${method} failed: HTTP ${String(response.status)} ${description}`);
  }

  return (payload as unknown as { result: T }).result;
}

function nextOffset(
  updates: readonly TelegramUpdate[],
  fallback?: number,
): number | undefined {
  let max = fallback === undefined ? undefined : fallback - 1;
  for (const update of updates) {
    if (Number.isSafeInteger(update.update_id) && (max === undefined || update.update_id > max)) {
      max = update.update_id;
    }
  }
  return max === undefined ? fallback : max + 1;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function writeTelegramConfig(
  harness: KimiHarness,
  section: TelegramConfigSection,
): Promise<void> {
  if (harness.supportsAtomicSectionReplace === undefined || !harness.supportsAtomicSectionReplace()) {
    throw new Error(
      'Telegram config persistence requires the v2 engine. Set KIMI_CODE_LEGACY_FLAG=0 or upgrade Kimi Code.',
    );
  }
  await harness.replaceConfigSections({ telegram: section });
}

async function readTelegramConfig(deps: NotifyDeps): Promise<TelegramConfigSection | undefined> {
  const path = await deps.resolveConfigPath();
  let text: string;
  try {
    text = await deps.readTextFile(path);
  } catch {
    return undefined;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const raw = parsed['telegram'];
  if (raw === undefined || raw === null || typeof raw !== 'object') {
    return undefined;
  }

  const section = raw as Record<string, unknown>;
  return {
    botToken: typeof section['bot_token'] === 'string' ? section['bot_token'] : undefined,
    chatId: typeof section['chat_id'] === 'string' ? section['chat_id'] : undefined,
    enabled: typeof section['enabled'] === 'boolean' ? section['enabled'] : undefined,
  };
}

async function testConnection(deps: NotifyDeps, token: string): Promise<string> {
  try {
    const bot = await telegramRequest<TelegramBotUser>(deps, token, 'getMe');
    const name = bot.username ?? bot.first_name ?? String(bot.id);
    return `connected as @${name}`;
  } catch (error) {
    return `error: ${redactInMessage(formatError(error), token)}`;
  }
}

export function maskToken(token: string): string {
  if (token.length === 0) return '(unset)';
  if (token.length <= 4) return `…(len ${String(token.length)})`;
  return `${token.slice(0, 4)}…(len ${String(token.length)})`;
}

function redactInMessage(message: string, token: string): string {
  if (token.length > 0) {
    return message.split(token).join(`[token:${maskToken(token)}]`);
  }
  return message;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
