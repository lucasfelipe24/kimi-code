/**
 * `persistentMemory` domain — `IAgentMemoryExtractService` implementation.
 *
 * Owns automatic end-of-turn and end-of-run memory extraction for every agent
 * (main and subagents alike). Subscribes to `turn.ended` (completed turns
 * only), `run.ended` (the loop drained — mines whatever the last turn left
 * behind, including a cancelled/failed turn's tail), and `context.spliced` on
 * the per-agent `eventBus`. A public `flush()` entry mines any transcript
 * remaining after the last mined boundary and retries queued drafts, used at
 * run end, session close, and agent teardown so the tail and pending drafts
 * are never silently lost. Extraction is skipped entirely while the `[memory]`
 * `extractionEnabled` switch is off: the hook does nothing, so cursor and
 * boundary state stay untouched and re-enabling resumes mining from the same
 * position. It serializes completed transcript boundaries and rebases its
 * cursor across `context.spliced`. The model-proposed draft scope is
 * normalized (never `user`; `project` falls back to `workspace` when the
 * workspace is untrusted — `normalizeAutoExtractScope`). Sanitized, redacted,
 * quarantined, deduped drafts are persisted individually through
 * `sessionMemoryAccess`; a failure is isolated to its draft so later drafts
 * still write. A failed draft is retried deterministically from a bounded
 * in-memory queue on a later completed turn/run, evicted after
 * `MEMORY_EXTRACT_MAX_RETRY_ATTEMPTS` failed attempts so a persistent
 * transient failure cannot starve later extraction; terminal `MemoryError`
 * rejections are dropped so they never block future extraction. The default
 * generation call uses a larger completion budget and re-requests once with a
 * doubled budget when a response comes back empty but carried reasoning or was
 * truncated, so a thinking-heavy model cannot silently consume a span.
 * Reports only content-free counts and aggregate outcome through `telemetry`.
 * Bound at Agent scope.
 */

