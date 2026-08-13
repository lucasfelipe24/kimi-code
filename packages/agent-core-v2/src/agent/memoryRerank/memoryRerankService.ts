/**
 * `persistentMemory` domain — installs the recall reranker.
 *
 * Wires an LLM reranker into `memoryRecall`'s `setReranker` extension point so
 * recall candidates are reordered by relevance before injection. The rerank is
 * always on and independent of the `secondary-model` experiment: it reads the
 * `[secondary_model]` section directly through `config` and, when a secondary
 * model is configured, uses it (the pool `default_model`, else the legacy
 * `model` pointer); otherwise it falls back to the agent's always-present
 * primary model from `profile`. The chosen model is driven
 * directly through `IModelCatalog`'s `ModelRequester` with an EMPTY toolset and
 * a small completion budget; the raw output is parsed to an id array, which the
 * recall service validates against the candidate set.
 * A model-resolution failure degrades to the deterministic candidate order;
 * generation timeout/abort/error stay owned by the recall service's rerank
 * policy. Logs through `log`. Bound at Agent scope, activated on scope creation
 * so the reranker is installed before the first turn.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';

import { IAgentMemoryRecallService } from '#/agent/memoryRecall/memoryRecall';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IConfigService } from '#/app/config/config';
import {
  SECONDARY_MODEL_SECTION,
  type SecondaryModelConfig,
} from '#/session/subagent/configSection';
import { extractText } from '#/kosong/contract/message';
import { IModelCatalog } from '#/kosong/model/catalog';
import {
  completionBudgetParams,
  resolveCompletionBudget,
} from '#/kosong/model/completionBudget';
import type { ModelRequestParams } from '#/kosong/model/modelRequester';
import { normalizeRequestedThinkingEffort } from '#/kosong/model/thinking';
import type { EffectiveMemory } from '#/workspace/persistentMemory/memoryCatalog';

import {
  IAgentMemoryRerankService,
  MEMORY_RERANK_MAX_OUTPUT_TOKENS,
  MEMORY_RERANK_SYSTEM_PROMPT,
  buildRerankUserMessage,
  parseRerankIds,
} from './memoryRerank';

interface RerankBinding {
  readonly modelId: string;
  readonly thinking: string | undefined;
}

export class AgentMemoryRerankService extends Disposable implements IAgentMemoryRerankService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentMemoryRecallService recall: IAgentMemoryRecallService,
    @IConfigService private readonly config: IConfigService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    const removeReranker = recall.setReranker(({ query, candidates, signal }) =>
      this.rerank(query, candidates, signal),
    );
    this._register({ dispose: removeReranker });
  }

  /**
   * Binding is independent of the `secondary-model` experiment: rerank is always
   * on, so it reads the `[secondary_model]` section directly. When a secondary
   * model is configured it is used (the pool `default_model`, else the legacy
   * `model` pointer); otherwise it falls back to the agent's always-present
   * primary model.
   */
  private resolveBinding(): RerankBinding {
    let secondary: SecondaryModelConfig | undefined;
    try {
      secondary = this.config.get<SecondaryModelConfig | undefined>(SECONDARY_MODEL_SECTION);
    } catch {
      secondary = undefined;
    }
    const secondaryModelId = secondary?.defaultModel ?? secondary?.model;
    if (secondaryModelId !== undefined) {
      return { modelId: secondaryModelId, thinking: secondary?.defaultEffort };
    }
    const context = this.profile.resolveModelContext();
    return { modelId: context.modelAlias, thinking: context.thinkingLevel };
  }

  private async rerank(
    query: string,
    candidates: readonly EffectiveMemory[],
    signal: AbortSignal,
  ): Promise<readonly string[]> {
    const binding = this.resolveBinding();

    // A model-resolution failure must not lose the candidates: fall back to the
    // deterministic order so recall still injects them. Generation failures
    // (timeout/abort/error) stay owned by the recall service's rerank policy.
    let requester;
    try {
      requester = this.modelCatalog.getRequester(binding.modelId);
    } catch (error) {
      this.log.debug('memory rerank: model resolution failed; using deterministic order', {
        model: binding.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return candidates.map((candidate) => candidate.id);
    }

    const params: ModelRequestParams = {
      thinkingEffort: normalizeRequestedThinkingEffort(binding.thinking),
      ...completionBudgetParams({
        budget: resolveCompletionBudget({ maxOutputSize: MEMORY_RERANK_MAX_OUTPUT_TOKENS }),
        capability: requester.model.capabilities,
      }),
    };

    let text = '';
    for await (const event of requester.request(
      {
        systemPrompt: MEMORY_RERANK_SYSTEM_PROMPT,
        // EMPTY toolset — the rerank call can read nothing beyond the candidates.
        tools: [],
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: buildRerankUserMessage(query, candidates) }],
            toolCalls: [],
          },
        ],
      },
      signal,
      params,
    )) {
      if (event.type === 'finish') text = extractText(event.message);
    }

    return parseRerankIds(text);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentMemoryRerankService,
  AgentMemoryRerankService,
  ScopeActivation.OnScopeCreated,
  'persistentMemory',
);
