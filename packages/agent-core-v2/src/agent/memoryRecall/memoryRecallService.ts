/**
 * `persistentMemory` domain — `IAgentMemoryRecallService` implementation.
 *
 * Owns the `persistent_memory` context-injection provider: once per user turn
 * it reads the last user query from `contextMemory`, gates on a two-word
 * minimum, deterministically filters
 * the effective memory catalog projected through the Session seed
 * `ISessionMemoryAccess`, optionally reranks the candidates through an
 * installed secondary-model reranker (timeout ⇒ deterministic fallback,
 * abort/error ⇒ empty), and injects the surviving entries as an untrusted
 * memory envelope reminder. Caps come from the `[memory]` config section read
 * through `config`; content-free `memory_recall` telemetry is emitted through
 * `telemetry`. The reranker is never invoked with an empty candidate set and
 * its output is validated against the candidate ids. Registered into the
 * `contextInjector`; bound at Agent scope, activated on scope creation so the
 * provider is armed before the first turn.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  createDeadlineAbortSignal,
  isAbortError,
  linkAbortSignal,
} from '#/_base/utils/abort';
import { ILogService } from '#/_base/log/log';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IConfigService } from '#/app/config/config';
import {
  DEFAULT_MEMORY_CONFIG,
  MEMORY_SECTION,
  type MemoryConfig,
} from '#/app/persistentMemory/configSection';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';
import type { EffectiveMemory } from '#/workspace/persistentMemory/memoryCatalog';

import {
  DEFAULT_MEMORY_LOOKUP_TIMEOUT_MS,
  DEFAULT_MEMORY_RERANK_TIMEOUT_MS,
  IAgentMemoryRecallService,
  MEMORY_RECALL_INJECTION_VARIANT,
  extractLastUserQuery,
  filterDeterministicMemories,
  hasEnoughWords,
  hasNewUserSince,
  renderUntrustedMemoryEnvelope,
  resolveRecallCaps,
  validateRerankIds,
  type MemoryRecallCaps,
  type MemoryRecallSource,
  type MemoryReranker,
} from './memoryRecall';

interface RerankOutcome {
  readonly chosen: readonly EffectiveMemory[];
  readonly source: MemoryRecallSource;
  readonly outcome: 'success' | 'empty' | 'rerank_timeout' | 'rerank_error';
}

interface LookupOutcome {
  readonly memories: readonly EffectiveMemory[] | undefined;
  readonly outcome: 'success' | 'lookup_timeout' | 'lookup_error' | 'lookup_aborted';
}

const TIMEOUT = Symbol('memory-recall-rerank-timeout');
const LOOKUP_TIMEOUT = Symbol('memory-recall-lookup-timeout');

export class AgentMemoryRecallService extends Disposable implements IAgentMemoryRecallService {
  declare readonly _serviceBrand: undefined;

  private reranker: MemoryReranker | undefined;
  private rerankTimeoutMs: number = DEFAULT_MEMORY_RERANK_TIMEOUT_MS;
  private lookupTimeoutMs: number = DEFAULT_MEMORY_LOOKUP_TIMEOUT_MS;

  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @ISessionMemoryAccess private readonly access: ISessionMemoryAccess,
    @IConfigService private readonly config: IConfigService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(
      dynamicInjector.register(MEMORY_RECALL_INJECTION_VARIANT, ({ lastInjectedAt, signal }) =>
        this.provide(lastInjectedAt, signal),
      ),
    );
  }

  setReranker(reranker: MemoryReranker | undefined): () => void {
    this.reranker = reranker;
    return () => {
      if (this.reranker === reranker) this.reranker = undefined;
    };
  }

  /** Test-only: shrink the lookup timeout so the timeout path is fast to hit. */
  setLookupTimeoutForTests(ms: number): void {
    this.lookupTimeoutMs = ms;
  }

  /** Test-only: shrink the rerank timeout so the timeout path is fast to hit. */
  setRerankTimeoutForTests(ms: number): void {
    this.rerankTimeoutMs = ms;
  }

  private resolveCaps(): MemoryRecallCaps {
    let section: MemoryConfig | undefined;
    try {
      section = this.config.get<MemoryConfig>(MEMORY_SECTION);
    } catch {
      section = undefined;
    }
    return resolveRecallCaps(section, DEFAULT_MEMORY_CONFIG);
  }

  private async lookup(
    query: string,
    caps: MemoryRecallCaps,
    signal?: AbortSignal,
  ): Promise<LookupOutcome> {
    const source = new AbortController();
    const deadline = createDeadlineAbortSignal(source.signal, this.lookupTimeoutMs);
    const unlink = signal === undefined ? undefined : linkAbortSignal(signal, source);
    const listPromise = this.access.list();
    // Attach the rejection handler immediately: the underlying store may reject
    // after the deadline/abort has already caused this lookup to return.
    const handledList = listPromise.catch((error: unknown) => {
      throw error;
    });
    const abortPromise = new Promise<never>((_, reject) => {
      deadline.signal.addEventListener(
        'abort',
        () =>{  reject(deadline.timedOut() ? LOOKUP_TIMEOUT : deadline.signal.reason); },
        { once: true },
      );
    });

    try {
      const result = await Promise.race([
        new Promise<readonly EffectiveMemory[]>((resolve, reject) => {
          handledList.then(resolve, reject);
        }),
        abortPromise,
      ]);
      return {
        memories: filterDeterministicMemories(result, query, caps),
        outcome: 'success',
      };
    } catch (error: unknown) {
      if (deadline.timedOut() || error === LOOKUP_TIMEOUT) {
        this.log.debug('memory recall: candidate lookup timed out');
        return { memories: undefined, outcome: 'lookup_timeout' };
      }
      if (deadline.signal.aborted) {
        this.log.debug('memory recall: candidate lookup aborted');
        return { memories: undefined, outcome: 'lookup_aborted' };
      }
      if (isAbortError(error)) {
        this.log.debug('memory recall: candidate lookup aborted');
        return { memories: undefined, outcome: 'lookup_aborted' };
      }
      this.log.debug('memory recall: candidate lookup failed');
      return { memories: undefined, outcome: 'lookup_error' };
    } finally {
      unlink?.();
      deadline.clear();
    }
  }

  private async provide(
    lastInjectedAt: number | null,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const history = this.context.get();
    const query = extractLastUserQuery(history);
    // Ignore one-word prompts (too little signal to recall on).
    if (!hasEnoughWords(query)) return undefined;
    // Only recall once per genuine user turn; a re-inject with no new user
    // message must not duplicate the reminder.
    if (!hasNewUserSince(history, lastInjectedAt)) return undefined;

    const started = Date.now();
    const caps = this.resolveCaps();

    const lookup = await this.lookup(query, caps, signal);
    if (lookup.memories === undefined) {
      this.track(0, 0, 'deterministic', lookup.outcome, started);
      if (lookup.outcome === 'lookup_aborted') {
        signal?.throwIfAborted();
      }
      return undefined;
    }

    const candidates = lookup.memories;
    if (candidates.length === 0) {
      this.track(0, 0, 'deterministic', 'empty', started);
      return undefined;
    }

    const reranked = await this.maybeRerank(candidates, query);
    if (reranked.chosen.length === 0) {
      this.track(candidates.length, 0, reranked.source, reranked.outcome, started);
      return undefined;
    }

    const rendered = renderUntrustedMemoryEnvelope(reranked.chosen, caps, Date.now());
    this.track(
      candidates.length,
      rendered.entryCount,
      reranked.source,
      rendered.entryCount === 0 ? 'empty' : reranked.outcome,
      started,
    );
    if (rendered.entryCount === 0) return undefined;
    return rendered.text;
  }

  /**
   * Optional rerank with two explicit, distinct failure paths:
   * - timeout ⇒ fall back to the deterministic candidates (never empty);
   * - abort/error ⇒ drop everything (`[]`).
   * Never invokes the reranker with an empty candidate list, and validates the
   * returned ids against the candidate set (discarding invented ids).
   */
  private async maybeRerank(
    candidates: readonly EffectiveMemory[],
    query: string,
  ): Promise<RerankOutcome> {
    const reranker = this.reranker;
    if (reranker === undefined || candidates.length === 0) {
      return { chosen: candidates, source: 'deterministic', outcome: candidates.length === 0 ? 'empty' : 'success' };
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() =>{  resolve(TIMEOUT); }, this.rerankTimeoutMs);
    });

    const rerankPromise = (async (): Promise<readonly EffectiveMemory[]> => {
      const ids = await reranker({ query, candidates, signal: controller.signal });
      return validateRerankIds(ids, candidates);
    })();

    try {
      const raced = await Promise.race([rerankPromise, timeoutPromise]);
      if (raced === TIMEOUT) {
        // Timeout: cancel the in-flight side query and keep deterministic order.
        controller.abort();
        void rerankPromise.catch(() => undefined);
        return { chosen: candidates, source: 'deterministic', outcome: 'rerank_timeout' };
      }
      return {
        chosen: raced,
        source: 'rerank',
        outcome: raced.length === 0 ? 'empty' : 'success',
      };
    } catch {
      // Abort/error before the timeout fired: drop everything.
      controller.abort();
      this.log.debug('memory recall: rerank failed');
      return { chosen: [], source: 'rerank', outcome: 'rerank_error' };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private track(
    candidateCount: number,
    selectedCount: number,
    source: MemoryRecallSource,
    outcome:
      | 'success'
      | 'empty'
      | 'lookup_timeout'
      | 'lookup_error'
      | 'lookup_aborted'
      | 'rerank_timeout'
      | 'rerank_error',
    startedMs: number,
  ): void {
    this.telemetry.track2('memory_recall', {
      candidate_count: candidateCount,
      selected_count: selectedCount,
      source,
      outcome,
      duration_ms: Date.now() - startedMs,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMemoryRecallService,
  AgentMemoryRecallService,
  ScopeActivation.OnScopeCreated,
  'persistentMemory',
);
