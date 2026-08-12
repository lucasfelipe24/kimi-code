/**
 * `persistentMemory` domain — `IAgentMemoryExtractService` implementation.
 *
 * Owns automatic end-of-turn memory extraction (plan §6). Subscribes to
 * `turn.ended` on the per-agent `eventBus` and acts ONLY on `reason:
 * 'completed'` turns (a cancelled/failed/blocked turn is not mined). Persistent
 * memory and automatic extraction are native, and extraction runs only for the
 * MAIN agent (`scopeContext`). Each run reads the CURRENT turn transcript from
 * `contextMemory` (never file reads), skips when the main agent already
 * SUCCESSFULLY wrote memory this turn (a `Memory remember` correlated to a
 * non-error result), builds a redacted, byte-capped, turn-bounded excerpt, and
 * generates drafts through the installed `MemoryExtractor` — the default being a
 * DIRECT `llmRequester` call with an EMPTY toolset, a small `maxOutputSize`, and
 * a real timeout/abort. It SERIALIZES completed transcript boundaries (≤1 run in
 * flight per scope) and keeps a transcript CURSOR that only advances after a
 * successful run and is REBASED on `context.spliced` so a
 * clear/undo/compaction shrink never freezes it or re-sends all history. Drafts
 * are sanitized/redacted/quarantined and deduped, then PROPOSED (not persisted):
 * they land as pending proposals (globally capped, oldest evicted) and fire a
 * CONTENT-FREE `onDidProposeMemory` notice (ids + count only). A run emits
 * `memory_extract` with `written_count: 0` (a proposal is not a write); the
 * explicit `commitProposal` writes through the trust-gated catalog and emits
 * `memory_write`. Bound at Agent scope, activated on scope creation so the hook
 * is armed before the first turn.
 */

import { ulid } from 'ulid';

import { Disposable, MutableDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
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
  MEMORY_EXTRACT_MAX_PENDING,
  MEMORY_EXTRACT_SYSTEM_PROMPT,
  buildTranscriptExcerpt,
  hadSuccessfulRemember,
  parseDraftsFromModelOutput,
  proposalDedupeKey,
  rebaseCursor,
  resolveExtractCaps,
  sanitizeDrafts,
  type MemoryExtractCaps,
  type MemoryExtractDraft,
  type MemoryExtractor,
  type MemoryProposal,
  type MemoryProposalNotice,
} from './memoryExtract';

export class AgentMemoryExtractService extends Disposable implements IAgentMemoryExtractService {
  declare readonly _serviceBrand: undefined;

  private readonly isMainAgent: boolean;

  private extractor: MemoryExtractor | undefined;

  /** Coalescing: a single in-flight run per scope and completed transcript boundaries. */
  private running: Promise<void> | undefined;
  private completedBoundaries: number[] = [];

