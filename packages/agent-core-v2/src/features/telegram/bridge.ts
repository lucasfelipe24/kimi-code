import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Service } from '#/_base/di/service';
import type { IDisposable } from '#/_base/di/lifecycle';
import { ILogService } from '#/_base/log/log';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { MAIN_AGENT_ID, IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { AssistantDelta, ThinkingDelta, TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { ToolCallStarted, ToolResultEvent } from '#/agent/toolExecutor/toolExecutorEvents';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ISessionBtwService } from '#/features/btw/btw';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionQuestionService } from '#/session/question/question';
import type { ContentPart } from '#/kosong/contract/message';

import { type TelegramUpdate } from './botApi';
import {
  ITelegramGatewayService,
  normalizeInboundCallback,
  normalizeInboundChatId,
  normalizeInboundText,
} from './gateway';
import type { TelegramConfig } from './configSection';
import {
  buildCompactChoiceGrid,
  bold,
  finalizeTelegramHtml,
  markdownToTelegramHtml,
  numberedOptionList,
  truncateTelegramHtml,
} from './htmlFormat';

export interface ISessionTelegramBridge {
  readonly _serviceBrand: undefined;
}

export const ISessionTelegramBridge: ServiceIdentifier<ISessionTelegramBridge> =
  createDecorator<ISessionTelegramBridge>('sessionTelegramBridge');

interface AgentStreamState {
  turnId: number;
  messageId?: number;
  text: string;
  header: string;
  toolMessages: Map<string, { readonly messageId: number; readonly name: string }>;
}

interface SentQuestion {
  readonly interactionId: string;
  readonly questionIndex: number;
  readonly messageId: number;
}

const CALLBACK_QUESTION_PREFIX = 'q:';

export class SessionTelegramBridge extends Service implements ISessionTelegramBridge {
  declare readonly _serviceBrand: undefined;

  private readonly agentStreams = new Map<string, AgentStreamState>();
  private readonly btwAgentIds = new Set<string>();
  private readonly sentQuestions = new Map<string, SentQuestion>();
  private telegramConfig: TelegramConfig = {};

  constructor(
    @ITelegramGatewayService private readonly gateway: ITelegramGatewayService,
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @ISessionQuestionService private readonly questions: ISessionQuestionService,
    @ISessionBtwService private readonly btw: ISessionBtwService,
    @IConfigService private readonly configService: IConfigService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.readConfig();
    this._register(this.gateway.registerInbound((update) => {
      this.handleInbound(update);
    }));
    this._register(
      this.configService.onDidSectionChange((e) => {
        if (e.domain === 'telegram') this.readConfig();
      }),
    );
    this._register(
      this.lifecycle.onDidCreate((agent) => {
        this.attachAgent(agent.id);
      }),
    );
    this._register(
      this.lifecycle.onDidDispose((agentId) => {
        this.agentStreams.delete(agentId);
        this.btwAgentIds.delete(agentId);
      }),
    );
    for (const agent of this.lifecycle.list()) {
      this.attachAgent(agent.id);
    }
    this._register(
      this.interaction.onDidChangePending(() => {
        this.bridgeQuestions();
      }),
    );
  }

  private readConfig(): void {
    this.telegramConfig = this.configService.get<TelegramConfig>('telegram') ?? {};
  }