import { Disposable, MutableDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { errorInfo } from '#/_base/errors/codes';
import { ILogService } from '#/_base/log/log';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type AgentLLMRequestOverrides,
} from '#/agent/llmRequester/llmRequester';
import { RunEnded } from '#/agent/loop/turnEvents';
import { TurnEnded } from '#/agent/loop/turnOps';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_SECTION,
  type MemoryConfig,
} from '#/app/persistentMemory/configSection';
import { MemoryError } from '#/app/persistentMemory/memoryStore';
import { looksLikeSecret } from '#/app/persistentMemory/redact';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { extractText } from '#/kosong/contract/message';
import { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';

import {
  DEFAULT_MEMORY_EXTRACTION_MAX_TURNS,
  DEFAULT_MEMORY_EXTRACT_TIMEOUT_MS,
  IAgentMemoryExtractService,
  MEMORY_EXTRACT_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACT_MAX_RETRY_ATTEMPTS,
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  buildTranscriptExcerpt,
  hadSuccessfulRemember,
  memoryDraftDedupeKey,
  normalizeAutoExtractScope,
  parseDraftsFromModelOutput,
  rebaseCursor,
  resolveExtractCaps,
  sanitizeDrafts,
  type MemoryExtractCaps,
  type MemoryExtractDraft,
  type MemoryExtractor,
  type MemoryExtractRunOutcome,
} from './memoryExtract';

/** A queued draft and how many persistence attempts it has already failed. */
interface PendingDraftEntry {
  readonly draft: MemoryExtractDraft;
  /** Failed attempts so far (initial + deterministic retries). */
  readonly attempts: number;
}

/**
 * Terminal-ness is decided from the registered retryable info keyed off the
 * error's code — the code registry is the source of truth for retry semantics —
 * gated on the `MemoryError` class so unrelated registered codes (storage/fs)
 * that surface from the catalog stay transient and get a deterministic retry.
 * Every registered `MemoryError` code declares `retryable: false` (trust, scope
 * full, content rejected, …), so all of them are terminal.
 */
function isTerminalMemoryError(error: unknown): boolean {
  return error instanceof MemoryError && !errorInfo(error.code).retryable;
}

/**
 * Did the generation response burn its completion budget without emitting any
 * answer text? True for a length-capped / truncated finish and for a response
 * whose content is only thinking parts — the failure shape of a thinking-heavy
 * model under a tight output cap (it emits reasoning but zero content).
 */
function isBudgetBurnedResponse(finish: AgentLLMRequestFinish): boolean {
  if (finish.rawFinishReason === 'length' || finish.providerFinishReason === 'truncated') {
    return true;
  }
  return finish.message.content.some((part) => part.type === 'think');
}

export class AgentMemoryExtractService extends Disposable implements IAgentMemoryExtractService {
  declare readonly _serviceBrand: undefined;

  private extractor: MemoryExtractor | undefined;

  /** Coalescing: a single in-flight run per scope and completed transcript boundaries. */
  private running: Promise<void> | undefined;
  private completedBoundaries: number[] = [];
  /** A completed turn landed while a run was in flight (a justified retry trigger). */
  private boundaryPushedDuringRun = false;

  /** Sanitized drafts awaiting another catalog-checked persistence attempt. */
  private pendingDrafts: PendingDraftEntry[] = [];

  /**
   * The cursor: transcript length already mined. Advances once a span's
   * generation and persistence attempt completes (per-draft failures stay in
   * `pendingDrafts`); rebased on `context.spliced` so a shrink never freezes it.
   */
  private cursor = 0;

  /**
   * Logical anchor for the length CONSUMED by the in-flight run. Set at run
   * start and rebased by `context.spliced` exactly like `cursor`, so a
   * shrink/clear+append that lands mid-request cannot make the completion write
   * back a stale cursor and swallow the newly-appended content. `undefined`
   * while no run is generating.
   */
  private runAnchor: number | undefined;

  /** Test-only override for the generation timeout. */
  private timeoutMs = DEFAULT_MEMORY_EXTRACT_TIMEOUT_MS;

  private readonly runAbort = this._register(new MutableDisposable());

  constructor(
    @IEventBus eventBus: IEventBus,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ISessionMemoryAccess private readonly access: ISessionMemoryAccess,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    // The retry queue is in-memory: on scope teardown, best-effort flush what
    // is still queued (or un-mined) so pending drafts are not silently lost;
    // log when the teardown makes even that impossible.
    this._register({
      dispose: () => {
        try {
          if (this.pendingDrafts.length > 0 || this.context.get().length > this.cursor) {
            void this.flush().catch(() => {
              this.log.debug('memory extract: flush on scope disposal failed');
            });
          }
        } catch {
          this.log.debug('memory extract: scope disposal flush unavailable');
        }
      },
    });
    // Every agent extracts — main and subagents alike. A subagent can only
    // persist workspace/project: the catalog's actor gate blocks subagent →
    // `user` and `normalizeAutoExtractScope` never emits `user` from
    // extraction, so relaxing the main-agent gate adds no escalation path.
    this._register(
      eventBus.subscribe(TurnEnded, (event) => {
        // Only mine COMPLETED turns: a cancelled/failed/blocked turn may be
        // half-finished or error state, not a clean unit to extract from.
        if (event.reason === 'completed') this.onTurnEnded();
      }),
    );
    this._register(
      eventBus.subscribe(RunEnded, () => {
        // The loop drained: mine whatever the last turn left behind (including
        // a cancelled/failed turn's tail) that no completed turn covered.
        this.onRunEnded();
      }),
    );
    // Keep the cursor (and any in-flight run anchor) valid across history
    // mutations (clear/undo/compaction), so a shrink+append during a request
    // cannot make the completion write back a stale cursor.
    this._register(
      eventBus.subscribe(ContextSpliced, (event) => {
        const splice = {
          start: event.start,
          deleteCount: event.deleteCount,
          insertCount: event.messages.length,
        };
        const newLength = this.context.get().length;
        this.cursor = rebaseCursor(this.cursor, splice, newLength);
        this.completedBoundaries = this.completedBoundaries.map((boundary) =>
          rebaseCursor(boundary, splice, newLength),
        );
        if (this.runAnchor !== undefined) {
          this.runAnchor = rebaseCursor(this.runAnchor, splice, newLength);
        }
      }),
    );
  }

  setExtractor(extractor: MemoryExtractor | undefined): () => void {
    this.extractor = extractor;
    return () => {
      if (this.extractor === extractor) this.extractor = undefined;
    };
  }

  /**
   * Flush pending extraction: mine any transcript remaining after the last
   * mined boundary and retry queued drafts. Resolves once the trailing run
   * chain settles; each generation call is bounded by the extract timeout, so
   * callers (run-end flush, session close, agent teardown) are never blocked
   * beyond it. A no-op when extraction is disabled or nothing is un-mined.
   */
  async flush(): Promise<void> {
    if (!this.isExtractionEnabled()) return;
    this.startExtraction();
    await this.whenIdle();
  }

  /** Test seam: shrink the generation timeout so the timeout path is fast. */
  setTimeoutForTests(ms: number): void {
    this.timeoutMs = ms;
  }

  /** Test seam: await the trailing run chain so specs can assert post-conditions. */
  async whenIdle(): Promise<void> {
    while (this.running !== undefined) {
      await this.running;
    }
  }

  /** Test seam: current size of the pending retry queue. */
  pendingDraftCountForTests(): number {
    return this.pendingDrafts.length;
  }

  private readMemoryConfig(): MemoryConfig | undefined {
    let section: MemoryConfig | undefined;
    try {
      section = this.config.get<MemoryConfig>(MEMORY_SECTION);
    } catch {
      section = undefined;
    }
    return section;
  }

  /** Is automatic extraction enabled by the `[memory]` config (default: on)? */
  private isExtractionEnabled(): boolean {
    return this.readMemoryConfig()?.extractionEnabled ?? DEFAULT_MEMORY_CONFIG.extractionEnabled;
  }

  private resolveCaps(): MemoryExtractCaps {
    return resolveExtractCaps(this.readMemoryConfig(), {
      extractionMaxTurns:
        DEFAULT_MEMORY_CONFIG.extractionMaxTurns ?? DEFAULT_MEMORY_EXTRACTION_MAX_TURNS,
    });
  }

  /**
   * `turn.ended` handler (completed turns only). Captures the completed transcript
   * boundary and serializes extraction so an active following turn is never mined.
   */
  private onTurnEnded(): void {
    if (!this.isExtractionEnabled()) return;
    this.startExtraction();
  }

  /**
   * `run.ended` handler — the loop drained (no pending turns/requests). Mines
   * whatever the last turn left behind (including a cancelled/failed turn's
   * tail) that no completed `turn.ended` covered.
   */
  private onRunEnded(): void {
    if (!this.isExtractionEnabled()) return;
    this.startExtraction();
  }

  /** Queue the current transcript length as a boundary and start the run chain. */
  private startExtraction(): void {
    this.pushBoundary();
    if (this.running === undefined) {
      this.running = this.runChain();
    } else {
      // A completed turn / run-end landed while a run was in flight: remember
      // it so the chain, once it finishes, gives the queued boundaries another
      // attempt even if the in-flight run failed.
      this.boundaryPushedDuringRun = true;
    }
  }

  /**
   * Queue the current transcript length as a completed boundary unless one at
   * the same length is already queued — a run-end flush can fire repeatedly
   * without new content, and deduping keeps failed boundaries from growing the
   * queue unboundedly across flushes.
   */
  private pushBoundary(): void {
    const length = this.context.get().length;
    if (this.completedBoundaries.at(-1) === length) return;
    this.completedBoundaries.push(length);
  }

  private async runChain(): Promise<void> {
    try {
      while (this.completedBoundaries.length > 0) {
        const boundary = this.completedBoundaries[0];
        if (boundary === undefined) return;
        const succeeded = await this.runOnce(boundary);
        if (!succeeded) {
          // Keep the failed boundary queued: a later completed turn is the retry
          // trigger. Never busy-loop on a failure inside this chain.
          break;
        }
        this.completedBoundaries.shift();
      }
    } finally {
      this.running = undefined;
      if (this.completedBoundaries.length > 0 && this.boundaryPushedDuringRun) {
        this.boundaryPushedDuringRun = false;
        this.running = this.runChain();
      }
    }
  }

  private async runOnce(boundary: number): Promise<boolean> {
    const caps = this.resolveCaps();
    if (this.pendingDrafts.length > 0) {
      const retry = await this.retryPendingDrafts(caps);
      if (!retry.succeeded) return false;
    }

    const messages = this.context.get().slice(0, boundary);
    if (messages.length <= this.cursor) {
      return true;
    }

    const newSpan = messages.slice(this.cursor);
    if (hadSuccessfulRemember(newSpan)) {
      this.telemetry.track2('memory_extract', {
        turn_count: 0,
        draft_count: 0,
        written_count: 0,
        persisted_count: 0,
        failed_count: 0,
        outcome: 'skipped',
      });
      this.cursor = messages.length;
      return true;
    }

    const excerpt = buildTranscriptExcerpt(messages, caps.maxTurns, caps.maxExcerptBytes);
    if (excerpt.quarantined || looksLikeSecret(excerpt.text)) {
      this.log.debug('memory extract: excerpt quarantined by pre-send secret gate');
      this.telemetry.track2('memory_extract', {
        turn_count: excerpt.turnCount,
        draft_count: 0,
        written_count: 0,
        persisted_count: 0,
        failed_count: 0,
        outcome: 'skipped',
      });
      this.cursor = messages.length;
      return true;
    }
    if (excerpt.turnCount === 0 || excerpt.text.length === 0) {
      this.telemetry.track2('memory_extract', {
        turn_count: excerpt.turnCount,
        draft_count: 0,
        written_count: 0,
        persisted_count: 0,
        failed_count: 0,
        outcome: 'skipped',
      });
      this.cursor = messages.length;
      return true;
    }

    const controller = new AbortController();
    this.runAbort.value = { dispose: () => { controller.abort(); } };
    const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    this.runAnchor = messages.length;

    try {
      const rawDrafts = await this.generate(excerpt.text, excerpt.turnCount, controller.signal);
      // Auto-extraction scope policy: never `user`; normalize the model's
      // proposal to the effective scope for this workspace's trust state
      // (`project` when trusted, `workspace` otherwise).
      const sanitized = sanitizeDrafts(rawDrafts, caps).map((draft) => ({
        ...draft,
        scope: normalizeAutoExtractScope(draft.scope, this.access.isTrusted?.() ?? false),
      }));
      let drafts: readonly MemoryExtractDraft[];
      try {
        drafts = await this.dedupeDrafts(sanitized);
      } catch {
        // The catalog lookup failed, so NO draft was attempted for persistence:
        // queue the sanitized drafts for a deterministic retry and report zero
        // failures (per-attempt semantics) with an error outcome.
        this.pendingDrafts = this.limitPendingDrafts(
          sanitized.map((draft) => ({ draft, attempts: 0 })),
          caps.maxDraftsPerRun,
        );
        this.trackExtractResult(excerpt.turnCount, sanitized.length, {
          successes: 0,
          failures: 0,
        }, 'error');
        return false;
      }
      const persisted = await this.persistDrafts(drafts, new Map());
      this.pendingDrafts = this.limitPendingDrafts(persisted.failedEntries, caps.maxDraftsPerRun);
      this.trackExtractResult(excerpt.turnCount, drafts.length, persisted);
      // The span is consumed once its generation and persistence attempt
      // complete: drafts that failed are kept in `pendingDrafts` for a
      // deterministic retry on a later completed turn. Only a failure BEFORE
      // the span was mined (generation, catalog lookup) keeps the cursor.
      this.cursor = Math.min(this.runAnchor, this.context.get().length);
      return true;
    } catch {
      this.log.debug('memory extract: run failed');
      this.telemetry.track2('memory_extract', {
        turn_count: excerpt.turnCount,
        draft_count: 0,
        written_count: 0,
        persisted_count: 0,
        failed_count: 0,
        outcome: 'error',
      });
      return false;
    } finally {
      clearTimeout(timer);
      this.runAbort.value = undefined;
      this.runAnchor = undefined;
    }
  }

  /**
   * Generation seam. The default is a DIRECT LLM call with an EMPTY toolset —
   * `tools: []` overrides the agent's default tool list, so the extraction
   * request cannot invoke Read/Grep/Glob/Bash/network — plus a completion
   * budget large enough for a thinking-heavy model to still emit an answer.
   * The transcript excerpt is the only material provided.
   *
   * DECISION (plan §6.1 "fork with empty toolset" vs a one-shot call): a
   * single request with `tools: []` and the excerpt as the sole message already
   * satisfies the security invariant MORE strongly than a fork — there is no
   * agent loop, no tool wiring, and no file access to remove, so nothing can be
   * read beyond the excerpt. We do NOT invent a fork API. A custom
   * `MemoryExtractor` may replace this generation entirely.
   */
  private async generate(
    excerpt: string,
    turnCount: number,
    signal: AbortSignal,
  ): Promise<readonly MemoryExtractDraft[]> {
    const extractor = this.extractor;
    if (extractor !== undefined) {
      return extractor({ excerpt, turnCount, signal });
    }
    // EMPTY toolset — the security invariant. No read tools reach this call.
    const overrides: AgentLLMRequestOverrides = {
      systemPrompt: MEMORY_EXTRACT_SYSTEM_PROMPT,
      tools: [],
      maxOutputSize: MEMORY_EXTRACT_MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: excerpt }],
          toolCalls: [],
        },
      ],
      source: { type: 'operation', requestKind: 'memory_extract' },
    };
    const finish = await this.llmRequester.request(overrides, undefined, signal);
    let text = extractText(finish.message);
    if (text.trim() === '' && isBudgetBurnedResponse(finish)) {
      // The model spent its whole budget on reasoning and emitted no content
      // (the primary empty-response failure). Re-request once with a doubled
      // budget before giving up.
      const retryFinish = await this.llmRequester.request(
        { ...overrides, maxOutputSize: MEMORY_EXTRACT_MAX_OUTPUT_TOKENS * 2 },
        undefined,
        signal,
      );
      text = extractText(retryFinish.message);
    }
    if (text.trim() === '') {
      // An empty answer is never a valid extraction response (the prompt
      // mandates `[]` for nothing worth remembering). Treat it as a retryable
      // generation failure so the span is NOT consumed as "nothing extracted".
      throw new Error('memory extract: empty model response');
    }
    // The service re-sanitizes/re-redacts/quarantines whatever comes back, so
    // parsing here stays tolerant: unknown drafts are validated downstream.
    return parseDraftsFromModelOutput(text) as readonly MemoryExtractDraft[];
  }

  private async retryPendingDrafts(
    caps: MemoryExtractCaps,
  ): Promise<{ succeeded: boolean }> {
    if (this.pendingDrafts.length === 0) return { succeeded: true };
    const entries = this.pendingDrafts;
    const attemptsByKey = new Map(
      entries.map((entry) => [memoryDraftDedupeKey(entry.draft), entry.attempts] as const),
    );
    let deduped: readonly MemoryExtractDraft[];
    try {
      deduped = await this.dedupeDrafts(entries.map((entry) => entry.draft));
    } catch {
      // The catalog lookup failed: the queued drafts were NOT attempted for
      // persistence, so report zero failures (per-attempt semantics) and keep
      // them queued for another attempt.
      this.trackExtractResult(0, entries.length, {
        successes: 0,
        failures: 0,
      }, 'error');
      return { succeeded: false };
    }
    const persisted = await this.persistDrafts(deduped, attemptsByKey);
    this.pendingDrafts = this.limitPendingDrafts(persisted.failedEntries, caps.maxDraftsPerRun);
    this.trackExtractResult(0, deduped.length, persisted);
    return { succeeded: this.pendingDrafts.length === 0 };
  }

  private async dedupeDrafts(
    drafts: readonly MemoryExtractDraft[],
  ): Promise<readonly MemoryExtractDraft[]> {
    const seen = new Set<string>();
    try {
      for (const memory of await this.access.list()) {
        seen.add(memoryDraftDedupeKey(memory));
      }
    } catch (error) {
      this.log.debug('memory extract: existing memory lookup failed');
      throw error;
    }
    return drafts.filter((draft) => {
      const key = memoryDraftDedupeKey(draft);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async persistDrafts(
    drafts: readonly MemoryExtractDraft[],
    attemptsByKey: ReadonlyMap<string, number>,
  ): Promise<{
    successes: number;
    failures: number;
    failedEntries: readonly PendingDraftEntry[];
  }> {
    let successes = 0;
    let failures = 0;
    const failedEntries: PendingDraftEntry[] = [];
    for (const draft of drafts) {
      try {
        await this.access.create(draft);
        successes += 1;
        this.telemetry.track2('memory_write', {
          scope: draft.scope,
          type: draft.type,
          outcome: 'success',
        });
      } catch (error) {
        // Every failed attempt counts toward telemetry (`failures`), but a
        // terminal `MemoryError` (trust, scope full, content rejected, …) is
        // NOT queued for retry: retrying it on every completed turn would block
        // later extraction forever. Unknown (transient) failures keep the draft
        // for a deterministic retry, evicted once it exceeds the attempt cap so
        // a persistent transient failure cannot starve later extraction.
        failures += 1;
        if (!isTerminalMemoryError(error)) {
          const attempts = (attemptsByKey.get(memoryDraftDedupeKey(draft)) ?? 0) + 1;
          if (attempts < MEMORY_EXTRACT_MAX_RETRY_ATTEMPTS) {
            failedEntries.push({ draft, attempts });
          } else {
            this.log.debug(
              `memory extract: draft dropped after ${attempts} failed persistence attempts`,
            );
          }
        }
        this.telemetry.track2('memory_write', {
          scope: draft.scope,
          type: draft.type,
          outcome: error instanceof MemoryError ? 'rejected' : 'error',
        });
        this.log.debug('memory extract: draft persistence failed');
      }
    }
    return { successes, failures, failedEntries };
  }

  private limitPendingDrafts(
    entries: readonly PendingDraftEntry[],
    maxDrafts: number,
  ): PendingDraftEntry[] {
    const seen = new Set<string>();
    const limited: PendingDraftEntry[] = [];
    for (const entry of entries) {
      const key = memoryDraftDedupeKey(entry.draft);
      if (seen.has(key)) continue;
      seen.add(key);
      limited.push(entry);
      if (limited.length >= maxDrafts) break;
    }
    return limited;
  }

  private trackExtractResult(
    turnCount: number,
    draftCount: number,
    persisted: { readonly successes: number; readonly failures: number },
    outcomeOverride?: MemoryExtractRunOutcome,
  ): void {
    this.telemetry.track2('memory_extract', {
      turn_count: turnCount,
      draft_count: draftCount,
      written_count: persisted.successes,
      persisted_count: persisted.successes,
      failed_count: persisted.failures,
      outcome:
        outcomeOverride ??
        (persisted.failures === 0
          ? 'success'
          : persisted.successes > 0
            ? 'partial'
            : 'error'),
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMemoryExtractService,
  AgentMemoryExtractService,
  ScopeActivation.OnScopeCreated,
  'persistentMemory',
);
