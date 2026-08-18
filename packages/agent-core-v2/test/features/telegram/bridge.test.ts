import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Emitter } from '#/_base/event';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { Event2, type Event2Class } from '#/app/event/event2';
import { AssistantDelta, TurnStarted } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { ToolCallStarted, ToolResultEvent } from '#/agent/toolExecutor/toolExecutorEvents';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { ISessionBtwService } from '#/features/btw/btw';
import { SessionTelegramBridge, ISessionTelegramBridge } from '#/features/telegram/bridge';
import { ITelegramGatewayService } from '#/features/telegram/gateway';
import { IConfigService } from '#/app/config/config';
import { ILogService } from '#/_base/log/log';
import { MAIN_AGENT_ID, IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { ISessionQuestionService } from '#/session/question/question';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAgentScopeHandle } from '#/_base/di/scope';

class FakeEventBus implements IEventBus {
  readonly _serviceBrand = undefined;
  private readonly emitter = new Emitter<Event2<any>>('fake-bus');

  publish(event: Event2<any>): void {
    this.emitter.fire(event);
  }

  subscribe(handler: (event: Event2<any>) => void): IDisposable;
  subscribe<P, E extends Event2<P>>(cls: Event2Class<P, E>, handler: (event: E) => void): IDisposable;
  subscribe(type: string, handler: (event: Event2<any>) => void): IDisposable;
  subscribe(
    arg: string | Event2Class<any, any> | ((event: Event2<any>) => void),
    handler?: ((event: Event2<any>) => void) | ((event: any) => void),
  ): IDisposable {
    const expectedType = typeof arg === 'string' ? arg : typeof arg === 'function' && 'type' in arg ? arg.type : undefined;
    return this.emitter.event((event) => {
      if (expectedType === undefined || event.type === expectedType) {
        (handler as (event: any) => void)(event);
      }
    });
  }
}

function noOpEvent() {
  return { dispose: () => {} };
}

