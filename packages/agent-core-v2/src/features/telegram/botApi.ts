import { isAbortError } from '#/_base/utils/abort';
import { Error2, ErrorCodes } from '#/errors';

import { sanitizeDiagnostic } from './redact';

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_MESSAGE_LIMIT = 4096;

export interface TelegramBotApiOptions {
  botToken: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryAfterMaxMs?: number;
}

export interface TelegramBotUser {
  readonly id: number;
  readonly isBot?: boolean;
  readonly firstName?: string;
  readonly username?: string;
  readonly hasTopicsEnabled?: boolean;
  readonly allowsUsersToCreateTopics?: boolean;
}

export interface TelegramChat {
  readonly id: number | string;
  readonly type: string;
}

export interface TelegramUpdate {
  readonly updateId: number;
  readonly message?: TelegramMessage;
  readonly callbackQuery?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  readonly messageId: number;
  readonly chat: TelegramChat;
  readonly text?: string;
  readonly caption?: string;
  readonly messageThreadId?: number;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: TelegramDocument;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

export interface TelegramUser {
  readonly id: number;
}

export interface TelegramPhotoSize {
  readonly fileId: string;
}

export interface TelegramDocument {
  readonly fileId: string;
  readonly mimeType?: string;
  readonly fileName?: string;
}

export interface TelegramInlineButton {
  readonly text: string;
  readonly callbackData: string;
}

export interface TelegramSendMessageOptions {
  readonly chatId: string | number;
  readonly text: string;
  readonly parseMode?: 'HTML';
  readonly replyMarkup?: { readonly inlineKeyboard: readonly TelegramInlineButton[][] };
  readonly replyToMessageId?: number;
}

export interface TelegramSendFileOptions {
  readonly chatId: string | number;
  readonly file: Blob;
  readonly filename: string;
  readonly caption?: string;
}

interface TelegramApiResponse<T> {
  readonly ok: boolean;
  readonly result?: T;
  readonly description?: string;
  readonly parameters?: { readonly retry_after?: number };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_AFTER_MAX_MS = 5_000;

export class TelegramBotApiClient {
  private readonly botToken: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryAfterMaxMs: number;

  constructor(options: TelegramBotApiOptions) {
    this.botToken = options.botToken;
    this.apiBase = (options.apiBase ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.retryAfterMaxMs = Math.max(0, options.retryAfterMaxMs ?? DEFAULT_RETRY_AFTER_MAX_MS);
  }

  async getMe(signal?: AbortSignal): Promise<TelegramBotUser> {
    return this.requestJson<TelegramBotUser>('getMe', {}, signal);
  }

  async getChat(chatId: string | number, signal?: AbortSignal): Promise<TelegramChat> {
    return this.requestJson<TelegramChat>('getChat', { chat_id: chatId }, signal);
  }

  async getUpdates(input: {
    readonly offset?: number;
    readonly timeout?: number;
    readonly allowedUpdates?: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<readonly TelegramUpdate[]> {
    const body: Record<string, unknown> = {};
    if (input.offset !== undefined) body['offset'] = input.offset;
    if (input.timeout !== undefined) body['timeout'] = input.timeout;
    if (input.allowedUpdates !== undefined) body['allowed_updates'] = input.allowedUpdates;
    const updates = await this.requestJson<unknown[]>('getUpdates', body, input.signal);
    if (!Array.isArray(updates)) throw new TelegramApiError('getUpdates returned non-array result.');
    return updates.map((u) => normalizeUpdate(u)).filter((u): u is TelegramUpdate => u !== undefined);
  }

  async sendMessage(options: TelegramSendMessageOptions, signal?: AbortSignal): Promise<number> {
    const body: Record<string, unknown> = {
      chat_id: options.chatId,
      text: options.text.slice(0, TELEGRAM_MESSAGE_LIMIT),
    };
    if (options.parseMode !== undefined) body['parse_mode'] = options.parseMode;
    if (options.replyMarkup !== undefined) {
      body['reply_markup'] = { inline_keyboard: serializeInlineButtons(options.replyMarkup.inlineKeyboard) };
    }
    if (options.replyToMessageId !== undefined) body['reply_to_message_id'] = options.replyToMessageId;
    const result = await this.requestJson<Record<string, unknown>>('sendMessage', body, signal);
    return typeof result['message_id'] === 'number' ? result['message_id'] : 0;
  }

  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requestJson<unknown>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: text.slice(0, TELEGRAM_MESSAGE_LIMIT),
      parse_mode: 'HTML',
    }, signal);
  }

