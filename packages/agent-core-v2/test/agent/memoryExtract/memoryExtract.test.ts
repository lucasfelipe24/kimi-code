/**
 * Scenario: automatic end-of-turn persistent-memory extraction (plan §6, revised).
 *
 * Exercises the real `AgentMemoryExtractService` end-to-end through a real
 * `EventBusService` and the in-memory context stub, with a fake session-memory
 * access, a fake LLM requester (that captures the request overrides), and
 * stubbed config/telemetry/log. Covers: native extraction without a feature gate;
 * the `extractionEnabled` switch (disabled ⇒ no run, no writes, no telemetry and
 * re-enabling resumes from the same position); coalescing under a burst of
 * `turn.ended` (≤1 run per scope) INCLUDING a genuinely-new-transcript rerun;
 * completed-only gating (cancelled/failed/blocked are ignored); the cursor
 * advancing after a completed extraction attempt and REBASING on a transcript
 * shrink (undo/clear/compaction) — no freeze, no full-history resend; skip only
 * on a SUCCESSFUL `Memory remember` (not a bare call / list / forget / failed
 * remember); the `extractionMaxTurns` config bound read via the service;
 * transcript-only input; the EMPTY-toolset + large maxOutputSize + timeout of
 * the default generation call; the empty-response fallback (a response that
 * burned its budget on reasoning is re-requested once with a doubled budget,
 * and a persistently empty response is a retryable failure, not a consumed
 * span); the auto-extraction scope policy (never `user`; `project` falls back
 * to `workspace` when the workspace is untrusted, `user` lands in `project`
 * when trusted); subagent extraction (subagents mine their confined transcript
 * into workspace/project only); the end-of-run flush (`run.ended` mines the
 * tail a cancelled turn left behind) and the session close-flush coordinator
 * (`SessionMemoryExtractFlushService` flushes every live agent on
 * `onWillCloseSession`, bounded so close is never blocked); credential
 * redaction and quarantine of drafts that still look secret before truncation,
 * including multi-pair `Cookie` headers; automatic per-draft persistence,
 * fail-closed catalog dedupe, bounded deterministic retries of transient
 * failures with eviction after the attempt cap, terminal `MemoryError`
 * rejections dropped without blocking later turns, a failed generation
 * boundary retried even when a later turn succeeds with an explicit remember,
 * and content-free telemetry (per-attempt counts — a catalog-lookup failure
 * reports zero failed drafts).
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/memoryExtract/memoryExtract.test.ts`.
 */

import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { AsyncEmitter, Emitter, type IWaitUntil } from '#/_base/event';
import type { IAgentScopeHandle, ISessionScopeHandle } from '#/_base/di/scope';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type AgentLLMRequestOverrides,
} from '#/agent/llmRequester/llmRequester';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { RunEnded } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
} from '#/app/persistentMemory/configSection';
import { MemoryError } from '#/app/persistentMemory/memoryStore';
import { MemoryErrors } from '#/app/persistentMemory/errors';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TelemetryProperties } from '#/app/telemetry/telemetry';
import { createAssistantMessage } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';
import {
  IAgentLifecycleService,
  MAIN_AGENT_ID,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMemoryExtractFlushService } from '#/session/persistentMemory/memoryExtractFlush';
import { SessionMemoryExtractFlushService } from '#/session/persistentMemory/memoryExtractFlushService';
import { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type {
  EffectiveMemory,
  MemoryCreateInput,
  MemoryPatch,
} from '#/workspace/persistentMemory/memoryCatalog';
import type { SessionWillCloseEvent } from '#/workspace/sessionLifecycle/sessionLifecycle';
import type { MemoryScope } from '#/app/persistentMemory/memoryStore';

import {
  EXCERPT_TRUNCATION_MARKER,
  IAgentMemoryExtractService,
  MEMORY_EXTRACT_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  buildTranscriptExcerpt,
  hadSuccessfulRemember,
  memoryDraftDedupeKey,
  parseDraftsFromModelOutput,
  rebaseCursor,
  sanitizeDrafts,
  type MemoryExtractCaps,
  type MemoryExtractDraft,
  type MemoryExtractor,
} from '#/agent/memoryExtract/memoryExtract';
import { AgentMemoryExtractService } from '#/agent/memoryExtract/memoryExtractService';

import { registerContextMemoryServices } from '../contextMemory/stubs';

interface TrackedEvent {
  readonly name: string;
  readonly properties: TelemetryProperties | undefined;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** In-memory `ISessionMemoryAccess` that records create calls. */
class FakeMemoryAccess implements ISessionMemoryAccess {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  readonly createCalls: MemoryCreateInput[] = [];
  readonly memories: EffectiveMemory[] = [];
  createOverride:
    | ((input: MemoryCreateInput) => Promise<EffectiveMemory> | undefined)
    | undefined;
  listOverride: (() => Promise<readonly EffectiveMemory[]>) | undefined;
  /** Live trust read, assigned per-suite so tests can flip trust. */
  isTrusted: (() => boolean) | undefined;

  list(): Promise<readonly EffectiveMemory[]> {
    return this.listOverride?.() ?? Promise.resolve(this.memories);
  }
  create(input: MemoryCreateInput): Promise<EffectiveMemory> {
    this.createCalls.push(input);
    const overridden = this.createOverride?.(input);
    if (overridden !== undefined) return overridden;
    const now = Date.now();
    const memory: EffectiveMemory = {
      id: ulid(),
      name: input.name,
      description: input.description,
      type: input.type,
      scope: input.scope,
      origin: input.scope,
      createdAt: now,
      updatedAt: now,
      version: 1,
      body: input.body,
    };
    this.memories.push(memory);
    return Promise.resolve(memory);
  }
  update(_scope: MemoryScope, _id: string, _patch: MemoryPatch): Promise<EffectiveMemory> {
    return Promise.reject(new Error('not used'));
  }
  forget(_scope: MemoryScope, _id: string): Promise<void> {
    return Promise.resolve();
  }
}

/** A scripted single response for the fake requester. */
interface ScriptedReply {
  readonly text?: string;
  readonly think?: string;
  readonly rawFinishReason?: string;
}

/** Fake LLM requester: records overrides, returns a scripted assistant reply. */
class FakeLLMRequester implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;
  readonly requests: AgentLLMRequestOverrides[] = [];
  replyText = '[]';
  /** Consumed per request; when exhausted, `replyText` is used. */
  scriptedReplies: ScriptedReply[] = [];

  prepareTurnConfig(): undefined {
    return undefined;
  }
  request(overrides?: AgentLLMRequestOverrides): Promise<AgentLLMRequestFinish> {
    this.requests.push(overrides ?? {});
    const next = this.scriptedReplies.shift();
    const parts: Array<{ type: 'text'; text: string } | { type: 'think'; think: string }> = [];
    if (next?.think !== undefined) parts.push({ type: 'think', think: next.think });
    if (next?.text !== undefined || (next === undefined && this.replyText !== '')) {
      parts.push({ type: 'text', text: next?.text ?? this.replyText });
    }
    const finish: AgentLLMRequestFinish = {
      message: createAssistantMessage(parts),
      usage: emptyUsage(),
    };
    if (next?.rawFinishReason !== undefined) finish.rawFinishReason = next.rawFinishReason;
    return Promise.resolve(finish);
  }
  start(): never {
    throw new Error('not used');
  }
}

function userMessage(text: string): ContextMessage {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
}

function assistantMessage(text: string): ContextMessage {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

/** An assistant message carrying a `Memory remember` tool call with `id`. */
function rememberCall(id = 'call_1'): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'saving that' }],
    toolCalls: [
      { type: 'function', id, name: 'Memory', arguments: JSON.stringify({ action: 'remember' }) },
    ],
  };
}

