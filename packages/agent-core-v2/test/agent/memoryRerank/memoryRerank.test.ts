/**
 * Scenario: persistent-memory recall rerank installer.
 *
 * Exercises `AgentMemoryRerankService` in isolation: it installs a reranker via
 * `setReranker`, resolves the model binding (secondary when configured, else the
 * agent's primary from `profile`), drives the chosen `ModelRequester` with an
 * empty toolset, and parses the raw output into an id array. Also covers the
 * model-resolution fallback to deterministic order and the pure helpers
 * (`parseRerankIds`, `buildRerankUserMessage`).
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/memoryRerank/memoryRerank.test.ts`.
 */

import { ulid } from 'ulid';
import { describe, expect, it } from 'vitest';

import { ILogService } from '#/_base/log/log';
import {
  IAgentMemoryRecallService,
  type MemoryReranker,
} from '#/agent/memoryRecall/memoryRecall';
import {
  MEMORY_RERANK_CANDIDATE_BYTE_CAP,
  buildRerankUserMessage,
  parseRerankIds,
} from '#/agent/memoryRerank/memoryRerank';
import { AgentMemoryRerankService } from '#/agent/memoryRerank/memoryRerankService';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IConfigService } from '#/app/config/config';
import { SECONDARY_MODEL_SECTION, type SecondaryModelConfig } from '#/app/kosongConfig/configSection';
import { UNKNOWN_CAPABILITY } from '#/kosong/contract/capability';
import type { Message } from '#/kosong/contract/message';
import { IModelCatalog } from '#/kosong/model/catalog';
import type { ModelRequestEvent, ModelRequester } from '#/kosong/model/modelRequester';
import type { EffectiveMemory } from '#/workspace/persistentMemory/memoryCatalog';

function memory(overrides: Partial<EffectiveMemory> & { name: string }): EffectiveMemory {
  const now = Date.now();
  return {
    id: ulid(),
    description: '',
    type: 'reference',
    scope: 'workspace',
    origin: 'workspace',
    createdAt: now,
    updatedAt: now,
    version: 1,
    body: '',
    ...overrides,
  };
}