describe('SessionTelegramBridge', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let gatewaySendMessage: ReturnType<typeof vi.fn>;
  let gatewayEditMessage: ReturnType<typeof vi.fn>;
  let promptSubmit: ReturnType<typeof vi.fn>;
  let btwStart: ReturnType<typeof vi.fn>;
  let bus: FakeEventBus;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    bus = new FakeEventBus();
    gatewaySendMessage = vi.fn().mockResolvedValue(1);
    gatewayEditMessage = vi.fn().mockResolvedValue(undefined);
    promptSubmit = vi.fn().mockResolvedValue({ turn_id: 1 });
    btwStart = vi.fn().mockResolvedValue('id');

    ix.stub(IConfigService, {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChangeConfiguration: noOpEvent,
      onDidSectionChange: noOpEvent,
      onDidChangeDiagnostics: noOpEvent,
      get: vi.fn((domain: string) => (domain === 'telegram' ? { enabled: true, toolActivity: { enabled: true } } : undefined)),
      inspect: vi.fn(),
      getAll: vi.fn(() => ({})),
      set: vi.fn(),
      replace: vi.fn(),
      replaceSections: vi.fn(),
      reload: vi.fn(),
      diagnostics: vi.fn(() => []),
    } as unknown as IConfigService);

    ix.stub(ITelegramGatewayService, {
      _serviceBrand: undefined,
      gatewayState: { configured: true, maskedToken: '***', chatId: '42' },
      onUpdate: noOpEvent,
      registerInbound: vi.fn(() => ({ dispose: () => {} })),
      sendMessage: gatewaySendMessage,
      editMessage: gatewayEditMessage,
      sendPhoto: vi.fn().mockResolvedValue(2),
      sendDocument: vi.fn().mockResolvedValue(3),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as ITelegramGatewayService);

    const handle = {
      id: MAIN_AGENT_ID,
      kind: 'agent',
      accessor: {
        get: (id: unknown) => (id === IEventBus ? bus : id === IAgentPromptService ? { submit: promptSubmit } : undefined),
      },
      dispose: () => {},
    } as unknown as IAgentScopeHandle;

    ix.stub(IAgentLifecycleService, {
      _serviceBrand: undefined,
      onDidCreate: noOpEvent,
      onDidDispose: noOpEvent,
      create: vi.fn(),
      fork: vi.fn(),
      get: vi.fn((agentId: string) => (agentId === MAIN_AGENT_ID ? handle : undefined)),
      list: vi.fn(() => [handle]),
      broadcastPermissionMode: vi.fn(),
      remove: vi.fn(),
    } as unknown as IAgentLifecycleService);

    ix.stub(ISessionInteractionService, {
      _serviceBrand: undefined,
      request: vi.fn(),
      enqueue: vi.fn(),
      respond: vi.fn(),
      listPending: vi.fn(() => []),
      isRecentlyResolved: vi.fn(),
      cancelPendingForTurn: vi.fn(),
      onDidChangePending: noOpEvent,
      onDidResolve: noOpEvent,
    } as unknown as ISessionInteractionService);

    ix.stub(ISessionQuestionService, {
      _serviceBrand: undefined,
      request: vi.fn(),
      enqueue: vi.fn(),
      answer: vi.fn(),
      dismiss: vi.fn(),
      listPending: vi.fn(() => []),
    } as unknown as ISessionQuestionService);

    ix.stub(ISessionBtwService, {
      _serviceBrand: undefined,
      start: btwStart,
    } as unknown as ISessionBtwService);

    ix.stub(ILogService, {
      _serviceBrand: undefined,
      level: 'info',
      setLevel: vi.fn(),
      flush: vi.fn().mockResolvedValue(undefined),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as ILogService);

    ix.set(ISessionTelegramBridge, new SyncDescriptor(SessionTelegramBridge));
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('streams assistant deltas into a Telegram message', async () => {
    ix.get(ISessionTelegramBridge);

    bus.publish(new TurnStarted({ turnId: 1, origin: USER_PROMPT_ORIGIN }));
    bus.publish(new AssistantDelta({ turnId: 1, delta: 'hello' }));
    bus.publish(new AssistantDelta({ turnId: 1, delta: ' world' }));
    bus.publish(new TurnEnded({ turnId: 1, reason: 'completed', durationMs: 0 }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gatewaySendMessage).toHaveBeenCalled();
    const lastCall = gatewaySendMessage.mock.calls.at(-1)![0] as { text: string };
    expect(lastCall.text).toContain('hello world');
  });

  it('reports tool call activity', async () => {
    ix.get(ISessionTelegramBridge);

    bus.publish(new TurnStarted({ turnId: 2, origin: USER_PROMPT_ORIGIN }));
    bus.publish(new ToolCallStarted({ turnId: 2, toolCallId: 'c1', name: 'Read', args: {} }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    bus.publish(new ToolResultEvent({ turnId: 2, toolCallId: 'c1', output: 'ok' }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gatewaySendMessage).toHaveBeenCalledWith(expect.objectContaining({ text: '🔧 Read' }));
    expect(gatewayEditMessage).toHaveBeenCalledWith(1, '✅ Read');
  });

  it('routes inbound text to the main agent prompt', async () => {
    ix.get(ISessionTelegramBridge);
    const handler = (ix.get(ITelegramGatewayService) as unknown as { registerInbound: ReturnType<typeof vi.fn> }).registerInbound.mock.calls[0]![0] as (update: unknown) => void;

    handler({
      updateId: 1,
      message: { messageId: 1, chat: { id: 42, type: 'private' }, text: 'do work' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(promptSubmit).toHaveBeenCalledWith(expect.objectContaining({ input: [{ type: 'text', text: 'do work' }] }));
  });

  it('starts btw on /btw command', async () => {
    ix.get(ISessionTelegramBridge);
    const handler = (ix.get(ITelegramGatewayService) as unknown as { registerInbound: ReturnType<typeof vi.fn> }).registerInbound.mock.calls[0]![0] as (update: unknown) => void;

    handler({
      updateId: 2,
      message: { messageId: 2, chat: { id: 42, type: 'private' }, text: '/btw' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(btwStart).toHaveBeenCalled();
  });

  it('drops inbound when gateway chatId is unset', async () => {
    ix.stub(ITelegramGatewayService, {
      _serviceBrand: undefined,
      gatewayState: { configured: true, maskedToken: '***', chatId: undefined },
      onUpdate: noOpEvent,
      registerInbound: vi.fn(() => ({ dispose: () => {} })),
      sendMessage: gatewaySendMessage,
      editMessage: gatewayEditMessage,
      sendPhoto: vi.fn().mockResolvedValue(2),
      sendDocument: vi.fn().mockResolvedValue(3),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as ITelegramGatewayService);

    ix.get(ISessionTelegramBridge);
    const handler = (ix.get(ITelegramGatewayService) as unknown as { registerInbound: ReturnType<typeof vi.fn> }).registerInbound.mock.calls[0]![0] as (update: unknown) => void;

    handler({
      updateId: 3,
      message: { messageId: 3, chat: { id: 99, type: 'private' }, text: 'do work' },
    });
    handler({
      updateId: 4,
      message: { messageId: 4, chat: { id: 99, type: 'private' }, text: '/btw' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(promptSubmit).not.toHaveBeenCalled();
    expect(btwStart).not.toHaveBeenCalled();
  });

  it('truncates interim streamed messages to Telegram limit', async () => {
    ix.stub(ITelegramGatewayService, {
      _serviceBrand: undefined,
      gatewayState: { configured: true, maskedToken: '***', chatId: '42' },
      onUpdate: noOpEvent,
      registerInbound: vi.fn(() => ({ dispose: () => {} })),
      sendMessage: gatewaySendMessage,
      editMessage: gatewayEditMessage,
      sendPhoto: vi.fn().mockResolvedValue(2),
      sendDocument: vi.fn().mockResolvedValue(3),
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as ITelegramGatewayService);

    ix.get(ISessionTelegramBridge);

    bus.publish(new TurnStarted({ turnId: 3, origin: USER_PROMPT_ORIGIN }));
    bus.publish(new AssistantDelta({ turnId: 3, delta: 'x'.repeat(5000) }));
    bus.publish(new TurnEnded({ turnId: 3, reason: 'completed', durationMs: 0 }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gatewaySendMessage).toHaveBeenCalled();
    const lastCall = gatewaySendMessage.mock.calls.at(-1)![0] as { text: string };
    expect(lastCall.text.length).toBeLessThanOrEqual(4096);
  });
});