/** A tool result message for a tool call id. */
function toolResult(id: string, isError = false): ContextMessage {
  return {
    role: 'tool',
    content: [{ type: 'text', text: isError ? 'error' : 'ok' }],
    toolCalls: [],
    toolCallId: id,
    isError,
  };
}

const VALID_DRAFT_JSON = JSON.stringify([
  {
    scope: 'workspace',
    type: 'reference',
    name: 'deploy runbook',
    description: 'how to deploy',
    body: 'run deploy.sh',
  },
]);

const DRAFT_ONE: MemoryExtractDraft = {
  scope: 'workspace',
  type: 'reference',
  name: 'runbook',
  description: 'd',
  body: 'run deploy.sh',
};

describe('AgentMemoryExtractService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let context: IAgentContextMemoryService;
  let eventBus: IEventBus;
  let access: FakeMemoryAccess;
  let requester: FakeLLMRequester;
  let configValue: MemoryConfig;
  let tracked: TrackedEvent[];
  let logLines: string[];
  let agentId: string;
  /** Trust state the fake memory access reports to the extract service. */
  let trusted: boolean;

  function build(): void {
    logLines = [];
    ix = createServices(disposables, {
      base: [registerContextMemoryServices],
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ISessionMemoryAccess, access);
        reg.defineInstance(IAgentLLMRequesterService, requester);
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}` }),
        );
        reg.definePartialInstance(IConfigService, {
          get: (<T,>() => configValue as T) as IConfigService['get'],
        });
        reg.definePartialInstance(ITelemetryService, {
          track2: ((name: string, properties?: TelemetryProperties) => {
            tracked.push({ name, properties });
          }) as unknown as ITelemetryService['track2'],
        });
        reg.definePartialInstance(ILogService, {
          debug: (message: unknown) => {
            logLines.push(String(message));
          },
        });
        reg.define(IAgentMemoryExtractService, AgentMemoryExtractService);
      },
    });
    context = ix.get(IAgentContextMemoryService);
    eventBus = ix.get(IEventBus);
    // Force construction so the turn.ended hook is installed.
    ix.get(IAgentMemoryExtractService);
  }

  function service(): AgentMemoryExtractService {
    return ix.get(IAgentMemoryExtractService) as AgentMemoryExtractService;
  }

  function endTurn(reason: 'completed' | 'cancelled' | 'failed' | 'blocked' = 'completed'): void {
    eventBus.publish(new TurnEnded({ agentId, turnId: 1, reason }));
  }

  function runEnded(): void {
    eventBus.publish(new RunEnded({}));
  }

  function extractEvents(): TrackedEvent[] {
    return tracked.filter((event) => event.name === 'memory_extract');
  }

  function writeEvents(): TrackedEvent[] {
    return tracked.filter((event) => event.name === 'memory_write');
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    access = new FakeMemoryAccess();
    requester = new FakeLLMRequester();
    configValue = { ...DEFAULT_MEMORY_CONFIG };
    tracked = [];
    trusted = false;
    access.isTrusted = () => trusted;
    agentId = MAIN_AGENT_ID;
    build();
  });
  afterEach(() =>{  disposables.dispose(); });

  it('serializes completed boundaries without mining a following active turn', async () => {
    context.append(userMessage('how do I deploy the service'));
    const gate = deferred<readonly MemoryExtractDraft[]>();
    let calls = 0;
    const excerpts: string[] = [];
    const extractor: MemoryExtractor = ({ excerpt }) => {
      calls += 1;
      excerpts.push(excerpt);
      return calls === 1 ? gate.promise : Promise.resolve([]);
    };
    service().setExtractor(extractor);

    endTurn();
    expect(calls).toBe(1);

    context.append(assistantMessage('here is how'));
    context.append(userMessage('and how do I roll it back safely'));
    gate.resolve([]);
    await service().whenIdle();

    expect(calls).toBe(1);
    expect(excerpts[0]).not.toContain('roll it back safely');

    endTurn();
    await service().whenIdle();

    expect(calls).toBe(2);
    expect(excerpts[1]).toContain('roll it back safely');
  });

  it('quarantines a suspicious excerpt before it reaches the requester (pre-send gate)', async () => {
    // The high-entropy blob sits beyond the excerpt byte cap. The full redacted
    // content must be checked before truncation hides it from the final excerpt.
    context.append(
      userMessage(
        `deploy notes ${'x'.repeat(9_000)} Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd`,
      ),
    );
    let extractorCalled = false;
    service().setExtractor(() => {
      extractorCalled = true;
      return Promise.resolve([]);
    });

    endTurn();
    await service().whenIdle();

    // The generator (and therefore the LLM requester) was never invoked.
    expect(extractorCalled).toBe(false);
    expect(requester.requests).toHaveLength(0);
    // Counts-only telemetry, skipped outcome, no content.
    const event = extractEvents().at(-1);
    expect(event?.properties?.['outcome']).toBe('skipped');
    for (const value of Object.values(event?.properties ?? {})) {
      expect(String(value)).not.toContain('Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd');
    }

    // The cursor advanced over the quarantined span: the same suspicious content
    // is NOT re-sent on the next turn (no hot loop / repeated exposure).
    let reran = false;
    service().setExtractor(() => {
      reran = true;
      return Promise.resolve([]);
    });
    endTurn();
    await service().whenIdle();
    expect(reran).toBe(false);
  });

  it('runs a boundary queued during a failing run without busy-looping', async () => {
    context.append(userMessage('how do I deploy the service'));
    const gate = deferred<readonly MemoryExtractDraft[]>();
    let calls = 0;
    service().setExtractor(() => {
      calls += 1;
      return calls === 1 ? gate.promise : Promise.resolve([]);
    });

    endTurn();
    expect(calls).toBe(1);

    context.append(userMessage('new completed turn while extraction is running'));
    endTurn();
    gate.reject(new Error('generation failed'));
    await service().whenIdle();

    // The queued boundary justifies ONE retry of the failed span (call 2); the
    // new completed turn's own span is then mined on its own boundary (call 3).
    expect(calls).toBe(3);
    expect(extractEvents()).toHaveLength(3);

    // No busy-loop: once the retry and the new span complete, nothing re-runs.
    await Promise.resolve();
    expect(calls).toBe(3);
  });

  it('survives a clear+append during an in-flight run without swallowing new content', async () => {
    context.append(userMessage('how do I deploy the service now'));
    const gate = deferred<readonly MemoryExtractDraft[]>();
    let calls = 0;
    const excerpts: string[] = [];
    service().setExtractor(({ excerpt }) => {
      calls += 1;
      excerpts.push(excerpt);
      return calls === 1 ? gate.promise : Promise.resolve([]);
    });

    endTurn();
    expect(calls).toBe(1);

    // While the run is in flight: the transcript SHRINKS (clear) and NEW content
    // is appended, then a turn ends. The completion must not write back a stale
    // cursor (which would swallow the new content); the trailing rerun must pick
    // it up.
    context.clear();
    context.append(userMessage('completely different question about caching layers'));
    endTurn();
    gate.resolve([]);
    await service().whenIdle();

    // Exactly one trailing rerun (no concurrency > 1), and it saw the NEW
    // content — proving the anchor rebased and did not swallow it.
    expect(calls).toBe(2);
    expect(excerpts[1]).toContain('caching layers');
    expect(excerpts[1]).not.toContain('deploy the service now');
  });

  it('ignores non-completed turns (cancelled/failed/blocked)', async () => {
    context.append(userMessage('how do I deploy the service'));
    let calls = 0;
    service().setExtractor(() => {
      calls += 1;
      return Promise.resolve([]);
    });

    endTurn('cancelled');
    endTurn('failed');
    endTurn('blocked');
    await service().whenIdle();

    expect(calls).toBe(0);
    expect(extractEvents()).toHaveLength(0);
  });

  it('advances the cursor only after a successful run (failure retries next turn)', async () => {
    context.append(userMessage('how do I deploy the service'));

    let calls = 0;
    service().setExtractor(() => {
      calls += 1;
      return Promise.reject(new Error('generation failed'));
    });
    endTurn();
    await service().whenIdle();

    expect(calls).toBe(1);
    expect(access.createCalls).toHaveLength(0);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('error');

    service().setExtractor(() => {
      calls += 1;
      return Promise.resolve([DRAFT_ONE]);
    });
    endTurn();
    await service().whenIdle();

    expect(calls).toBe(2);
    expect(access.createCalls).toEqual([DRAFT_ONE]);
  });

  it('rebases the cursor when the transcript shrinks (undo/clear), then extracts new content', async () => {
    context.append(userMessage('how do I deploy the service'));
    let lastExcerpt = '';
    service().setExtractor(({ excerpt }) => {
      lastExcerpt = excerpt;
      return Promise.resolve([]);
    });

    endTurn();
    await service().whenIdle();
    // Cursor is now at the full length.
    const runsAfterFirst = extractEvents().length;

    // Shrink the transcript (undo everything), then add genuinely new content.
    context.clear();
    context.append(userMessage('completely different question about caching'));
    endTurn();
    await service().whenIdle();

    // The cursor rebased on the shrink, so the new content is extracted (a new
    // run happened) rather than being skipped because the cursor was stuck past
    // the new end.
    expect(extractEvents().length).toBeGreaterThan(runsAfterFirst);
    expect(lastExcerpt).toContain('caching');
  });

  it('skips only on a SUCCESSFUL Memory remember, not a bare call or a failed one', async () => {
    // A remember call whose result errored ⇒ NOT a successful write ⇒ still extract.
    context.append(userMessage('remember my deploy preference'));
    context.append(rememberCall('call_x'));
    context.append(toolResult('call_x', /* isError */ true));
    let calls = 0;
    service().setExtractor(() => {
      calls += 1;
      return Promise.resolve([]);
    });

    endTurn();
    await service().whenIdle();

    expect(calls).toBe(1);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('success');
  });

  it('skips when a Memory remember succeeded (correlated non-error result)', async () => {
    context.append(userMessage('remember my deploy preference'));
    context.append(rememberCall('call_ok'));
    context.append(toolResult('call_ok', /* isError */ false));
    let calls = 0;
    service().setExtractor(() => {
      calls += 1;
      return Promise.resolve([]);
    });

    endTurn();
    await service().whenIdle();

    expect(calls).toBe(0);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('skipped');
  });

  it('runs natively without a feature flag and persists sanitized drafts automatically', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));

    endTurn();
    await service().whenIdle();

    expect(access.createCalls).toEqual([DRAFT_ONE]);
    expect(writeEvents()).toEqual([
      {
        name: 'memory_write',
        properties: { scope: 'workspace', type: 'reference', outcome: 'success' },
      },
    ]);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 1,
      persisted_count: 1,
      failed_count: 0,
      outcome: 'success',
    });
  });

  it('extracts for a subagent too, writing only workspace/project and never user', async () => {
    agentId = 'agent-child';
    build();
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() =>
      Promise.resolve([
        { scope: 'user', type: 'user', name: 'pref', description: 'd', body: 'subagent user draft' },
        { scope: 'workspace', type: 'reference', name: 'ws', description: 'd', body: 'subagent ws draft' },
      ]),
    );

    endTurn();
    await service().whenIdle();

    // The subagent's confined transcript is mined; the model-proposed `user`
    // draft is normalized away (the catalog's actor gate would reject a
    // subagent → `user` write anyway).
    expect(access.createCalls.map((call) => call.scope)).toEqual(['workspace', 'workspace']);
  });

  it('mines the remaining transcript on run.ended, including a cancelled turn tail', async () => {
    context.append(userMessage('how do I deploy the service'));
    context.append(assistantMessage('partial reply before the cancel'));
    let calls = 0;
    const excerpts: string[] = [];
    service().setExtractor(({ excerpt }) => {
      calls += 1;
      excerpts.push(excerpt);
      return Promise.resolve([]);
    });

    // A cancelled turn ends the run without a completed `turn.ended`; the
    // `run.ended` flush must still mine the tail the turn left behind.
    runEnded();
    await service().whenIdle();

    expect(calls).toBe(1);
    expect(excerpts[0]).toContain('how do I deploy the service');

    // A further `run.ended` without new content does not re-mine (the cursor
    // already consumed the span).
    runEnded();
    await service().whenIdle();
    expect(calls).toBe(1);
  });

  it('flush() retries queued drafts and awaits the trailing chain', async () => {
    context.append(userMessage('how do I deploy the service'));
    let storageFails = true;
    access.createOverride = () =>
      storageFails ? Promise.reject(new Error('storage unavailable')) : undefined;
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));

    endTurn();
    await service().whenIdle();
    expect(service().pendingDraftCountForTests()).toBe(1);

    // A direct flush (session close / agent teardown) retries the queue even
    // without a new completed turn.
    storageFails = false;
    await service().flush();

    expect(service().pendingDraftCountForTests()).toBe(0);
    expect(access.createCalls).toEqual([DRAFT_ONE, DRAFT_ONE]);
  });

  it('normalizes the model-proposed scope: never user; project falls back to workspace when untrusted', async () => {
    trusted = false;
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() =>
      Promise.resolve([
        { scope: 'user', type: 'user', name: 'pref', description: 'd', body: 'user draft' },
        { scope: 'project', type: 'project', name: 'proj', description: 'd', body: 'project draft' },
        { scope: 'workspace', type: 'reference', name: 'ws', description: 'd', body: 'ws draft' },
      ]),
    );

    endTurn();
    await service().whenIdle();

    // Untrusted: `user` and `project` both land in `workspace` (project
    // persistence requires trust); `workspace` stays as proposed.
    expect(access.createCalls.map((call) => call.scope)).toEqual([
      'workspace',
      'workspace',
      'workspace',
    ]);
  });

  it('normalizes user to project in a trusted workspace; project stays project', async () => {
    trusted = true;
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() =>
      Promise.resolve([
        { scope: 'user', type: 'user', name: 'pref', description: 'd', body: 'user draft' },
        { scope: 'project', type: 'project', name: 'proj', description: 'd', body: 'project draft' },
        { scope: 'workspace', type: 'reference', name: 'ws', description: 'd', body: 'ws draft' },
      ]),
    );

    endTurn();
    await service().whenIdle();

    expect(access.createCalls.map((call) => call.scope)).toEqual([
      'project',
      'project',
      'workspace',
    ]);
  });

  it('re-requests once with a doubled budget when the response is empty but carried reasoning', async () => {
    requester.scriptedReplies = [
      { think: 'reasoning burned the whole budget', rawFinishReason: 'length' },
      { text: VALID_DRAFT_JSON },
    ];
    context.append(userMessage('how do I deploy the service'));

    endTurn();
    await service().whenIdle();

    expect(requester.requests).toHaveLength(2);
    expect(requester.requests[0]?.maxOutputSize).toBe(MEMORY_EXTRACT_MAX_OUTPUT_TOKENS);
    expect(requester.requests[1]?.maxOutputSize).toBe(MEMORY_EXTRACT_MAX_OUTPUT_TOKENS * 2);
    expect(access.createCalls).toHaveLength(1);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('success');
  });

  it('treats a persistently empty response as a retryable failure (span not consumed)', async () => {
    requester.scriptedReplies = [
      { think: 'burned on reasoning', rawFinishReason: 'length' },
      { think: 'still no content' },
    ];
    context.append(userMessage('how do I deploy the service'));

    endTurn();
    await service().whenIdle();

    expect(requester.requests).toHaveLength(2);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('error');
    expect(access.createCalls).toHaveLength(0);

    // The cursor did NOT advance: a later trigger re-examines the same span.
    let reran = false;
    service().setExtractor(() => {
      reran = true;
      return Promise.resolve([]);
    });
    endTurn();
    await service().whenIdle();
    expect(reran).toBe(true);
  });

  it('runs the default generation with an EMPTY toolset, small maxOutputSize, and transcript-only input', async () => {
    requester.replyText = VALID_DRAFT_JSON;
    context.append(userMessage('how do I deploy the service today'));

    endTurn();
    await service().whenIdle();

    expect(requester.requests).toHaveLength(1);
    const overrides = requester.requests[0]!;
    // INVARIANT: explicitly empty toolset ⇒ no Read/Grep/Glob/Bash/network.
    expect(overrides.tools).toEqual([]);
    expect(overrides.maxOutputSize).toBe(MEMORY_EXTRACT_MAX_OUTPUT_TOKENS);
    expect(overrides.systemPrompt).toBe(MEMORY_EXTRACT_SYSTEM_PROMPT);
    expect(overrides.source).toEqual({ type: 'operation', requestKind: 'memory_extract' });
    expect(overrides.messages).toHaveLength(1);
    const only = overrides.messages![0]!;
    expect(only.role).toBe('user');
    const text = only.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    expect(text).toContain('how do I deploy the service today');
    expect(access.createCalls).toHaveLength(1);
  });

  it('aborts a slow generation on the timeout (error outcome, cursor not advanced)', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setTimeoutForTests(5);
    // The generation respects the abort signal the service arms with a timeout,
    // so the timeout path completes deterministically without a real model.
    service().setExtractor(
      ({ signal }) =>
        new Promise<readonly MemoryExtractDraft[]>((_resolve, reject) => {
          if (signal.aborted) reject(new Error('aborted'));
          signal.addEventListener('abort', () =>{  reject(new Error('aborted')); });
        }),
    );
    endTurn();
    await service().whenIdle();

    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('error');
    expect(access.createCalls).toHaveLength(0);

    // The cursor did not advance, so a fresh turn re-examines the same span.
    let reran = false;
    service().setExtractor(() => {
      reran = true;
      return Promise.resolve([]);
    });
    endTurn();
    await service().whenIdle();
    expect(reran).toBe(true);
  });

  it('reads extractionMaxTurns from config through the service', async () => {
    configValue = { ...DEFAULT_MEMORY_CONFIG, extractionMaxTurns: 1 };
    let seenExcerpt = '';
    service().setExtractor(({ excerpt }) => {
      seenExcerpt = excerpt;
      return Promise.resolve([]);
    });
    context.append(userMessage('turn one alpha topic'));
    context.append(assistantMessage('reply one'));
    context.append(userMessage('turn two bravo topic'));

    endTurn();
    await service().whenIdle();

    // maxTurns=1 keeps only the last user turn.
    expect(seenExcerpt).toContain('turn two bravo topic');
    expect(seenExcerpt).not.toContain('turn one alpha topic');
  });

  it('redacts a credential in the transcript before it reaches the generator', async () => {
    requester.replyText = '[]';
    context.append(userMessage('deploy using api_key=SUPERSECRETVALUE right now'));

    endTurn();
    await service().whenIdle();

    const overrides = requester.requests[0]!;
    const text = overrides
      .messages!.map((m) => m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''))
      .join('\n');
    expect(text).not.toContain('SUPERSECRETVALUE');
    expect(text).toContain('[redacted]');
  });

  it('quarantines a generator draft whose body still looks like a credential', async () => {
    context.append(userMessage('how do I deploy the service'));
    // A high-entropy mixed-case+digit blob the deny-list does not target: it
    // survives redaction, so the quarantine gate must DROP the whole draft.
    service().setExtractor(() =>
      Promise.resolve([
        {
          scope: 'workspace',
          type: 'reference',
          name: 'creds',
          description: 'a token',
          body: 'credential Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd',
        },
      ]),
    );

    endTurn();
    await service().whenIdle();

    // The quarantined draft is never persisted.
    expect(access.createCalls).toHaveLength(0);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 0,
      persisted_count: 0,
      failed_count: 0,
      outcome: 'success',
    });
  });

  it('dedupes identical drafts within a run before persisting', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE, DRAFT_ONE]));

    endTurn();
    await service().whenIdle();

    expect(access.createCalls).toEqual([DRAFT_ONE]);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 1,
      persisted_count: 1,
      failed_count: 0,
      outcome: 'success',
    });
  });

  it('dedupes a draft already persisted by an earlier extraction regardless of origin', async () => {
    access.createOverride = (input) => {
      const memory: EffectiveMemory = {
        id: ulid(),
        ...input,
        origin: 'user',
        createdAt: 1,
        updatedAt: 1,
        version: 1,
      };
      access.memories.push(memory);
      return Promise.resolve(memory);
    };
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));

    endTurn();
    await service().whenIdle();

    context.append(userMessage('how do I deploy the service again'));
    endTurn();
    await service().whenIdle();

    expect(access.createCalls).toEqual([DRAFT_ONE]);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 0,
      written_count: 0,
      persisted_count: 0,
      failed_count: 0,
      outcome: 'success',
    });
  });

  it('fails closed when listing memories fails, then retries the same draft later', async () => {
    let listFails = true;
    access.listOverride = () =>
      listFails ? Promise.reject(new Error('catalog unavailable')) : Promise.resolve(access.memories);
    context.append(userMessage('how do I deploy the service'));
    let generated = 0;
    service().setExtractor(() => {
      generated += 1;
      return Promise.resolve([DRAFT_ONE]);
    });

    endTurn();
    await service().whenIdle();

    expect(generated).toBe(1);
    expect(access.createCalls).toHaveLength(0);
    // The catalog lookup failed BEFORE any persistence attempt: the drafts are
    // queued for a deterministic retry and counted as 0 failed (per-attempt).
    expect(service().pendingDraftCountForTests()).toBe(1);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 1,
      persisted_count: 0,
      failed_count: 0,
      outcome: 'error',
    });

    listFails = false;
    endTurn();
    await service().whenIdle();

    expect(generated).toBe(2);
    expect(access.createCalls).toEqual([DRAFT_ONE]);
  });

  it('preserves pending drafts when their retry fails and does not generate new ones', async () => {
    context.append(userMessage('how do I deploy the service'));
    let storageFails = true;
    access.createOverride = () =>
      storageFails ? Promise.reject(new Error('storage unavailable')) : undefined;
    let generated = 0;
    service().setExtractor(() => {
      generated += 1;
      return Promise.resolve([DRAFT_ONE]);
    });

    endTurn();
    await service().whenIdle();
    expect(generated).toBe(1);
    expect(access.createCalls).toEqual([DRAFT_ONE]);

    context.append(userMessage('another completed turn'));
    endTurn();
    await service().whenIdle();
    expect(generated).toBe(1);
    expect(access.createCalls).toEqual([DRAFT_ONE, DRAFT_ONE]);

    storageFails = false;
    endTurn();
    await service().whenIdle();
    expect(generated).toBe(2);
    expect(access.createCalls).toEqual([DRAFT_ONE, DRAFT_ONE, DRAFT_ONE]);
  });

  it('drops terminal MemoryError rejections without blocking later turns', async () => {
    // The workspace is trusted, so the model-proposed `project` draft stays
    // `project` (normalization only falls back to `workspace` when untrusted);
    // the fake then simulates a catalog-side trust rejection to exercise the
    // terminal-error drop path.
    trusted = true;
    const rejected: MemoryExtractDraft = {
      scope: 'project',
      type: 'project',
      name: 'project draft',
      description: 'd',
      body: 'project body',
    };
    context.append(userMessage('how do I deploy the service'));
    let reject = true;
    access.createOverride = (input) =>
      input.name === rejected.name && reject
        ? Promise.reject(
            new MemoryError(
              MemoryErrors.codes.MEMORY_TRUST_REQUIRED,
              'project memory requires a trusted workspace',
            ),
          )
        : undefined;
    service().setExtractor(() => Promise.resolve([rejected, DRAFT_ONE]));

    endTurn();
    await service().whenIdle();

    expect(access.createCalls).toEqual([rejected, DRAFT_ONE]);
    expect(writeEvents()).toEqual([
      {
        name: 'memory_write',
        properties: { scope: 'project', type: 'project', outcome: 'rejected' },
      },
      {
        name: 'memory_write',
        properties: { scope: 'workspace', type: 'reference', outcome: 'success' },
      },
    ]);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 2,
      written_count: 1,
      persisted_count: 1,
      failed_count: 1,
      outcome: 'partial',
    });

    // The trust rejection is TERMINAL: it is not queued for retry, so the next
    // completed turn writes nothing new and the failure never blocks later
    // drafts from persisting.
    reject = false;
    endTurn();
    await service().whenIdle();

    expect(access.createCalls).toEqual([rejected, DRAFT_ONE]);
    expect(extractEvents()).toHaveLength(1);
  });

  it('retries a failed generation boundary even when a later turn succeeds with Memory remember', async () => {
    context.append(userMessage('deploy the legacy service'));
    let fail = true;
    const excerpts: string[] = [];
    service().setExtractor(({ excerpt }) => {
      excerpts.push(excerpt);
      if (fail) return Promise.reject(new Error('generation failed'));
      return Promise.resolve([DRAFT_ONE]);
    });

    endTurn();
    await service().whenIdle();
    expect(access.createCalls).toHaveLength(0);

    // A later completed turn contains a SUCCESSFUL explicit remember. It must
    // not cause the earlier failed boundary to be skipped wholesale.
    context.append(userMessage('remember the deploy preference'));
    context.append(rememberCall('call_later'));
    context.append(toolResult('call_later', /* isError */ false));
    fail = false;
    endTurn();
    await service().whenIdle();

    // The failed span was retried on its own boundary BEFORE the remember gate
    // was applied to the later turn.
    expect(excerpts.length).toBeGreaterThanOrEqual(2);
    expect(excerpts.some((text) => text.includes('deploy the legacy service'))).toBe(true);
    expect(access.createCalls).toEqual([DRAFT_ONE]);
  });

  it('quarantines a multi-pair Cookie header in the transcript before it reaches the generator', async () => {
    // `Cookie: theme=light; session=<hex>` — the deny-list redacts only the
    // first pair and the high-entropy detector exempts bare hex tokens, so the
    // second pair must be caught by the header gate and never sent to the model.
    context.append(
      userMessage(
        'the response headers were Cookie: theme=light; session=4f3c9a2b7d1e8f6a5c4b3d2e1f0a9b8c7d6e5f4a',
      ),
    );
    let extractorCalled = false;
    service().setExtractor(() => {
      extractorCalled = true;
      return Promise.resolve([]);
    });

    endTurn();
    await service().whenIdle();

    expect(extractorCalled).toBe(false);
    expect(requester.requests).toHaveLength(0);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('skipped');
  });

  it('quarantines a generator draft carrying a multi-pair Cookie header', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() =>
      Promise.resolve([
        {
          scope: 'workspace',
          type: 'reference',
          name: 'session notes',
          description: 'a header sample',
          body: 'Cookie: theme=light; session=4f3c9a2b7d1e8f6a5c4b3d2e1f0a9b8c7d6e5f4a',
        },
      ]),
    );

    endTurn();
    await service().whenIdle();

    expect(access.createCalls).toHaveLength(0);
  });

  it('reports error when every draft persistence fails', async () => {
    context.append(userMessage('how do I deploy the service'));
    access.createOverride = () => Promise.reject(new Error('storage unavailable'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));

    endTurn();
    await service().whenIdle();

    expect(access.createCalls).toEqual([DRAFT_ONE]);
    expect(writeEvents()).toEqual([
      {
        name: 'memory_write',
        properties: { scope: 'workspace', type: 'reference', outcome: 'error' },
      },
    ]);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 1,
      persisted_count: 0,
      failed_count: 1,
      outcome: 'error',
    });
  });

  it('emits only content-free memory telemetry', async () => {
    context.append(userMessage('deploy the secret-topic service'));
    service().setExtractor(() =>
      Promise.resolve([
        { scope: 'workspace', type: 'reference', name: 'secret-name', description: 'secret-desc', body: 'secret-body' },
      ]),
    );

    endTurn();
    await service().whenIdle();

    const allowedByEvent = new Map<string, ReadonlySet<string>>([
      [
        'memory_extract',
        new Set([
          'turn_count',
          'draft_count',
          'written_count',
          'persisted_count',
          'failed_count',
          'outcome',
        ]),
      ],
      ['memory_write', new Set(['scope', 'type', 'outcome'])],
    ]);
    const events = [...extractEvents(), ...writeEvents()];
    expect(events.length).toBeGreaterThan(0);
    for (const event of extractEvents()) {
      expect(event.properties?.['written_count']).toBe(event.properties?.['persisted_count']);
    }
    for (const event of events) {
      const allowed = allowedByEvent.get(event.name);
      expect(allowed, `unexpected telemetry event ${event.name}`).toBeDefined();
      for (const [key, value] of Object.entries(event.properties ?? {})) {
        expect(allowed?.has(key), `unexpected telemetry key ${key}`).toBe(true);
        expect(String(value)).not.toContain('secret-body');
        expect(String(value)).not.toContain('secret-name');
        expect(String(value)).not.toContain('secret-desc');
      }
    }
  });

  it('skips extraction entirely while extractionEnabled is false, then resumes from the same position', async () => {
    configValue = { ...DEFAULT_MEMORY_CONFIG, extractionEnabled: false };
    context.append(userMessage('how do I deploy the service'));
    let calls = 0;
    service().setExtractor(() => {
      calls += 1;
      return Promise.resolve([DRAFT_ONE]);
    });

    endTurn();
    await service().whenIdle();

    // The hook does nothing when disabled: no run, no write, no telemetry, and
    // the cursor/boundaries are untouched (nothing to consume).
    expect(calls).toBe(0);
    expect(access.createCalls).toHaveLength(0);
    expect(extractEvents()).toHaveLength(0);
    expect(writeEvents()).toHaveLength(0);

    // Re-enabling resumes mining the SAME span — extraction never consumed it
    // while disabled, so the draft is still proposed and persisted.
    configValue = { ...DEFAULT_MEMORY_CONFIG, extractionEnabled: true };
    endTurn();
    await service().whenIdle();

    expect(calls).toBe(1);
    expect(access.createCalls).toEqual([DRAFT_ONE]);
  });

  it('evicts a draft after the retry-attempt cap so a persistent transient failure cannot starve later turns', async () => {
    context.append(userMessage('topic A'));
    access.createOverride = () => Promise.reject(new Error('storage unavailable'));
    let generated = 0;
    service().setExtractor(() => {
      generated += 1;
      return Promise.resolve([DRAFT_ONE]);
    });

    endTurn();
    await service().whenIdle();
    expect(generated).toBe(1);
    expect(service().pendingDraftCountForTests()).toBe(1);

    // Retry 1 fails (attempts=2): the queue stays bounded, no new generation.
    context.append(userMessage('topic B'));
    endTurn();
    await service().whenIdle();
    expect(generated).toBe(1);
    expect(service().pendingDraftCountForTests()).toBe(1);

    // Retry 2 fails and EVICTS the draft (attempts reach the cap): the queue
    // empties and the queued boundary is mined again, so later extraction is
    // never starved forever by the persistent failure.
    context.append(userMessage('topic C'));
    endTurn();
    await service().whenIdle();
    expect(generated).toBe(2);
    expect(service().pendingDraftCountForTests()).toBe(1);
    expect(
      logLines.some((line) => line.includes('dropped after 3 failed persistence attempts')),
    ).toBe(true);
  });

  it('reports zero failed on a retry-time catalog lookup failure and keeps the drafts queued', async () => {
    access.listOverride = () => Promise.reject(new Error('catalog unavailable'));
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));

    endTurn();
    await service().whenIdle();
    expect(service().pendingDraftCountForTests()).toBe(1);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 1,
      persisted_count: 0,
      failed_count: 0,
      outcome: 'error',
    });

    // The retry also hits the catalog failure: still zero persistence attempts
    // made, so zero failed, and the draft stays queued.
    endTurn();
    await service().whenIdle();
    expect(service().pendingDraftCountForTests()).toBe(1);
    expect(access.createCalls).toHaveLength(0);
    expect(extractEvents().at(-1)?.properties).toMatchObject({
      draft_count: 1,
      persisted_count: 0,
      failed_count: 0,
      outcome: 'error',
    });
  });
});

describe('memoryExtract pure helpers', () => {
  const caps: MemoryExtractCaps = {
    maxTurns: 5,
    maxExcerptBytes: 8 * 1024,
    maxBodyBytes: 4096,
    maxDraftsPerRun: 8,
  };

  function user(text: string): ContextMessage {
    return { role: 'user', content: [{ type: 'text', text }], toolCalls: [], origin: { kind: 'user' } };
  }
  function assistant(text: string): ContextMessage {
    return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
  }

  it('buildTranscriptExcerpt keeps only the last maxTurns user turns', () => {
    const messages: ContextMessage[] = [
      user('turn one alpha'),
      assistant('reply one'),
      user('turn two bravo'),
      assistant('reply two'),
      user('turn three charlie'),
      assistant('reply three'),
    ];
    const excerpt = buildTranscriptExcerpt(messages, 2);
    expect(excerpt.turnCount).toBe(2);
    expect(excerpt.text).toContain('turn two bravo');
    expect(excerpt.text).toContain('turn three charlie');
    expect(excerpt.text).not.toContain('turn one alpha');
  });

  it('buildTranscriptExcerpt caps aggregate bytes (INCLUDING marker) strictly at maxExcerptBytes', () => {
    const big = 'x'.repeat(50_000);
    // The final text (content + marker) must strictly fit the cap for a range of
    // caps, including small-but-reasonable ones smaller than the marker itself.
    for (const cap of [1024, 512, 128, 64, EXCERPT_TRUNCATION_MARKER.length, 16]) {
      const excerpt = buildTranscriptExcerpt([user(`deploy ${big}`)], 5, cap);
      expect(excerpt.truncated).toBe(true);
      expect(Buffer.byteLength(excerpt.text, 'utf8')).toBeLessThanOrEqual(cap);
    }
    // At a comfortable cap the marker is present.
    const roomy = buildTranscriptExcerpt([user(`deploy ${big}`)], 5, 1024);
    expect(roomy.text).toContain(EXCERPT_TRUNCATION_MARKER);
  });

  it('buildTranscriptExcerpt returns an empty excerpt when there is no user turn', () => {
    const excerpt = buildTranscriptExcerpt([assistant('hi')], 5);
    expect(excerpt.turnCount).toBe(0);
    expect(excerpt.text).toBe('');
  });

  it('buildTranscriptExcerpt redacts credentials in the transcript text', () => {
    const excerpt = buildTranscriptExcerpt([user('use api_key=SUPERSECRETVALUE')], 5);
    expect(excerpt.text).not.toContain('SUPERSECRETVALUE');
    expect(excerpt.text).toContain('[redacted]');
  });

  it('buildTranscriptExcerpt quarantines a secret beyond the truncation boundary', () => {
    const blob = 'Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd';
    const excerpt = buildTranscriptExcerpt([user(`${'x'.repeat(512)} ${blob}`)], 5, 128);
    expect(excerpt.quarantined).toBe(true);
    expect(excerpt.text).toBe('');
  });

  it('hadSuccessfulRemember: true only for a remember correlated to a non-error result', () => {
    const ok: ContextMessage[] = [
      user('hi'),
      { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'c1', name: 'Memory', arguments: '{"action":"remember"}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'ok' }], toolCalls: [], toolCallId: 'c1' },
    ];
    expect(hadSuccessfulRemember(ok)).toBe(true);

    const failed: ContextMessage[] = [
      { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'c2', name: 'Memory', arguments: '{"action":"remember"}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'boom' }], toolCalls: [], toolCallId: 'c2', isError: true },
    ];
    expect(hadSuccessfulRemember(failed)).toBe(false);

    const listOnly: ContextMessage[] = [
      { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'c3', name: 'Memory', arguments: '{"action":"list"}' }] },
      { role: 'tool', content: [{ type: 'text', text: 'ok' }], toolCalls: [], toolCallId: 'c3' },
    ];
    expect(hadSuccessfulRemember(listOnly)).toBe(false);

    const bareCall: ContextMessage[] = [
      { role: 'assistant', content: [], toolCalls: [{ type: 'function', id: 'c4', name: 'Memory', arguments: '{"action":"remember"}' }] },
    ];
    expect(hadSuccessfulRemember(bareCall)).toBe(false);
  });

  it('sanitizeDrafts drops malformed drafts and re-redacts + truncates the rest', () => {
    const drafts = [
      { scope: 'workspace', type: 'reference', name: 'ok', description: 'd', body: 'token=SUPERSECRET' },
      { scope: 'nonsense', type: 'reference', name: 'bad', description: 'd', body: 'x' },
      { name: 'missing fields' },
    ];
    const out = sanitizeDrafts(drafts, caps);
    expect(out).toHaveLength(1);
    expect(out[0]!.body).not.toContain('SUPERSECRET');
    expect(out[0]!.body).toContain('[redacted]');
  });

  it('sanitizeDrafts quarantines a draft that still looks like a secret after redaction', () => {
    // The high-entropy blob lies beyond the persisted body cap. The full redacted
    // field must be checked before truncation can hide it.
    const blob = 'Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd';
    const drafts = [
      {
        scope: 'workspace',
        type: 'reference',
        name: 'n',
        description: 'd',
        body: `${'y'.repeat(caps.maxBodyBytes + 512)} credential ${blob}`,
      },
    ];
    const out = sanitizeDrafts(drafts, caps);
    expect(out).toHaveLength(0);
  });

  it('sanitizeDrafts enforces the byte cap on the body', () => {
    const drafts = [
      { scope: 'workspace', type: 'reference', name: 'n', description: 'd', body: 'y'.repeat(9000) },
    ];
    const out = sanitizeDrafts(drafts, { ...caps, maxBodyBytes: 256 });
    expect(out).toHaveLength(1);
    expect(Buffer.byteLength(out[0]!.body, 'utf8')).toBeLessThanOrEqual(256);
  });

  it('memoryDraftDedupeKey is stable for identical drafts and distinct otherwise', () => {
    const a: MemoryExtractDraft = { scope: 'user', type: 'user', name: 'n', description: 'd', body: 'b' };
    const b: MemoryExtractDraft = { scope: 'user', type: 'user', name: 'n', description: 'DIFFERENT', body: 'b' };
    expect(memoryDraftDedupeKey(a)).toBe(memoryDraftDedupeKey({ ...a }));
    // description is not part of the identity ⇒ still equal.
    expect(memoryDraftDedupeKey(a)).toBe(memoryDraftDedupeKey(b));
    expect(memoryDraftDedupeKey(a)).not.toBe(memoryDraftDedupeKey({ ...a, body: 'other' }));
  });

  it('rebaseCursor: append after cursor leaves it; shrink before cursor shifts it; straddle collapses', () => {
    // Append after the cursor (start >= cursor): unchanged.
    expect(rebaseCursor(3, { start: 5, deleteCount: 0, insertCount: 2 }, 7)).toBe(3);
    // Delete a block before the cursor: cursor shifts by the negative delta.
    expect(rebaseCursor(6, { start: 1, deleteCount: 3, insertCount: 0 }, 4)).toBe(3);
    // Clear everything (straddles the cursor): collapse to start (0), clamped.
    expect(rebaseCursor(6, { start: 0, deleteCount: 6, insertCount: 0 }, 0)).toBe(0);
    // Compaction: replace a leading block with a shorter summary.
    expect(rebaseCursor(10, { start: 0, deleteCount: 8, insertCount: 1 }, 3)).toBe(3);
  });

  it('parseDraftsFromModelOutput accepts arrays, wrapper objects, and fences; degrades to []', () => {
    expect(parseDraftsFromModelOutput('[{"a":1}]')).toHaveLength(1);
    expect(parseDraftsFromModelOutput('{"memories":[{"a":1},{"b":2}]}')).toHaveLength(2);
    expect(parseDraftsFromModelOutput('```json\n[{"a":1}]\n```')).toHaveLength(1);
    expect(parseDraftsFromModelOutput('not json at all')).toEqual([]);
  });
});

describe('SessionMemoryExtractFlushService (session close flush)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let extractService: AgentMemoryExtractService;
  let access: FakeMemoryAccess;
  let configValue: MemoryConfig;
  let tracked: TrackedEvent[];
  let logLines: string[];
  let agentHandles: IAgentScopeHandle[];
  let willClose: AsyncEmitter<SessionWillCloseEvent & IWaitUntil>;
  let flush: () => Promise<void>;
  let coordinator: SessionMemoryExtractFlushService;

  function context(): IAgentContextMemoryService {
    return ix.get(IAgentContextMemoryService);
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    access = new FakeMemoryAccess();
    configValue = { ...DEFAULT_MEMORY_CONFIG };
    tracked = [];
    logLines = [];
    agentHandles = [];
    willClose = new AsyncEmitter<SessionWillCloseEvent & IWaitUntil>();
    const requester = new FakeLLMRequester();
    ix = createServices(disposables, {
      base: [registerContextMemoryServices],
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(ISessionMemoryAccess, access);
        reg.defineInstance(IAgentLLMRequesterService, requester);
        reg.defineInstance(
          IAgentScopeContext,
          makeAgentScopeContext({ agentId: MAIN_AGENT_ID, agentScope: 'agents/main' }),
        );
        reg.definePartialInstance(IConfigService, {
          get: (<T,>() => configValue as T) as IConfigService['get'],
        });
        reg.definePartialInstance(ITelemetryService, {
          track2: ((name: string, properties?: TelemetryProperties) => {
            tracked.push({ name, properties });
          }) as unknown as ITelemetryService['track2'],
        });
        reg.definePartialInstance(ILogService, {
          debug: (message: unknown) => {
            logLines.push(String(message));
          },
        });
        reg.define(IAgentMemoryExtractService, AgentMemoryExtractService);
        reg.definePartialInstance(ISessionManager, { onWillCloseSession: willClose.event });
        reg.definePartialInstance(ISessionContext, { sessionId: 'session_1' });
        reg.definePartialInstance(IAgentLifecycleService, { list: () => agentHandles });
        reg.define(ISessionMemoryExtractFlushService, SessionMemoryExtractFlushService);
      },
    });
    extractService = ix.get(IAgentMemoryExtractService) as AgentMemoryExtractService;
    coordinator = ix.get(ISessionMemoryExtractFlushService) as SessionMemoryExtractFlushService;
    flush = () => coordinator.flushAll();
  });
  afterEach(() => {
    disposables.dispose();
  });

  function withMainAgent(): void {
    agentHandles.push({
      id: MAIN_AGENT_ID,
      accessor: { get: () => extractService },
    } as unknown as IAgentScopeHandle);
  }

  it('flushes every live agent when the session will-close event fires', async () => {
    withMainAgent();
    context().append(userMessage('how do I deploy the service'));
    extractService.setExtractor(() => Promise.resolve([DRAFT_ONE]));

    const event: SessionWillCloseEvent = {
      sessionId: 'session_1',
      handle: {} as ISessionScopeHandle,
      reason: 'exit',
    };
    await willClose.fireAsync(event, new AbortController().signal);

    // The close awaited the bounded flush: the remaining span was mined and
    // persisted before any agent teardown.
    expect(access.createCalls).toEqual([DRAFT_ONE]);
  });

  it('ignores the will-close event for a different session', async () => {
    withMainAgent();
    context().append(userMessage('how do I deploy the service'));
    extractService.setExtractor(() => Promise.resolve([DRAFT_ONE]));

    const event: SessionWillCloseEvent = {
      sessionId: 'other-session',
      handle: {} as ISessionScopeHandle,
      reason: 'exit',
    };
    await willClose.fireAsync(event, new AbortController().signal);

    expect(access.createCalls).toHaveLength(0);
  });

  it('never blocks close beyond the bound when an agent flush hangs', async () => {
    withMainAgent();
    // The agent-side generation would take 60s to time out on its own; the
    // coordinator's own bound must win and release the close much sooner.
    extractService.setTimeoutForTests(60_000);
    coordinator.setTimeoutForTests(5);
    context().append(userMessage('how do I deploy the service'));
    extractService.setExtractor(() => new Promise<readonly MemoryExtractDraft[]>(() => {}));

    const startedAt = Date.now();
    await flush();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(access.createCalls).toHaveLength(0);
  });
});
