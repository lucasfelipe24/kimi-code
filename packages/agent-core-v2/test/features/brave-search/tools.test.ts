import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { BraveClient } from '#/app/auth/brave/braveClient';
import { BraveAnswersTool } from '#/features/brave-search/answersTool';
import { IBraveSearchService } from '#/features/brave-search/braveSearch';
import {
  IBraveAnswersTool,
  IBraveImageSearchTool,
  IBraveLLMContextTool,
  IBraveLocalSearchTool,
  IBraveNewsSearchTool,
  IBraveRichResultsTool,
  IBraveSpellcheckTool,
  IBraveSuggestTool,
  IBraveVideoSearchTool,
  IBraveWebSearchTool,
} from '#/features/brave-search/contracts';
import { BraveLLMContextTool } from '#/features/brave-search/contextTool';
import { BraveLocalSearchTool, BraveRichResultsTool } from '#/features/brave-search/localRichTools';
import {
  BraveImageSearchTool,
  BraveNewsSearchTool,
  BraveSpellcheckTool,
  BraveSuggestTool,
  BraveVideoSearchTool,
  BraveWebSearchTool,
} from '#/features/brave-search/searchTools';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
  ToolUpdate,
} from '#/tool/toolContract';

let clientAvailable = true;
const braveSearch: IBraveSearchService = {
  _serviceBrand: undefined,
  getClient: () =>
    clientAvailable
      ? new BraveClient({
          apiKey: 'brave-key',
          baseUrl: 'https://brave.example/res/v1',
        })
      : undefined,
};

const signal = new AbortController().signal;

function context(onUpdate?: (update: ToolUpdate) => void): ExecutableToolContext {
  return { turnId: 1, toolCallId: 'call_1', signal, onUpdate };
}

async function execute(
  execution: ToolExecution | Promise<ToolExecution>,
  ctx = context(),
): Promise<ExecutableToolResult> {
  const resolved = await execution;
  if ('output' in resolved) return resolved;
  return resolved.execute(ctx);
}