  async sendPhoto(options: TelegramSendFileOptions, signal?: AbortSignal): Promise<number> {
    const form = new FormData();
    form.append('chat_id', String(options.chatId));
    form.append('photo', options.file, options.filename);
    if (options.caption !== undefined) form.append('caption', options.caption.slice(0, TELEGRAM_MESSAGE_LIMIT));
    const result = await this.requestMultipart<Record<string, unknown>>('sendPhoto', form, signal);
    return typeof result['message_id'] === 'number' ? result['message_id'] : 0;
  }

  async sendDocument(options: TelegramSendFileOptions, signal?: AbortSignal): Promise<number> {
    const form = new FormData();
    form.append('chat_id', String(options.chatId));
    form.append('document', options.file, options.filename);
    if (options.caption !== undefined) form.append('caption', options.caption.slice(0, TELEGRAM_MESSAGE_LIMIT));
    const result = await this.requestMultipart<Record<string, unknown>>('sendDocument', form, signal);
    return typeof result['message_id'] === 'number' ? result['message_id'] : 0;
  }

  async answerCallbackQuery(callbackQueryId: string, signal?: AbortSignal): Promise<void> {
    await this.requestJson<unknown>('answerCallbackQuery', { callback_query_id: callbackQueryId }, signal);
  }

  async setMessageReaction(
    chatId: string | number,
    messageId: number,
    reaction: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requestJson<unknown>('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: JSON.stringify([{ type: 'emoji', emoji: reaction }]),
    }, signal);
  }

  async setMyCommands(commands: readonly { readonly command: string; readonly description: string }[], signal?: AbortSignal): Promise<void> {
    await this.requestJson<unknown>('setMyCommands', { commands }, signal);
  }

  private async requestJson<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const response = await this.request(method, { body: JSON.stringify(body), contentType: 'application/json', signal });
    return this.parseJson<T>(response, method);
  }

  private async requestMultipart<T>(method: string, body: FormData, signal?: AbortSignal): Promise<T> {
    const response = await this.request(method, { body, signal });
    return this.parseJson<T>(response, method);
  }

  private async request(
    method: string,
    options: { readonly body: RequestInit['body']; readonly contentType?: string; readonly signal?: AbortSignal },
  ): Promise<Response> {
    const url = `${this.apiBase}/bot${this.botToken}/${method}`;
    const headers = new Headers();
    if (options.contentType !== undefined) headers.set('Content-Type', options.contentType);
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, { method: 'POST', headers, body: options.body }, options.signal);
        if (response.ok) return response;
        const retryAfter = await extractRetryAfter(response);
        if (attempt + 1 < maxAttempts && isRetryableStatus(response.status)) {
          await response.body?.cancel();
          await this.waitBeforeRetry(retryAfter, options.signal, response.status, attempt);
          continue;
        }
        throw await this.apiError(response, method);
      } catch (error) {
        if (options.signal?.aborted === true) throw options.signal.reason ?? error;
        if (isAbortError(error)) throw error;
        if (error instanceof Error2) throw error;
        if (isTimeoutError(error)) throw error;
        if (attempt + 1 < maxAttempts) {
          await this.waitBeforeRetry(undefined, options.signal, undefined, attempt);
          continue;
        }
        throw new Error2(
          ErrorCodes.WEB_FETCH_FAILED,
          sanitizeDiagnostic(`Telegram ${method} failed: ${error instanceof Error ? error.message : String(error)}`, this.botToken),
        );
      }
    }

    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, `Telegram ${method} failed.`);
  }

  private async parseJson<T>(response: Response, method: string): Promise<T> {
    let payload: TelegramApiResponse<T>;
    try {
      payload = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        sanitizeDiagnostic(`Telegram ${method} returned invalid JSON.`, this.botToken),
      );
    }
    if (payload === null || typeof payload !== 'object' || !payload.ok) {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        sanitizeDiagnostic(
          `Telegram ${method} failed: ${payload?.description ?? response.statusText}`,
          this.botToken,
        ),
      );
    }
    return payload.result as T;
  }

  private async apiError(response: Response, method: string): Promise<Error2> {
    let description = response.statusText;
    try {
      const payload = (await response.json()) as TelegramApiResponse<unknown>;
      if (payload?.description !== undefined) description = payload.description;
    } catch {
    }
    return new Error2(
      ErrorCodes.WEB_FETCH_FAILED,
      sanitizeDiagnostic(`Telegram ${method} failed: HTTP ${String(response.status)} ${description}`, this.botToken),
      { details: { status: response.status } },
    );
  }

  private async fetchWithTimeout(
    url: string,
    init: Omit<RequestInit, 'signal'>,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    if (externalSignal?.aborted === true) {
      throw externalSignal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }

    const controller = new AbortController();
    const onExternalAbort = (): void => {
      controller.abort(externalSignal?.reason);
    };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const timeout =
      this.timeoutMs > 0
        ? setTimeout(() => {
            controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
          }, this.timeoutMs)
        : undefined;

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (externalSignal?.aborted) throw externalSignal.reason ?? error;
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async waitBeforeRetry(
    retryAfter: number | undefined,
    signal: AbortSignal | undefined,
    status?: number,
    attempt?: number,
  ): Promise<void> {
    let delayMs = 0;
    if (status === 429 && retryAfter !== undefined && retryAfter > 0) {
      delayMs = retryAfter;
    } else if (status === 409) {
      const base = 1000;
      const exponent = Math.max(0, attempt ?? 0);
      delayMs = Math.min(base * 2 ** exponent, 30_000);
    } else {
      delayMs = Math.min(retryAfter ?? 0, this.retryAfterMaxMs);
    }
    if (delayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  }
}

export class TelegramApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramApiError';
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 409 || status === 429 || status >= 500;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

async function extractRetryAfter(response: Response): Promise<number | undefined> {
  const header = response.headers.get('Retry-After');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  if (response.status === 429) {
    try {
      const payload = (await response.clone().json()) as TelegramApiResponse<unknown>;
      const retry = payload?.parameters?.retry_after;
      if (typeof retry === 'number' && retry >= 0) return retry * 1000;
    } catch {
    }
  }
  return undefined;
}

function serializeInlineButtons(rows: readonly TelegramInlineButton[][]): unknown[][] {
  return rows.map((row) =>
    row.map((b) => ({ text: b.text, callback_data: b.callbackData })),
  );
}

function normalizeUpdate(value: unknown): TelegramUpdate | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['update_id'] !== 'number' || !Number.isSafeInteger(raw['update_id'])) return undefined;
  const message = normalizeMessage(raw['message']);
  const callbackQuery = normalizeCallbackQuery(raw['callback_query']);
  if (message === undefined && callbackQuery === undefined) return undefined;
  return {
    updateId: raw['update_id'],
    message,
    callbackQuery,
  };
}