  /**
   * The cursor: transcript length already extracted. Only advances after a
   * SUCCESSFUL run; rebased on `context.spliced` so a shrink never freezes it.
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

  private proposals: MemoryProposal[] = [];
  private readonly commits = new Map<string, Promise<string | undefined>>();
  private readonly proposeEmitter = this._register(new Emitter<MemoryProposalNotice>());
  readonly onDidProposeMemory = this.proposeEmitter.event;

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

  pendingProposals(): readonly MemoryProposal[] {
    return [...this.proposals];
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
    if (this.running === undefined) this.running = this.runChain();
  }

  private async runChain(): Promise<void> {
    try {
      while (this.completedBoundaries.length > 0) {
        const boundary = this.completedBoundaries[0];
        if (boundary === undefined) return;
        const succeeded = await this.runOnce(boundary);
        if (!succeeded) return;
        this.completedBoundaries.shift();
      }
    } finally {
      this.running = undefined;
    }
  }

  private async runOnce(boundary: number): Promise<boolean> {
    const messages = this.context.get().slice(0, boundary);
    if (messages.length <= this.cursor) {
      // Nothing new since the last successful extraction.
      return true;
    }

    const caps = this.resolveCaps();
    const newSpan = messages.slice(this.cursor);

    // Skip (and advance the cursor) when the main agent already SUCCESSFULLY
    // wrote memory in the new span: defer to the explicit write.
    if (hadSuccessfulRemember(newSpan)) {
      this.telemetry.track2('memory_extract', {
        turn_count: 0,
        written_count: 0,
        outcome: 'skipped',
      });
      this.cursor = messages.length;
      return true;
    }

    const excerpt = buildTranscriptExcerpt(messages, caps.maxTurns, caps.maxExcerptBytes);
    if (excerpt.turnCount === 0 || excerpt.text.length === 0) {
      this.telemetry.track2('memory_extract', {
        turn_count: excerpt.turnCount,
        written_count: 0,
        outcome: 'skipped',
      });
      this.cursor = messages.length;
      return true;
    }

    // SECURITY PRE-SEND GATE: the deny-list redaction is best-effort, so the
    // excerpt may still carry a credential-shaped blob the deny-list missed. If
    // the fail-safe `looksLikeSecret` fires, DROP the span entirely — never send
    // it to the LLM. We ADVANCE the cursor over this span (skip outcome): the
    // content is unchanged, so re-examining it would only re-trigger the same
    // block on every future turn (a hot loop) and keep the suspicious text
    // resident; biasing toward "skip once" avoids repeating/exfiltrating it.
    // Telemetry stays counts-only and never carries the content.
    if (looksLikeSecret(excerpt.text)) {
      this.log.debug('memory extract: excerpt quarantined by pre-send secret gate');
      this.telemetry.track2('memory_extract', {
        turn_count: excerpt.turnCount,
        written_count: 0,
        outcome: 'skipped',
      });
      this.cursor = messages.length;
      return true;
    }

    const controller = new AbortController();
    this.runAbort.value = { dispose: () =>{  controller.abort(); } };
    const timer = setTimeout(() =>{  controller.abort(); }, this.timeoutMs);
    // Anchor the consumed length logically so a shrink/clear+append mid-request
    // rebases it (via context.spliced) instead of the completion writing back a
    // stale numeric cursor and swallowing the new content.
    this.runAnchor = messages.length;

    try {
      const rawDrafts = await this.generate(excerpt.text, excerpt.turnCount, controller.signal);
      const drafts = sanitizeDrafts(rawDrafts, caps);
      const proposed = this.propose(drafts);
      // A proposal is NOT a write: written_count is always 0 for a run.
      this.telemetry.track2('memory_extract', {
        turn_count: excerpt.turnCount,
        written_count: 0,
        outcome: 'success',
      });
      if (proposed.length > 0) {
        this.proposeEmitter.fire({
          ids: proposed.map((proposal) => proposal.id),
          count: proposed.length,
        });
      }
      // Cursor advances ONLY after a successful run, and only over the span we
      // actually consumed. Use the rebased anchor (not the raw snapshot length)
      // so content appended DURING the run — even across a shrink+append — stays
      // unconsumed for the trailing rerun. Clamp to the current length.
      this.cursor = Math.min(this.runAnchor, this.context.get().length);
      return true;
    } catch {
      this.log.debug('memory extract: run failed');
      this.telemetry.track2('memory_extract', {
        turn_count: excerpt.turnCount,
        written_count: 0,
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

  /**
   * Propose-not-persist: sanitized drafts become PENDING proposals. NOTHING is
   * written to the store here. Deduped deterministically against existing
   * pending proposals, and the pending queue is globally capped (oldest evicted)
   * so a chatty session cannot grow it without bound.
   */
  private propose(drafts: readonly MemoryExtractDraft[]): readonly MemoryProposal[] {
    if (drafts.length === 0) return [];
    const now = Date.now();
    const existingKeys = new Set(this.proposals.map((proposal) => proposalDedupeKey(proposal)));
    const fresh: MemoryProposal[] = [];
    for (const draft of drafts) {
      const key = proposalDedupeKey(draft);
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      fresh.push({ ...draft, id: ulid(), createdAt: now });
    }
    if (fresh.length === 0) return [];
    this.proposals = [...this.proposals, ...fresh];
    // Global cap: evict the oldest non-committing proposals past the ceiling.
    while (this.proposals.length > MEMORY_EXTRACT_MAX_PENDING) {
      const index = this.proposals.findIndex((proposal) => !this.commits.has(proposal.id));
      if (index === -1) break;
      this.proposals.splice(index, 1);
    }
    return fresh;
  }

  commitProposal(id: string): Promise<string | undefined> {
    // Only the main agent may commit a proposal, preserving the sensitive
    // `user`-scope escalation guard.
    if (!this.isMainAgent) return Promise.resolve(undefined);

    const existing = this.commits.get(id);
    if (existing !== undefined) return existing;

    const proposal = this.proposals.find((candidate) => candidate.id === id);
    if (proposal === undefined) return Promise.resolve(undefined);

    const commit = this.commit(proposal).finally(() => {
      this.commits.delete(id);
    });
    this.commits.set(id, commit);
    return commit;
  }

  private async commit(proposal: MemoryProposal): Promise<string> {
    try {
      const created = await this.access.create({
        scope: proposal.scope,
        type: proposal.type,
        name: proposal.name,
        description: proposal.description,
        body: proposal.body,
      });
      // Remove from pending only on a successful write; a trust/gate failure
      // keeps the proposal pending so it can be retried after trusting.
      this.proposals = this.proposals.filter((candidate) => candidate.id !== proposal.id);
      // A commit is a WRITE — emit memory_write, not another extract event.
      this.telemetry.track2('memory_write', {
        scope: proposal.scope,
        type: proposal.type,
        outcome: 'success',
      });
      return created.id;
    } catch (error) {
      this.telemetry.track2('memory_write', {
        scope: proposal.scope,
        type: proposal.type,
        outcome: error instanceof MemoryError ? 'rejected' : 'error',
      });
      throw error;
    }
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMemoryExtractService,
  AgentMemoryExtractService,
  ScopeActivation.OnScopeCreated,
  'persistentMemory',
);