  private attachAgent(agentId: string): void {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) return;
    const bus = handle.accessor.get(IEventBus);
    this._register(bus.subscribe(TurnStarted, (e) => { this.onTurnStarted(agentId, e); }));
    this._register(bus.subscribe(AssistantDelta, (e) => { this.onAssistantDelta(agentId, e); }));
    this._register(bus.subscribe(ThinkingDelta, (e) => { this.onThinkingDelta(agentId, e); }));
    this._register(bus.subscribe(TurnEnded, (e) => { this.onTurnEnded(agentId, e); }));
    this._register(bus.subscribe(ToolCallStarted, (e) => { this.onToolCallStarted(agentId, e); }));
    this._register(bus.subscribe(ToolResultEvent, (e) => { this.onToolResult(agentId, e); }));
    this._register(bus.subscribe(AgentStatusUpdated, (e) => { this.onAgentStatusUpdated(agentId, e); }));
  }

  private onTurnStarted(agentId: string, event: TurnStarted): void {
    if (this.btwAgentIds.has(agentId)) return;
    const state: AgentStreamState = {
      turnId: event.turnId,
      text: '',
      header: this.buildHeader(agentId),
      toolMessages: new Map(),
    };
    this.agentStreams.set(agentId, state);
  }

  private onAssistantDelta(agentId: string, event: AssistantDelta): void {
    if (this.btwAgentIds.has(agentId)) return;
    const state = this.agentStreams.get(agentId);
    if (state === undefined || state.turnId !== event.turnId) return;
    state.text += event.delta;
    void this.flushAgentStream(state);
  }

  private onThinkingDelta(agentId: string, event: ThinkingDelta): void {
    if (this.btwAgentIds.has(agentId)) return;
    if (this.telegramConfig.verbosity !== 'verbose') return;
    const state = this.agentStreams.get(agentId);
    if (state === undefined || state.turnId !== event.turnId) return;
    state.text += event.delta;
    void this.flushAgentStream(state);
  }

  private onTurnEnded(agentId: string, event: TurnEnded): void {
    if (this.btwAgentIds.has(agentId)) return;
    const state = this.agentStreams.get(agentId);
    if (state === undefined || state.turnId !== event.turnId) return;
    const footer = event.reason === 'completed' ? '' : `\n\n${bold(`Turn ${event.reason}`)}`;
    state.text += footer;
    void this.flushAgentStream(state, true);
    this.agentStreams.delete(agentId);
  }

  private onToolCallStarted(agentId: string, event: ToolCallStarted): void {
    if (this.btwAgentIds.has(agentId)) return;
    if (this.telegramConfig.toolActivity?.enabled !== true) return;
    const state = this.agentStreams.get(agentId);
    if (state === undefined || state.turnId !== event.turnId) return;
    const text = `🔧 ${event.name}`;
    void this.gateway.sendMessage({ text, parseMode: 'HTML' })
      .then((messageId) => {
        if (messageId > 0) state.toolMessages.set(event.toolCallId, { messageId, name: event.name });
      })
      .catch((error) => {
        this.log.warn(`telegram tool activity send failed: ${String(error)}`);
      });
  }

  private onToolResult(agentId: string, event: ToolResultEvent): void {
    if (this.btwAgentIds.has(agentId)) return;
    if (this.telegramConfig.toolActivity?.enabled !== true) return;
    const state = this.agentStreams.get(agentId);
    if (state === undefined || state.turnId !== event.turnId) return;
    const tool = state.toolMessages.get(event.toolCallId);
    if (tool === undefined) return;
    const icon = event.isError === true ? '❌' : '✅';
    void this.gateway.editMessage(tool.messageId, `${icon} ${tool.name}`).catch((error) => {
      this.log.warn(`telegram tool activity edit failed: ${String(error)}`);
    });
  }

  private onAgentStatusUpdated(agentId: string, event: AgentStatusUpdated): void {
    if (this.btwAgentIds.has(agentId)) return;
    const state = this.agentStreams.get(agentId);
    if (state === undefined) return;
    state.header = this.buildHeader(agentId, event);
  }

  private buildHeader(agentId: string, status?: AgentStatusUpdated): string {
    const parts: string[] = [bold(agentId)];
    if (status?.model !== undefined) parts.push(status.model);
    if (status?.contextTokens !== undefined) parts.push(`${String(status.contextTokens)} tokens`);
    return parts.join(' · ');
  }

  private async flushAgentStream(state: AgentStreamState, finalize = false): Promise<void> {
    const html = this.formatStreamMessage(state, finalize);
    if (html.length === 0) return;
    try {
      if (state.messageId === undefined) {
        const messageId = await this.gateway.sendMessage({ text: html, parseMode: 'HTML' });
        if (messageId > 0) state.messageId = messageId;
      } else {
        await this.gateway.editMessage(state.messageId, html);
      }
    } catch (error) {
      this.log.warn(`telegram stream flush failed: ${String(error)}`);
    }
  }

  private formatStreamMessage(state: AgentStreamState, finalize: boolean): string {
    if (this.telegramConfig.redact === true) {
      return finalize ? 'response ready (redacted)' : '';
    }
    const header = state.header.length > 0 ? `${state.header}\n\n` : '';
    const body = markdownToTelegramHtml(state.text);
    const result = `${header}${body}`;
    const html = finalize ? finalizeTelegramHtml(result) ?? '' : result;
    return truncateTelegramHtml(html);
  }

  private bridgeQuestions(): void {
    const pending = this.interaction.listPending('question');
    const seen = new Set<string>();
    for (const interaction of pending) {
      const payload = interaction.payload as {
        readonly questions?: readonly { readonly question: string; readonly options?: readonly { readonly label: string }[] }[];
      };
      const questions = payload.questions ?? [];
      for (let qIndex = 0; qIndex < questions.length; qIndex++) {
        const key = `${interaction.id}:${String(qIndex)}`;
        seen.add(key);
        if (this.sentQuestions.has(key)) continue;
        const question = questions[qIndex];
        if (question === undefined) continue;
        const labels = question.options?.map((o) => o.label) ?? [];
        if (labels.length === 0) continue;
        const body = `${bold(question.question)}\n\n${numberedOptionList(labels)}`;
        const buttons = buildCompactChoiceGrid(labels, (optionIndex) =>
          `${CALLBACK_QUESTION_PREFIX}${interaction.id}:${String(qIndex)}:${String(optionIndex)}`,
        );
        void this.gateway
          .sendMessage({ text: body, parseMode: 'HTML', inlineButtons: buttons })
          .then((messageId) => {
            if (messageId > 0) this.sentQuestions.set(key, { interactionId: interaction.id, questionIndex: qIndex, messageId });
          })
          .catch((error) => {
            this.log.warn(`telegram question send failed: ${String(error)}`);
          });
      }
    }
    for (const [key, sent] of this.sentQuestions) {
      if (!seen.has(key)) {
        void this.gateway.editMessage(sent.messageId, bold('Answered')).catch((error) => {
          this.log.warn(`telegram question dismiss failed: ${String(error)}`);
        });
        this.sentQuestions.delete(key);
      }
    }
  }

  private handleInbound(update: TelegramUpdate): void {
    const chatId = normalizeInboundChatId(update);
    if (this.gateway.gatewayState.chatId === undefined || chatId !== this.gateway.gatewayState.chatId) return;

    const callback = normalizeInboundCallback(update);
    if (callback !== undefined && callback.data !== undefined) {
      void this.handleCallback(callback.id, callback.data).catch((error) => {
        this.log.warn(`telegram inbound callback failed: ${String(error)}`);
      });
      return;
    }

    const text = normalizeInboundText(update);
    if (text === undefined || text.length === 0) return;

    const btwQuestion = this.parseBtwCommand(text);
    if (btwQuestion !== undefined) {
      void this.handleBtw(btwQuestion).catch((error) => {
        this.log.warn(`telegram /btw failed: ${String(error)}`);
      });
      return;
    }

    const handle = this.lifecycle.get(MAIN_AGENT_ID);
    if (handle === undefined) return;
    const prompt = handle.accessor.get(IAgentPromptService);
    const parts: ContentPart[] = [{ type: 'text', text }];
    void prompt.submit({ input: parts }).catch((error) => {
      this.log.warn(`telegram prompt submit failed: ${String(error)}`);
    });
  }

  private parseBtwCommand(text: string): string | undefined {
    const match = /^\/btw(?:@\S+)?(?:\s+(.*))?$/s.exec(text);
    if (match === null) return undefined;
    const rest = match[1]?.trim() ?? '';
    return rest.length > 0 ? rest : '';
  }

  private async handleBtw(question: string): Promise<void> {
    if (this.telegramConfig.btw?.enabled === false) {
      await this.gateway.sendMessage({ text: 'BTW side questions are disabled.', parseMode: 'HTML' });
      return;
    }
    if (question.length === 0) {
      await this.gateway.sendMessage({ text: 'Usage: /btw <question>', parseMode: 'HTML' });
      return;
    }
    const agentId = await this.btw.start();
    this.btwAgentIds.add(agentId);
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) {
      this.btwAgentIds.delete(agentId);
      await this.gateway.sendMessage({ text: 'Failed to start BTW side question.', parseMode: 'HTML' });
      return;
    }
    const prompt = handle.accessor.get(IAgentPromptService);
    const bus = handle.accessor.get(IEventBus);
    const state = { turnId: -1, text: '' };
    const disposables: IDisposable[] = [
      bus.subscribe(TurnStarted, (e) => {
        if (state.turnId === -1) state.turnId = e.turnId;
      }),
      bus.subscribe(AssistantDelta, (e) => {
        if (e.turnId !== state.turnId) return;
        state.text += e.delta;
      }),
      bus.subscribe(TurnEnded, (e) => {
        if (e.turnId !== state.turnId) return;
        void this.sendBtwAnswer(state.text, e.reason === 'completed').finally(() => {
          this.cleanupBtw(agentId, disposables);
        });
      }),
    ];
    try {
      const result = await prompt.submit({ input: [{ type: 'text', text: question }] });
      if (result === undefined) {
        this.cleanupBtw(agentId, disposables);
        await this.gateway.sendMessage({ text: 'Failed to submit BTW question.', parseMode: 'HTML' });
        return;
      }
      state.turnId = result.turn_id;
    } catch (error) {
      this.cleanupBtw(agentId, disposables);
      await this.gateway.sendMessage({ text: 'Failed to submit BTW question.', parseMode: 'HTML' });
      this.log.warn(`telegram /btw submit failed: ${String(error)}`);
    }
  }

  private cleanupBtw(agentId: string, disposables: IDisposable[]): void {
    for (const d of disposables) d.dispose();
    this.btwAgentIds.delete(agentId);
  }

  private async sendBtwAnswer(text: string, completed: boolean): Promise<void> {
    const footer = completed ? '' : `\n\n${bold('Turn ended')}`;
    const body = this.telegramConfig.redact === true ? 'response ready (redacted)' : markdownToTelegramHtml(text);
    const html = `${body}${footer}`;
    try {
      await this.gateway.sendMessage({ text: html, parseMode: 'HTML' });
    } catch (error) {
      this.log.warn(`telegram /btw answer send failed: ${String(error)}`);
    }
  }

  private async handleCallback(callbackQueryId: string, data: string): Promise<void> {
    await this.gateway.answerCallbackQuery(callbackQueryId);
    if (!data.startsWith(CALLBACK_QUESTION_PREFIX)) return;
    const rest = data.slice(CALLBACK_QUESTION_PREFIX.length);
    const [interactionId, qIndexRaw, optionIndexRaw] = rest.split(':');
    if (interactionId === undefined || qIndexRaw === undefined || optionIndexRaw === undefined) return;
    const qIndex = Number(qIndexRaw);
    const optionIndex = Number(optionIndexRaw);
    if (!Number.isInteger(qIndex) || !Number.isInteger(optionIndex)) return;

    const pending = this.questions.listPending().find((q) => q.id === interactionId);
    if (pending === undefined) return;
    const question = pending.questions[qIndex];
    if (question === undefined) return;
    const option = question.options[optionIndex];
    if (option === undefined) return;

    this.questions.answer(interactionId, { answers: { [`q_${String(qIndex)}`]: option.label } });
    const key = `${interactionId}:${String(qIndex)}`;
    const sent = this.sentQuestions.get(key);
    if (sent !== undefined) {
      await this.gateway.editMessage(sent.messageId, `${bold(question.question)}\n\n${bold(`Selected: ${option.label}`)}`);
      this.sentQuestions.delete(key);
    }
  }
}