describe('Brave Search tools', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    clientAvailable = true;
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.defineInstance(IBraveSearchService, braveSearch);
        reg.define(IBraveWebSearchTool, BraveWebSearchTool);
        reg.define(IBraveNewsSearchTool, BraveNewsSearchTool);
        reg.define(IBraveImageSearchTool, BraveImageSearchTool);
        reg.define(IBraveVideoSearchTool, BraveVideoSearchTool);
        reg.define(IBraveSuggestTool, BraveSuggestTool);
        reg.define(IBraveLLMContextTool, BraveLLMContextTool);
        reg.define(IBraveLocalSearchTool, BraveLocalSearchTool);
        reg.define(IBraveRichResultsTool, BraveRichResultsTool);
        reg.define(IBraveAnswersTool, BraveAnswersTool);
        reg.define(IBraveSpellcheckTool, BraveSpellcheckTool);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
    vi.unstubAllGlobals();
  });

  it('sends exact Web defaults and preserves heterogeneous structured output', async () => {
    const payload = {
      query: { more_results_available: true },
      hint: { callback_key: 'opaque' },
      web: { results: [{ title: 'One', nested: { raw: [1, { two: true }] } }] },
      locations: { results: [{ id: 'loc-1' }] },
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);
    const tool = ix.get(IBraveWebSearchTool);

    const result = await execute(tool.resolveExecution({ q: 'query', count: 20, safesearch: 'moderate' }));

    const url = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(url.pathname).toBe('/res/v1/web/search');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'query',
      count: '20',
      safesearch: 'moderate',
    });
    expect(JSON.parse(result.output as string)).toEqual(payload);
  });

  it('does not truncate structured payloads at 200k characters', async () => {
    const payload = { content: 'x'.repeat(210_000) };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    const tool = ix.get(IBraveWebSearchTool);

    const result = await execute(
      tool.resolveExecution({ q: 'query', count: 20, safesearch: 'moderate' }),
    );

    expect(result.truncated).toBe(false);
    expect(JSON.parse(result.output as string)).toEqual(payload);
  });

  it('revalidates Brave availability for every execution', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ web: { results: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = ix.get(IBraveWebSearchTool);
    const execution = tool.resolveExecution({ q: 'query', count: 20, safesearch: 'moderate' });

    clientAvailable = false;
    const disabled = await execute(execution);
    clientAvailable = true;
    await execute(execution);

    expect(disabled).toMatchObject({
      isError: true,
      output: 'Brave Search is no longer configured for this execution.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes News, Image, Video, and Suggest to their endpoints with endpoint-specific defaults', async () => {
    const seen = async (execution: ToolExecution | Promise<ToolExecution>): Promise<URL> => {
      const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);
      await execute(execution);
      const url = new URL(fetchMock.mock.calls[0]![0] as string);
      vi.unstubAllGlobals();
      return url;
    };

    const news = await seen(
      ix.get(IBraveNewsSearchTool).resolveExecution({ q: 'news', count: 20, safesearch: 'strict' }),
    );
    expect(news.pathname).toBe('/res/v1/news/search');
    expect(Object.fromEntries(news.searchParams)).toEqual({
      q: 'news',
      count: '20',
      safesearch: 'strict',
    });

    const image = await seen(
      ix.get(IBraveImageSearchTool).resolveExecution({ q: 'image', count: 50, safesearch: 'strict' }),
    );
    expect(image.pathname).toBe('/res/v1/images/search');
    expect(Object.fromEntries(image.searchParams)).toEqual({
      q: 'image',
      count: '50',
      safesearch: 'strict',
    });

    const video = await seen(
      ix
        .get(IBraveVideoSearchTool)
        .resolveExecution({ q: 'video', count: 20, safesearch: 'moderate' }),
    );
    expect(video.pathname).toBe('/res/v1/videos/search');
    expect(Object.fromEntries(video.searchParams)).toEqual({
      q: 'video',
      count: '20',
      safesearch: 'moderate',
    });

    const suggest = await seen(ix.get(IBraveSuggestTool).resolveExecution({ q: 'sug' }));
    expect(suggest.pathname).toBe('/res/v1/suggest/search');
    expect(Object.fromEntries(suggest.searchParams)).toEqual({ q: 'sug' });
  });

  it('sends LLM Context POST body and location headers without placing location in JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ grounding: { generic: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = ix.get(IBraveLLMContextTool);
    const input = {
      q: 'ground me',
      method: 'POST' as const,
      country: 'us',
      search_lang: 'en',
      count: 20,
      maximum_number_of_urls: 20,
      maximum_number_of_tokens: 8192,
      maximum_number_of_snippets: 50,
      maximum_number_of_tokens_per_url: 4096,
      maximum_number_of_snippets_per_url: 50,
      location: { lat: 10, long: -20, city: 'Recife' },
    };

    await execute(tool.resolveExecution(input));

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('method');
    expect(body).not.toHaveProperty('location');
    expect(body['q']).toBe('ground me');
    const headers = new Headers(init.headers);
    expect(headers.get('X-Loc-Lat')).toBe('10');
    expect(headers.get('X-Loc-Long')).toBe('-20');
    expect(headers.get('X-Loc-City')).toBe('Recife');
    expect(headers.get('X-Subscription-Token')).toBe('brave-key');
  });

  it('resolves at most 20 ephemeral local IDs with repeated query values and descriptions', async () => {
    const ids = Array.from({ length: 25 }, (_, index) => ({ id: `id-${String(index)}` }));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ locations: { results: ids } }))
      .mockResolvedValueOnce(Response.json({ results: [{ id: 'id-0', name: 'Place' }] }))
      .mockResolvedValueOnce(Response.json({ descriptions: [{ id: 'id-0', description: 'Text' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = ix.get(IBraveLocalSearchTool);

    const result = await execute(
      tool.resolveExecution({
        q: 'coffee',
        search_lang: 'pt',
        units: 'metric',
        include_descriptions: true,
      }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.searchParams.get('result_filter')).toBe('locations');
    expect(searchUrl.searchParams.has('units')).toBe(false);
    expect(searchUrl.searchParams.has('include_descriptions')).toBe(false);
    const poisUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(poisUrl.pathname).toBe('/res/v1/local/pois');
    expect(poisUrl.searchParams.getAll('ids')).toHaveLength(20);
    expect(poisUrl.searchParams.get('search_lang')).toBe('pt');
    expect(poisUrl.searchParams.get('units')).toBe('metric');
    const descriptionsUrl = new URL(fetchMock.mock.calls[2]![0] as string);
    expect(descriptionsUrl.pathname).toBe('/res/v1/local/descriptions');
    expect(descriptionsUrl.searchParams.getAll('ids')).toHaveLength(20);
    expect([...descriptionsUrl.searchParams.keys()]).toEqual(
      Array.from({ length: 20 }, () => 'ids'),
    );
    expect(JSON.parse(result.output as string)).toMatchObject({
      pois: { results: [{ name: 'Place' }] },
      descriptions: { descriptions: [{ description: 'Text' }] },
    });
  });

  it('treats an empty spellcheck results array as no suggestion', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const tool = ix.get(IBraveSpellcheckTool);

    const result = await execute(tool.resolveExecution({ q: 'correct query' }));

    expect(result.output).toContain(
      'No spelling suggestion was returned; the query may already be correct.',
    );
    expect(result.output).toContain('"results": []');
  });

  it('follows an opaque rich callback key only when supplied by the hint', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ hint: { callback_key: 'opaque/key' } }))
      .mockResolvedValueOnce(
        Response.json({ vertical: 'weather', provider: 'Brave', attribution: 'Required' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const tool = ix.get(IBraveRichResultsTool);

    const result = await execute(tool.resolveExecution({ q: 'weather' }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const searchUrl = new URL(fetchMock.mock.calls[0]![0] as string);
    expect(searchUrl.searchParams.get('enable_rich_callback')).toBe('1');
    const richUrl = new URL(fetchMock.mock.calls[1]![0] as string);
    expect(richUrl.searchParams.get('callback_key')).toBe('opaque/key');
    expect(JSON.parse(result.output as string)).toMatchObject({
      callback_key: 'opaque/key',
      rich: { vertical: 'weather', attribution: 'Required' },
    });
  });

  it('preserves normal Answers content and usage in non-stream mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ choices: [{ message: { content: 'Answer' } }], usage: { total_tokens: 4 } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const tool = ix.get(IBraveAnswersTool);

    const result = await execute(
      tool.resolveExecution({ messages: [{ role: 'user', content: 'Question' }], stream: false }),
    );

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      messages: [{ role: 'user', content: 'Question' }],
      stream: false,
      model: 'brave',
    });
    expect(JSON.parse(result.output as string)).toMatchObject({
      choices: [{ message: { content: 'Answer' } }],
      usage: { total_tokens: 4 },
    });
  });

  it('parses fragmented SSE lines and tagged content while reporting safe updates', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello <cit"}}]}\n',
      'data: {"choices":[{"delta":{"content":"ation>{\\"url\\":\\"https://example.com\\"}</citation> <enum_"}}]}\n',
      'data: {"choices":[{"delta":{"content":"item>{\\"type\\":\\"place\\"}</enum_item><usage>{\\"tokens\\":3}</usage>world"}}]}\n',
      'data: [DO',
      'NE]\n',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));
    const updates: ToolUpdate[] = [];
    const tool = ix.get(IBraveAnswersTool);

    const result = await execute(
      tool.resolveExecution({
        messages: [{ role: 'user', content: 'Question' }],
        stream: true,
        enable_citations: true,
        enable_entities: true,
      }),
      context((update) => updates.push(update)),
    );

    expect(JSON.parse(result.output as string)).toEqual({
      content: 'Hello  world',
      citations: [{ url: 'https://example.com' }],
      entities: [{ type: 'place' }],
      usage: [{ tokens: 3 }],
    });
    expect(updates.some((update) => update.kind === 'progress')).toBe(true);
    expect(updates.filter((update) => update.kind === 'custom')).toHaveLength(3);
  });

  it('propagates abort while consuming an Answers SSE stream', async () => {
    const controller = new AbortController();
    const abortError = new DOMException('cancelled', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init: RequestInit) => {
        controller.abort(abortError);
        return Promise.reject(init.signal?.reason);
      }),
    );
    const tool = ix.get(IBraveAnswersTool);

    const execution = tool.resolveExecution({
      messages: [{ role: 'user', content: 'Question' }],
      stream: true,
    });

    await expect(execute(execution, { ...context(), signal: controller.signal })).rejects.toBe(
      abortError,
    );
  });
});
