/**
 * Scenario: automatic end-of-turn persistent-memory extraction (plan §6, revised).
 *
 * Exercises the real `AgentMemoryExtractService` end-to-end through a real
 * `EventBusService` and the in-memory context stub, with a fake session-memory
 * access, a fake LLM requester (that captures the request overrides), and
 * stubbed config/telemetry/log. Covers: native extraction without a feature gate;
 * coalescing under a burst of `turn.ended` (≤1 run per scope) INCLUDING a
 * genuinely-new-transcript rerun; completed-only gating (cancelled/failed/blocked
 * are ignored); the cursor advancing only after success and REBASING on a
 * transcript shrink (undo/clear/compaction) — no freeze, no full-history resend;
 * skip only on a SUCCESSFUL `Memory remember` (not a bare call / list / forget /
 * failed remember); the `extractionMaxTurns` config bound read via the service;
 * transcript-only input; the EMPTY-toolset + small maxOutputSize + timeout of the
 * default generation call; credential redaction and quarantine of drafts that
 * still look secret; content-free proposal notice (ids/count only); dedupe +
 * global pending cap; propose-before-persist; commit emitting memory_write (not
 * extract) and requiring the main agent; and trust-failure keeping the proposal
 * pending.
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/memoryExtract/memoryExtract.test.ts`.
 */

import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
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
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
} from '#/app/persistentMemory/configSection';
import { MemoryError } from '#/app/persistentMemory/memoryStore';
import { MemoryErrors } from '#/app/persistentMemory/errors';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TelemetryProperties } from '#/app/telemetry/telemetry';
import { createAssistantMessage } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';
import type {
  EffectiveMemory,
  MemoryCreateInput,
  MemoryPatch,
} from '#/workspace/persistentMemory/memoryCatalog';
import type { MemoryScope } from '#/app/persistentMemory/memoryStore';

import {
  EXCERPT_TRUNCATION_MARKER,
  IAgentMemoryExtractService,
  MEMORY_EXTRACT_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACT_MAX_PENDING,
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  buildTranscriptExcerpt,
  hadSuccessfulRemember,
  parseDraftsFromModelOutput,
  proposalDedupeKey,
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
  createError: MemoryError | undefined;
  createOverride: ((input: MemoryCreateInput) => Promise<EffectiveMemory>) | undefined;

  list(): Promise<readonly EffectiveMemory[]> {
    return Promise.resolve([]);
  }
  create(input: MemoryCreateInput): Promise<EffectiveMemory> {
    this.createCalls.push(input);
    if (this.createOverride !== undefined) return this.createOverride(input);
    if (this.createError !== undefined) return Promise.reject(this.createError);
    const now = Date.now();
    return Promise.resolve({
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
    });
  }
  update(_scope: MemoryScope, _id: string, _patch: MemoryPatch): Promise<EffectiveMemory> {
    return Promise.reject(new Error('not used'));
  }
  forget(_scope: MemoryScope, _id: string): Promise<void> {
    return Promise.resolve();
  }
}

