import { TelegramBotApiClient, type TelegramBotUser } from './botApi';
import { sanitizeDiagnostic, tokenFingerprint } from './redact';

export const DEFAULT_TELEGRAM_SETUP_TIMEOUT_MS = 60_000;
export const DEFAULT_TELEGRAM_SETUP_INTERVAL_MS = 1_000;

export type TelegramSetupStatus = 'ok' | 'error' | 'cancelled';

export interface TelegramSetupSuccess {
  readonly ok: true;
  readonly chatId: string;
  readonly tokenFingerprint: string;
}

export interface TelegramSetupFailure {
  readonly ok: false;
  readonly status: TelegramSetupStatus;
  readonly detail: string;
}

export type TelegramSetupResult = TelegramSetupSuccess | TelegramSetupFailure;

export interface TelegramSetupDeps {
  readonly client: TelegramBotApiClient;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface RunTelegramSetupInput {
  readonly token: string;
  readonly chatId?: string;
  readonly interactive?: boolean;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new TelegramAbortError());
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(new TelegramAbortError());
    };
    const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

class TelegramAbortError extends Error {
  constructor() {
    super('Telegram setup cancelled.');
    this.name = 'AbortError';
  }
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || /\baborted\b|\bcancelled\b/i.test(error.message))
  );
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TelegramAbortError();
}

function failure(token: string, status: TelegramSetupStatus, detail: string): TelegramSetupFailure {
  return { ok: false, status, detail: sanitizeDiagnostic(detail, token) };
}

export async function validateTelegramBotToken(input: {
  readonly token: string;
  readonly client: TelegramBotApiClient;
  readonly signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly bot: TelegramBotUser } | TelegramSetupFailure> {
  const token = input.token.trim();
  if (token.length === 0) return failure(input.token, 'error', 'Telegram bot token is required.');
  try {
    assertNotAborted(input.signal);
    const bot = await input.client.getMe(input.signal);
    return { ok: true, bot };
  } catch (error) {
    if (isAbortError(error)) return failure(token, 'cancelled', 'Telegram setup cancelled.');
    return failure(
      token,
      'error',
      error instanceof Error ? error.message : 'Telegram getMe failed.',
    );
  }
}

export async function validateTelegramPrivateChat(input: {
  readonly token: string;
  readonly chatId: string;
  readonly client: TelegramBotApiClient;
  readonly signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly chatId: string } | TelegramSetupFailure> {
  const token = input.token.trim();
  const requestedChatId = input.chatId.trim();
  if (requestedChatId.length === 0) return failure(token, 'error', 'Telegram chat id is required.');
  try {
    assertNotAborted(input.signal);
    const chat = await input.client.getChat(requestedChatId, input.signal);
    if (chat.type !== 'private') {
      return failure(
        token,
        'error',
        `Provided chat id ${requestedChatId} is a ${chat.type} chat; pairing requires a private Telegram chat.`,
      );
    }
    return { ok: true, chatId: String(chat.id) };
  } catch (error) {
    if (isAbortError(error)) return failure(token, 'cancelled', 'Telegram setup cancelled.');
    return failure(
      token,
      'error',
      error instanceof Error ? error.message : 'Telegram getChat failed.',
    );
  }
}

export async function discoverPrivateTelegramChat(input: {
  readonly token: string;
  readonly client: TelegramBotApiClient;
  readonly pollTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly ok: true; readonly chatId: string } | TelegramSetupFailure> {
  const token = input.token.trim();
  const sleep = defaultSleep;
  const timeoutMs = Math.max(0, input.pollTimeoutMs ?? DEFAULT_TELEGRAM_SETUP_TIMEOUT_MS);
  const intervalMs = Math.max(0, input.pollIntervalMs ?? DEFAULT_TELEGRAM_SETUP_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  const maxAttempts = Math.max(1, Math.ceil(timeoutMs / Math.max(intervalMs, 1)) + 1);
  let sawRejectedChatType: string | undefined;

  try {
    assertNotAborted(input.signal);
    const stale = await input.client.getUpdates({ offset: undefined, timeout: 0, allowedUpdates: ['message'], signal: input.signal });
    let offset = nextOffset(stale);

    for (let attempt = 0; attempt < maxAttempts && Date.now() <= deadline; attempt++) {
      assertNotAborted(input.signal);
      const updates = await input.client.getUpdates({ offset, timeout: 0, allowedUpdates: ['message'], signal: input.signal });
      offset = nextOffset(updates, offset);
      for (const update of updates) {
        const chat = update.message?.chat;
        if (chat === undefined) continue;
        if (chat.type === 'private') return { ok: true, chatId: String(chat.id) };
        if (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel') {
          sawRejectedChatType = chat.type;
        }
      }
      if (attempt + 1 >= maxAttempts) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, remaining), input.signal);
    }
    if (sawRejectedChatType !== undefined) {
      return failure(token, 'error', `Pairing rejected ${sawRejectedChatType} chat; message the bot from a private chat.`);
    }
    return failure(token, 'error', 'Timed out waiting for a private Telegram message to pair notifications.');
  } catch (error) {
    if (isAbortError(error)) return failure(token, 'cancelled', 'Telegram setup cancelled.');
    if (error instanceof Error && /\b409\b|\bconflict\b/i.test(error.message)) {
      return failure(token, 'error', 'Telegram pairing stopped because another poller owns this bot.');
    }
    return failure(token, 'error', error instanceof Error ? error.message : 'Telegram getUpdates failed.');
  }
}

export async function runTelegramSetup(input: RunTelegramSetupInput): Promise<TelegramSetupResult> {
  const token = input.token.trim();
  const client = new TelegramBotApiClient({ botToken: token });
  const validation = await validateTelegramBotToken({ token, client, signal: input.signal });
  if (!validation.ok) return validation;

  let chatResult: { readonly ok: true; readonly chatId: string } | TelegramSetupFailure;
  if (input.chatId !== undefined && input.chatId.trim().length > 0) {
    chatResult = await validateTelegramPrivateChat({ token, chatId: input.chatId, client, signal: input.signal });
  } else {
    chatResult = await discoverPrivateTelegramChat({
      token,
      client,
      pollTimeoutMs: input.pollTimeoutMs,
      pollIntervalMs: input.pollIntervalMs,
      signal: input.signal,
    });
  }
  if (!chatResult.ok) return chatResult;

  return {
    ok: true,
    chatId: chatResult.chatId,
    tokenFingerprint: tokenFingerprint(token),
  };
}

function nextOffset(updates: readonly { readonly updateId: number }[], fallback?: number): number | undefined {
  let max = fallback === undefined ? undefined : fallback - 1;
  for (const update of updates) {
    if (Number.isSafeInteger(update.updateId) && (max === undefined || update.updateId > max)) {
      max = update.updateId;
    }
  }
  return max === undefined ? fallback : max + 1;
}