function normalizeMessage(value: unknown): TelegramMessage | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const chat = normalizeChat(raw['chat']);
  if (chat === undefined || typeof raw['message_id'] !== 'number') return undefined;
  return {
    messageId: raw['message_id'],
    chat,
    text: typeof raw['text'] === 'string' ? raw['text'] : undefined,
    caption: typeof raw['caption'] === 'string' ? raw['caption'] : undefined,
    messageThreadId: typeof raw['message_thread_id'] === 'number' ? raw['message_thread_id'] : undefined,
    photo: normalizePhoto(raw['photo']),
    document: normalizeDocument(raw['document']),
  };
}

function normalizeChat(value: unknown): TelegramChat | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if ((typeof raw['id'] !== 'number' && typeof raw['id'] !== 'string') || typeof raw['type'] !== 'string') return undefined;
  return { id: raw['id'], type: raw['type'] };
}

function normalizePhoto(value: unknown): readonly TelegramPhotoSize[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const sizes: TelegramPhotoSize[] = [];
  for (const item of value) {
    const itemRaw = item as Record<string, unknown>;
    if (item !== null && typeof item === 'object' && typeof itemRaw['file_id'] === 'string') {
      sizes.push({ fileId: itemRaw['file_id'] });
    }
  }
  return sizes.length > 0 ? sizes : undefined;
}

function normalizeDocument(value: unknown): TelegramDocument | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['file_id'] !== 'string') return undefined;
  return {
    fileId: raw['file_id'],
    mimeType: typeof raw['mime_type'] === 'string' ? raw['mime_type'] : undefined,
    fileName: typeof raw['file_name'] === 'string' ? raw['file_name'] : undefined,
  };
}

function normalizeCallbackQuery(value: unknown): TelegramCallbackQuery | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['id'] !== 'string') return undefined;
  return {
    id: raw['id'],
    from: typeof raw['from'] === 'object' && raw['from'] !== null ? (raw['from'] as TelegramUser) : { id: 0 },
    message: normalizeMessage(raw['message']),
    data: typeof raw['data'] === 'string' ? raw['data'] : undefined,
  };
}
