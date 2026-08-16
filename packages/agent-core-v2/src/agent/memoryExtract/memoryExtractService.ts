/**
 * `persistentMemory` domain — `IAgentMemoryExtractService` implementation.
 *
 * Owns automatic end-of-turn memory extraction. Subscribes to `turn.ended` on
 * the per-agent `eventBus` and acts only on completed turns. For the main agent,
 * it reads the current transcript from `contextMemory`, skips a span after a
 * successful explicit `Memory remember`, and sends only a redacted, byte-capped,
 * turn-bounded excerpt to the installed `MemoryExtractor` or tool-free
 * `llmRequester` call. It serializes completed transcript boundaries and rebases
 * its cursor across `context.spliced`. Sanitized, redacted, quarantined, deduped
 * drafts are persisted individually through `sessionMemoryAccess`; a failure is
 * isolated to its draft so later drafts still write. A failed draft is retried
 * deterministically from a bounded in-memory queue on a later completed turn;
 * terminal `MemoryError` rejections are dropped so they never block future
 * extraction. Reports only content-free counts and aggregate outcome through
 * `telemetry`. Bound at Agent scope.
 */

import { Disposable, MutableDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
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
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';

import {
  DEFAULT_MEMORY_EXTRACTION_MAX_TURNS,
  DEFAULT_MEMORY_EXTRACT_TIMEOUT_MS,
  IAgentMemoryExtractService,
  MEMORY_EXTRACT_MAX_OUTPUT_TOKENS,
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  buildTranscriptExcerpt,
  hadSuccessfulRemember,
  memoryDraftDedupeKey,
  parseDraftsFromModelOutput,
  rebaseCursor,
  resolveExtractCaps,
  sanitizeDrafts,
  type MemoryExtractCaps,
  type MemoryExtractDraft,
  type MemoryExtractor,
} from './memoryExtract';

/**
 * Every registered `MemoryError` code declares `retryable: false` (trust, scope
 * full, content rejected, …), so any `MemoryError` is terminal; only unknown
 * (transient) failures are worth a deterministic retry.
 */
function isTerminalMemoryError(error: unknown): boolean {
  return error instanceof MemoryError;
}

export class AgentMemoryExtractService extends Disposable implements IAgentMemoryExtractService {
  declare readonly _serviceBrand: undefined;

  private readonly isMainAgent: boolean;

  private extractor: MemoryExtractor | undefined;

  /** Coalescing: a single in-flight run per scope and completed transcript boundaries. */
  private running: Promise<void> | undefined;
  private completedBoundaries: number[] = [];
  /** A completed turn landed while a run was in flight (a justified retry trigger). */
  private boundaryPushedDuringRun = false;

  /** Sanitized drafts awaiting another catalog-checked persistence attempt. */
  private pendingDrafts: MemoryExtractDraft[] = [];

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
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @ISessionMemoryAccess private readonly access: ISessionMemoryAccess,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.isMainAgent = scopeContext.agentId === MAIN_AGENT_ID;
    // Only the main agent extracts; a subagent never installs the hook, so its
    // (confined) transcript is never mined and it cannot escalate into `user`.
    if (this.isMainAgent) {
      this._register(
        eventBus.subscribe('turn.ended', (event) => {
          // Only mine COMPLETED turns: a cancelled/failed/blocked turn may be
          // half-finished or error state, not a clean unit to extract from.
          if (event.reason === 'completed') this.onTurnEnded();
        }),
      );
      // Keep the cursor (and any in-flight run anchor) valid across history
      // mutations (clear/undo/compaction), so a shrink+append during a request
      // cannot make the completion write back a stale cursor.
      this._register(
        eventBus.subscribe('context.spliced', (event) => {
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
  }

  setExtractor(extractor: MemoryExtractor | undefined): () => void {
    this.extractor = extractor;
    return () => {
      if (this.extractor === extractor) this.extractor = undefined;
    };
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

  private resolveCaps(): MemoryExtractCaps {
    let section: MemoryConfig | undefined;
    try {
      section = this.config.get<MemoryConfig>(MEMORY_SECTION);
    } catch {
      section = undefined;
    }
    return resolveExtractCaps(section, {
      extractionMaxTurns:
        DEFAULT_MEMORY_CONFIG.extractionMaxTurns ?? DEFAULT_MEMORY_EXTRACTION_MAX_TURNS,
    });
  }

  /**
   * `turn.ended` handler (completed turns only). Captures the completed transcript
   * boundary and serializes extraction so an active following turn is never mined.
   */
  private onTurnEnded(): void {
    this.completedBoundaries.push(this.context.get().length);
    if (this.running === undefined) {
      this.running = this.runChain();
    } else {
      // A completed turn landed while a run was in flight: remember it so the
      // chain, once it finishes, gives the queued boundaries another attempt
      // even if the in-flight run failed.
      this.boundaryPushedDuringRun = true;
    }
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
      const sanitized = sanitizeDrafts(rawDrafts, caps);
      let drafts: readonly MemoryExtractDraft[];
      try {
        drafts = await this.dedupeDrafts(sanitized);
      } catch {
        this.pendingDrafts = this.limitDrafts(sanitized, caps.maxDraftsPerRun);
        this.trackExtractResult(excerpt.turnCount, sanitized.length, {
          successes: 0,
          failures: sanitized.length,
        });
        return false;
      }
      const persisted = await this.persistDrafts(drafts);
      this.pendingDrafts = this.limitDrafts(persisted.failedDrafts, caps.maxDraftsPerRun);
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
   * request cannot invoke Read/Grep/Glob/Bash/network — plus a small
   * `maxOutputSize` budget. The transcript excerpt is the only material
   * provided.
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
    const finish = await this.llmRequester.request(
      {
        systemPrompt: MEMORY_EXTRACT_SYSTEM_PROMPT,
        // EMPTY toolset — the security invariant. No read tools reach this call.
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
      },
      undefined,
      signal,
    );
    // The service re-sanitizes/re-redacts/quarantines whatever comes back, so
    // parsing here stays tolerant: unknown drafts are validated downstream.
    return parseDraftsFromModelOutput(extractText(finish.message)) as readonly MemoryExtractDraft[];
  }

  private async retryPendingDrafts(
    caps: MemoryExtractCaps,
  ): Promise<{ succeeded: boolean }> {
    if (this.pendingDrafts.length === 0) return { succeeded: true };
    const drafts = this.pendingDrafts;
    let deduped: readonly MemoryExtractDraft[];
    try {
      deduped = await this.dedupeDrafts(drafts);
    } catch {
      this.trackExtractResult(0, drafts.length, {
        successes: 0,
        failures: drafts.length,
      });
      return { succeeded: false };
    }
    const persisted = await this.persistDrafts(deduped);
    this.pendingDrafts = this.limitDrafts(persisted.failedDrafts, caps.maxDraftsPerRun);
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

  private async persistDrafts(drafts: readonly MemoryExtractDraft[]): Promise<{
    successes: number;
    failures: number;
    failedDrafts: readonly MemoryExtractDraft[];
  }> {
    let successes = 0;
    let failures = 0;
    const failedDrafts: MemoryExtractDraft[] = [];
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
        // for a deterministic retry.
        failures += 1;
        if (!isTerminalMemoryError(error)) {
          failedDrafts.push(draft);
        }
        this.telemetry.track2('memory_write', {
          scope: draft.scope,
          type: draft.type,
          outcome: error instanceof MemoryError ? 'rejected' : 'error',
        });
        this.log.debug('memory extract: draft persistence failed');
      }
    }
    return { successes, failures, failedDrafts };
  }

  private limitDrafts(
    drafts: readonly MemoryExtractDraft[],
    maxDrafts: number,
  ): MemoryExtractDraft[] {
    const seen = new Set<string>();
    const limited: MemoryExtractDraft[] = [];
    for (const draft of drafts) {
      const key = memoryDraftDedupeKey(draft);
      if (seen.has(key)) continue;
      seen.add(key);
      limited.push(draft);
      if (limited.length >= maxDrafts) break;
    }
    return limited;
  }

  private trackExtractResult(
    turnCount: number,
    draftCount: number,
    persisted: { readonly successes: number; readonly failures: number },
  ): void {
    this.telemetry.track2('memory_extract', {
      turn_count: turnCount,
      draft_count: draftCount,
      written_count: persisted.successes,
      persisted_count: persisted.successes,
      failed_count: persisted.failures,
      outcome:
        persisted.failures === 0
          ? 'success'
          : persisted.successes > 0
            ? 'partial'
            : 'error',
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