/** Fake LLM requester: records overrides, returns a scripted assistant reply. */
class FakeLLMRequester implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;
  readonly requests: AgentLLMRequestOverrides[] = [];
  replyText = '[]';

  prepareTurnConfig(): undefined {
    return undefined;
  }
  request(overrides?: AgentLLMRequestOverrides): Promise<AgentLLMRequestFinish> {
    this.requests.push(overrides ?? {});
    return Promise.resolve({
      message: createAssistantMessage([{ type: 'text', text: this.replyText }]),
      usage: emptyUsage(),
    });
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
  let agentId: string;

  function build(): void {
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
        reg.definePartialInstance(ILogService, { debug: () => {} });
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
    eventBus.publish({ type: 'turn.ended', turnId: 1, reason });
  }

  function extractEvents(): TrackedEvent[] {
    return tracked.filter((event) => event.name === 'memory_extract');
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    access = new FakeMemoryAccess();
    requester = new FakeLLMRequester();
    configValue = { ...DEFAULT_MEMORY_CONFIG };
    tracked = [];
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
    // A high-entropy mixed blob the deny-list does NOT redact but the fail-safe
    // `looksLikeSecret` detects. It must never be handed to the generator.
    context.append(userMessage('the deploy credential is Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd'));
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
    expect(service().pendingProposals()).toHaveLength(0);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('error');

    service().setExtractor(() => {
      calls += 1;
      return Promise.resolve([DRAFT_ONE]);
    });
    endTurn();
    await service().whenIdle();

    expect(calls).toBe(2);
    expect(service().pendingProposals()).toHaveLength(1);
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

  it('runs natively without a feature flag and keeps proposals pending', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));

    endTurn();
    await service().whenIdle();

    expect(service().pendingProposals()).toHaveLength(1);
    expect(access.createCalls).toHaveLength(0);
  });

  it('never installs the hook for a subagent', async () => {
    agentId = 'agent-child';
    build();
    context.append(userMessage('how do I deploy the service'));
    let calls = 0;
    service().setExtractor(() => {
      calls += 1;
      return Promise.resolve([]);
    });

    endTurn();
    await service().whenIdle();

    expect(calls).toBe(0);
    expect(extractEvents()).toHaveLength(0);
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
    expect(service().pendingProposals()).toHaveLength(1);
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
    expect(service().pendingProposals()).toHaveLength(0);

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

    // Nothing persisted-pending: the draft was quarantined, not silently kept.
    expect(service().pendingProposals()).toHaveLength(0);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('success');
  });

  it('fires a CONTENT-FREE proposal notice (ids + count only)', async () => {
    context.append(userMessage('how do I deploy the service'));
    const notices: { ids: readonly string[]; count: number }[] = [];
    service().onDidProposeMemory((notice) => notices.push(notice));
    service().setExtractor(() =>
      Promise.resolve([
        { scope: 'workspace', type: 'reference', name: 'secret-name', description: 'secret-desc', body: 'secret-body' },
      ]),
    );

    endTurn();
    await service().whenIdle();

    expect(notices).toHaveLength(1);
    const notice = notices[0]!;
    expect(notice.count).toBe(1);
    expect(notice.ids).toHaveLength(1);
    // The notice must not carry any content.
    const serialized = JSON.stringify(notice);
    expect(serialized).not.toContain('secret-name');
    expect(serialized).not.toContain('secret-desc');
    expect(serialized).not.toContain('secret-body');
    // Content is available only through the explicit getter.
    expect(service().pendingProposals()[0]?.body).toBe('secret-body');
  });

  it('dedupes identical drafts across runs and caps the pending queue', async () => {
    // Same draft proposed twice ⇒ only one pending entry.
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));
    endTurn();
    await service().whenIdle();
    context.append(userMessage('and remind me how to deploy again please'));
    endTurn();
    await service().whenIdle();
    expect(service().pendingProposals()).toHaveLength(1);

    // Flood the queue past the global cap with unique drafts.
    let n = 0;
    service().setExtractor(() =>
      Promise.resolve(
        Array.from({ length: 6 }, () => ({
          scope: 'workspace' as const,
          type: 'reference' as const,
          name: `note ${n++}`,
          description: 'd',
          body: `body ${n}`,
        })),
      ),
    );
    for (let i = 0; i < 10; i++) {
      context.append(userMessage(`unique deploy question number ${i} here`));
      endTurn();
      await service().whenIdle();
    }
    expect(service().pendingProposals().length).toBeLessThanOrEqual(MEMORY_EXTRACT_MAX_PENDING);
  });

  it('proposes without persisting; commit writes and emits memory_write (not extract)', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));

    endTurn();
    await service().whenIdle();

    const proposals = service().pendingProposals();
    expect(proposals).toHaveLength(1);
    expect(access.createCalls).toHaveLength(0);
    // The run's extract event carries written_count 0 (proposal is not a write).
    expect(extractEvents().at(-1)?.properties?.['written_count']).toBe(0);
    expect(extractEvents().at(-1)?.properties?.['outcome']).toBe('success');

    const id = await service().commitProposal(proposals[0]!.id);
    expect(id).toBeDefined();
    expect(access.createCalls).toHaveLength(1);
    expect(service().pendingProposals()).toHaveLength(0);
    // Commit emits memory_write, NOT another memory_extract.
    const write = tracked.find((event) => event.name === 'memory_write');
    expect(write?.properties?.['outcome']).toBe('success');
    expect(extractEvents().every((event) => event.properties?.['written_count'] === 0)).toBe(true);
  });

  it('commitProposal writes through the catalog for the main agent', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));
    endTurn();
    await service().whenIdle();
    const proposalId = service().pendingProposals()[0]!.id;

    const id = await service().commitProposal(proposalId);
    expect(id).toBeDefined();
    expect(access.createCalls).toHaveLength(1);
  });

  it('coalesces concurrent commits of the same proposal into one write', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() => Promise.resolve([DRAFT_ONE]));
    endTurn();
    await service().whenIdle();
    const proposalId = service().pendingProposals()[0]!.id;
    const gate = deferred<EffectiveMemory>();
    access.createOverride = () => gate.promise;

    const first = service().commitProposal(proposalId);
    const second = service().commitProposal(proposalId);
    expect(access.createCalls).toHaveLength(1);

    const now = Date.now();
    gate.resolve({
      id: ulid(),
      ...DRAFT_ONE,
      origin: DRAFT_ONE.scope,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });

    const [firstId, secondId] = await Promise.all([first, second]);
    expect(firstId).toBe(secondId);
    expect(access.createCalls).toHaveLength(1);
    expect(service().pendingProposals()).toHaveLength(0);
  });

  it('keeps a proposal pending when the commit hits a trust failure', async () => {
    context.append(userMessage('how do I deploy the service'));
    service().setExtractor(() =>
      Promise.resolve([{ scope: 'project', type: 'project', name: 'p', description: 'd', body: 'b' }]),
    );
    endTurn();
    await service().whenIdle();
    const proposalId = service().pendingProposals()[0]!.id;

    access.createError = new MemoryError(
      MemoryErrors.codes.MEMORY_TRUST_REQUIRED,
      'project memory requires a trusted workspace',
    );
    await expect(service().commitProposal(proposalId)).rejects.toThrow();
    // The proposal remains pending so it can be retried after trusting.
    expect(service().pendingProposals().some((p) => p.id === proposalId)).toBe(true);
    const write = tracked.find((event) => event.name === 'memory_write');
    expect(write?.properties?.['outcome']).toBe('rejected');
  });

  it('commitProposal of an unknown id is a no-op', async () => {
    const id = await service().commitProposal(ulid());
    expect(id).toBeUndefined();
    expect(access.createCalls).toHaveLength(0);
  });

  it('emits only content-free memory_extract telemetry', async () => {
    context.append(userMessage('deploy the secret-topic service'));
    service().setExtractor(() =>
      Promise.resolve([
        { scope: 'workspace', type: 'reference', name: 'secret-name', description: 'secret-desc', body: 'secret-body' },
      ]),
    );

    endTurn();
    await service().whenIdle();

    const allowed = new Set(['turn_count', 'written_count', 'outcome']);
    const events = extractEvents();
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      for (const [key, value] of Object.entries(event.properties ?? {})) {
        expect(allowed.has(key), `unexpected key ${key}`).toBe(true);
        expect(String(value)).not.toContain('secret-body');
        expect(String(value)).not.toContain('secret-name');
        expect(String(value)).not.toContain('secret-desc');
      }
    }
  });
});

describe('memoryExtract pure helpers', () => {
  const caps: MemoryExtractCaps = {
    maxTurns: 5,
    maxExcerptBytes: 8 * 1024,
    maxBodyBytes: 4096,
    maxProposalsPerRun: 8,
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
    // A high-entropy mixed-case+digit blob the deny-list does not target: it
    // survives redaction but must be quarantined (dropped) by looksLikeSecret.
    const blob = 'Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd';
    const drafts = [
      { scope: 'workspace', type: 'reference', name: 'n', description: 'd', body: `credential ${blob}` },
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

  it('proposalDedupeKey is stable for identical drafts and distinct otherwise', () => {
    const a: MemoryExtractDraft = { scope: 'user', type: 'user', name: 'n', description: 'd', body: 'b' };
    const b: MemoryExtractDraft = { scope: 'user', type: 'user', name: 'n', description: 'DIFFERENT', body: 'b' };
    expect(proposalDedupeKey(a)).toBe(proposalDedupeKey({ ...a }));
    // description is not part of the identity ⇒ still equal.
    expect(proposalDedupeKey(a)).toBe(proposalDedupeKey(b));
    expect(proposalDedupeKey(a)).not.toBe(proposalDedupeKey({ ...a, body: 'other' }));
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
