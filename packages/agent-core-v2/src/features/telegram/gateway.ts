import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import { type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { Error2, ErrorCodes } from '#/errors';

import { TelegramBotApiClient, type TelegramCallbackQuery, type TelegramInlineButton, type TelegramUpdate } from './botApi';
import { maskToken } from './redact';
import type { TelegramConfig } from './configSection';

export interface TelegramSendMessageInput {
  readonly text: string;
  readonly parseMode?: 'HTML';
  readonly inlineButtons?: readonly TelegramInlineButton[][];
}

export interface TelegramSendFileInput {
  readonly file: Blob;
  readonly filename: string;
  readonly caption?: string;
}

export interface TelegramGatewayState {
  readonly configured: boolean;
  readonly maskedToken: string;
  readonly chatId: string | undefined;
}

export interface ITelegramGatewayService {
  readonly _serviceBrand: undefined;

  readonly onUpdate: Event<TelegramUpdate>;
  readonly gatewayState: TelegramGatewayState;

  registerInbound(handler: (update: TelegramUpdate) => void): IDisposable;
  sendMessage(input: TelegramSendMessageInput): Promise<number>;
  editMessage(messageId: number, text: string): Promise<void>;
  sendPhoto(input: TelegramSendFileInput): Promise<number>;
  sendDocument(input: TelegramSendFileInput): Promise<number>;
  answerCallbackQuery(callbackQueryId: string): Promise<void>;
  setMessageReaction(messageId: number, reaction: string): Promise<void>;
}

export const ITelegramGatewayService: ServiceIdentifier<ITelegramGatewayService> =
  createDecorator<ITelegramGatewayService>('telegramGatewayService');

const POLL_TIMEOUT_SECONDS = 25;
const SEEN_UPDATE_IDS_MAX = 1000;
const LOCK_FILE = 'poller.lock';

interface PollerLock {
  release(): Promise<void>;
}

export class TelegramGatewayService extends Service implements ITelegramGatewayService {
  declare readonly _serviceBrand: undefined;

  private readonly _onUpdate = this._register(new Emitter<TelegramUpdate>('telegram-update'));
  readonly onUpdate: Event<TelegramUpdate> = this._onUpdate.event;

  private readonly handlers = new Set<(update: TelegramUpdate) => void>();
  private readonly seenUpdateIds = new Set<number>();
  private telegramConfig: TelegramConfig = {};
  private client: TelegramBotApiClient | undefined;
  private chatId: string | undefined;
  private configured = false;
  private running = false;
  private abortController: AbortController | undefined;
  private pollPromise: Promise<void> | undefined;
  private lock: PollerLock | undefined;
  private offset: number | undefined;

  constructor(
    @IConfigService private readonly configService: IConfigService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
  ) {
    super();
    this.reconfigure();
    this._register(
      this.configService.onDidSectionChange((e) => {
        if (e.domain === 'telegram') {
          this.reconfigure();
        }
      }),
    );
  }

  get gatewayState(): TelegramGatewayState {
    return {
      configured: this.configured,
      maskedToken: maskToken(this.telegramConfig.botToken),
      chatId: this.chatId,
    };
  }

  registerInbound(handler: (update: TelegramUpdate) => void): IDisposable {
    this.handlers.add(handler);
    return {
      dispose: () => {
        this.handlers.delete(handler);
      },
    };
  }

  async sendMessage(input: TelegramSendMessageInput): Promise<number> {
    if (!this.configured || this.client === undefined || this.chatId === undefined) return 0;
    return this.client.sendMessage(
      {
        chatId: this.chatId,
        text: input.text,
        parseMode: input.parseMode,
        replyMarkup: input.inlineButtons === undefined ? undefined : { inlineKeyboard: input.inlineButtons },
      },
      this.abortController?.signal,
    );
  }

  async editMessage(messageId: number, text: string): Promise<void> {
    if (!this.configured || this.client === undefined || this.chatId === undefined) return;
    await this.client.editMessageText(this.chatId, messageId, text, this.abortController?.signal);
  }

  async sendPhoto(input: TelegramSendFileInput): Promise<number> {
    if (!this.configured || this.client === undefined || this.chatId === undefined) return 0;
    return this.client.sendPhoto(
      { chatId: this.chatId, file: input.file, filename: input.filename, caption: input.caption },
      this.abortController?.signal,
    );
  }

  async sendDocument(input: TelegramSendFileInput): Promise<number> {
    if (!this.configured || this.client === undefined || this.chatId === undefined) return 0;
    return this.client.sendDocument(
      { chatId: this.chatId, file: input.file, filename: input.filename, caption: input.caption },
      this.abortController?.signal,
    );
  }

  async answerCallbackQuery(callbackQueryId: string): Promise<void> {
    if (!this.configured || this.client === undefined) return;
    await this.client.answerCallbackQuery(callbackQueryId, this.abortController?.signal);
  }

  async setMessageReaction(messageId: number, reaction: string): Promise<void> {
    if (!this.configured || this.client === undefined || this.chatId === undefined) return;
    await this.client.setMessageReaction(this.chatId, messageId, reaction, this.abortController?.signal);
  }

  private reconfigure(): void {
    const next = this.configService.get<TelegramConfig>('telegram') ?? {};
    const prev = this.telegramConfig;
    this.telegramConfig = next;
    const tokenChanged = prev.botToken !== next.botToken;
    const chatChanged = prev.chatId !== next.chatId;
    const enabledChanged = prev.enabled !== next.enabled;
    if (!tokenChanged && !chatChanged && !enabledChanged) return;

    void this.stop().then(() => {
      this.client = undefined;
      this.chatId = undefined;
      this.configured = false;
      const token = next.botToken?.trim();
      const chatId = next.chatId?.trim();
      if (token === undefined || token.length === 0) return;
      this.client = new TelegramBotApiClient({ botToken: token });
      this.chatId = chatId;
      this.configured = next.enabled !== false;
      if (!this.configured) return;
      this.start();
    });
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    this.abortController = new AbortController();
    this.pollPromise = this.runPoller();
  }

  private async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.abortController?.abort();
    this.abortController = undefined;
    try {
      await this.pollPromise;
    } catch {
    }
    this.pollPromise = undefined;
    if (this.lock !== undefined) {
      await this.lock.release();
      this.lock = undefined;
    }
  }

  private async runPoller(): Promise<void> {
    if (this.client === undefined) return;
    const lock = await acquirePollerLock(this.bootstrap.homeDir);
    if (lock === undefined) {
      this.running = false;
      return;
    }
    this.lock = lock;
    this.offset = undefined;

    while (this.running) {
      try {
        const updates = await this.client.getUpdates({
          offset: this.offset,
          timeout: POLL_TIMEOUT_SECONDS,
          allowedUpdates: ['message', 'callback_query'],
          signal: this.abortController?.signal,
        });
        for (const update of updates) {
          this.dispatch(update);
        }
      } catch (error) {
        if (this.abortController?.signal.aborted === true) break;
        if (error instanceof Error2 && error.code === ErrorCodes.WEB_FETCH_FAILED) {
          await sleep(1000);
        } else {
          await sleep(5000);
        }
      }
    }
  }

  private dispatch(update: TelegramUpdate): void {
    if (this.chatId === undefined) return;
    if (this.seenUpdateIds.has(update.updateId)) return;
    this.seenUpdateIds.add(update.updateId);
    while (this.seenUpdateIds.size > SEEN_UPDATE_IDS_MAX) {
      const first = this.seenUpdateIds.values().next().value;
      if (first !== undefined) this.seenUpdateIds.delete(first);
    }
    this.offset = update.updateId + 1;
    this._onUpdate.fire(update);
    for (const handler of this.handlers) {
      try {
        handler(update);
      } catch {
      }
    }
  }
}

async function acquirePollerLock(homeDir: string): Promise<PollerLock | undefined> {
  const dir = join(homeDir, 'telegram');
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, LOCK_FILE);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return {
        async release() {
          try {
            await unlink(lockPath);
          } catch {
          }
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') return undefined;
      const raw = await readLock(lockPath);
      if (raw !== undefined && pidAlive(raw)) return undefined;
      try {
        await unlink(lockPath);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function readLock(path: string): Promise<number | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => { resolve(); }, ms);
  });
}

export function normalizeInboundText(update: TelegramUpdate): string | undefined {
  return update.message?.text?.trim();
}

export function normalizeInboundCallback(update: TelegramUpdate): TelegramCallbackQuery | undefined {
  return update.callbackQuery;
}

export function normalizeInboundChatId(update: TelegramUpdate): string | undefined {
  const id = update.message?.chat.id ?? update.callbackQuery?.message?.chat.id;
  return id === undefined ? undefined : String(id);
}