function textMessage(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

interface RequesterCall {
  readonly modelId: string;
  readonly toolCount: number;
  readonly thinkingEffort: string | undefined;
}

interface Harness {
  readonly reranker: MemoryReranker;
  readonly calls: RequesterCall[];
  readonly logs: string[];
}

/**
 * Build the service with stub deps and capture the reranker it installs. The
 * fake model catalog records which model id was requested and streams a single
 * finish event carrying `responseText` (or throws when `resolveError` is set).
 */
function build(options: {
  secondary?: SecondaryModelConfig;
  primaryAlias?: string;
  primaryThinking?: string;
  responseText?: string;
  resolveError?: boolean;
}): Harness {
  const calls: RequesterCall[] = [];
  const logs: string[] = [];
  let installed: MemoryReranker | undefined;

  const recall: IAgentMemoryRecallService = {
    _serviceBrand: undefined,
    setReranker: (reranker) => {
      installed = reranker ?? undefined;
      return () => {};
    },
  };

  const config = {
    get: (<T,>(section: string) =>
      (section === SECONDARY_MODEL_SECTION ? options.secondary : undefined) as T),
  } as unknown as IConfigService;

  const requester: ModelRequester = {
    model: {
      id: 'stub',
      name: 'stub',
      aliases: [],
      protocol: 'openai',
      headers: {},
      capabilities: UNKNOWN_CAPABILITY,
      maxContextSize: 128_000,
      alwaysThinking: false,
      providerName: 'stub-provider',
      authProvider: { getAuth: () => Promise.resolve(undefined) },
    },
    request: (input, _signal, params) => {
      // The modelId is recorded via the catalog closure below.
      return (async function* (): AsyncIterable<ModelRequestEvent> {
        calls[calls.length - 1] = {
          ...calls.at(-1)!,
          toolCount: input.tools.length,
          thinkingEffort: params?.thinkingEffort,
        };
        yield { type: 'finish', message: textMessage(options.responseText ?? '[]') };
      })();
    },
  };

  const modelCatalog = {
    getRequester: (id: string): ModelRequester => {
      if (options.resolveError === true) throw new Error(`no model ${id}`);
      calls.push({ modelId: id, toolCount: -1, thinkingEffort: undefined });
      return requester;
    },
  } as unknown as IModelCatalog;

  const profile = {
    resolveModelContext: () => ({
      modelAlias: options.primaryAlias ?? 'primary-model',
      thinkingLevel: (options.primaryThinking ?? 'off') as never,
      modelCapabilities: UNKNOWN_CAPABILITY,
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      reservedContextSize: undefined,
      compactionTriggerRatio: undefined,
    }),
  } as unknown as IAgentProfileService;

  const log = { debug: (message: string) => logs.push(message) } as unknown as ILogService;

  const service = new AgentMemoryRerankService(recall, config, modelCatalog, profile, log);
  void service;
  if (installed === undefined) throw new Error('reranker was not installed');
  return { reranker: installed, calls, logs };
}

const signal = new AbortController().signal;

describe('AgentMemoryRerankService', () => {
  it('installs a reranker on construction', () => {
    const h = build({});
    expect(typeof h.reranker).toBe('function');
  });

  it('uses the secondary model when one is configured', async () => {
    const kept = memory({ name: 'deploy runbook', body: 'run deploy.sh' });
    const h = build({
      secondary: { model: 'sonnet' },
      responseText: JSON.stringify([kept.id]),
    });

    const ids = await h.reranker({ query: 'deploy', candidates: [kept], signal });

    expect(h.calls[0]?.modelId).toBe('sonnet');
    expect(h.calls[0]?.toolCount).toBe(0);
    expect(ids).toEqual([kept.id]);
  });

  it('binds the derived entry when the secondary recipe carries patch fields', async () => {
    const kept = memory({ name: 'deploy runbook', body: 'run deploy.sh' });
    const h = build({
      secondary: { model: 'sonnet', defaultEffort: 'high' },
      responseText: JSON.stringify([kept.id]),
    });

    await h.reranker({ query: 'deploy', candidates: [kept], signal });

    expect(h.calls[0]?.modelId).toBe('__secondary__');
    expect(h.calls[0]?.thinkingEffort).toBe('high');
  });

  it('falls back to the primary model when no secondary is configured', async () => {
    const kept = memory({ name: 'deploy runbook', body: 'run deploy.sh' });
    const h = build({
      primaryAlias: 'my-primary',
      responseText: JSON.stringify([kept.id]),
    });

    await h.reranker({ query: 'deploy', candidates: [kept], signal });

    expect(h.calls[0]?.modelId).toBe('my-primary');
  });

  it('falls back to the deterministic order when model resolution fails', async () => {
    const a = memory({ name: 'alpha' });
    const b = memory({ name: 'beta' });
    const h = build({ resolveError: true });

    const ids = await h.reranker({ query: 'anything', candidates: [a, b], signal });

    expect(ids).toEqual([a.id, b.id]);
    expect(h.logs.some((line) => line.includes('model resolution failed'))).toBe(true);
  });

  it('parses ids from a fenced JSON response', async () => {
    const kept = memory({ name: 'deploy runbook', body: 'run deploy.sh' });
    const h = build({
      primaryAlias: 'p',
      responseText: 'Sure:\n```json\n["' + kept.id + '"]\n```',
    });

    const ids = await h.reranker({ query: 'deploy', candidates: [kept], signal });

    expect(ids).toEqual([kept.id]);
  });
});

describe('parseRerankIds', () => {
  it('parses a bare JSON array of strings', () => {
    expect(parseRerankIds('["a", "b"]')).toEqual(['a', 'b']);
  });

  it('parses a fenced json block with surrounding text', () => {
    expect(parseRerankIds('here:\n```json\n["x"]\n```\ndone')).toEqual(['x']);
  });

  it('parses an { ids: [...] } object wrapper', () => {
    expect(parseRerankIds('{"ids":["a","b"]}')).toEqual(['a', 'b']);
  });

  it('drops non-string entries', () => {
    expect(parseRerankIds('["a", 1, null, "b"]')).toEqual(['a', 'b']);
  });

  it('returns [] on unparseable text', () => {
    expect(parseRerankIds('not json at all')).toEqual([]);
  });
});

describe('buildRerankUserMessage', () => {
  it('labels each candidate by id and includes the query', () => {
    const m = memory({ name: 'runbook', description: 'how to', body: 'steps' });
    const text = buildRerankUserMessage('deploy it', [m]);
    expect(text).toContain('Query: deploy it');
    expect(text).toContain(`id: ${m.id}`);
    expect(text).toContain('name: runbook');
    expect(text).toContain('description: how to');
    expect(text).toContain('body: steps');
  });

  it('caps a large body to the byte cap', () => {
    const big = 'x'.repeat(MEMORY_RERANK_CANDIDATE_BYTE_CAP * 4);
    const m = memory({ name: 'runbook', body: big });
    const text = buildRerankUserMessage('q', [m], 16);
    // The body line keeps at most ~16 bytes of x's, not the full 4k.
    expect(text).not.toContain('x'.repeat(64));
  });
});
