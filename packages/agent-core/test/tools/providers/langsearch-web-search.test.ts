import { describe, expect, it, vi } from 'vitest';

import { LangSearchWebSearchProvider } from '../../../src/tools/providers/langsearch-web-search';
import { LangSearchReranker } from '../../../src/tools/providers/langsearch-rerank';

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

const sampleResponse = {
  code: 200,
  data: {
    _type: 'SearchResponse',
    queryContext: { originalQuery: 'test query' },
    webPages: {
      webSearchUrl: 'https://langsearch.com/search?q=test',
      totalEstimatedMatches: null,
      value: [
        {
          id: 'https://api.langsearch.com/v1/web-search#1',
          name: 'Result One',
          url: 'https://example.com/1',
          displayUrl: 'https://example.com/1',
          snippet: 'This is the first snippet.',
          summary: 'This is the first summary.',
          datePublished: '2024-01-15',
          dateLastCrawled: null,
        },
        {
          id: 'https://api.langsearch.com/v1/web-search#2',
          name: 'Result Two',
          url: 'https://example.com/2',
          displayUrl: 'https://example.com/2',
          snippet: 'This is the second snippet.',
          summary: null,
          datePublished: null,
          dateLastCrawled: null,
        },
      ],
    },
  },
};

describe('LangSearchWebSearchProvider', () => {
  it('maps Bing-compatible response to WebSearchResult[]', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await provider.search('test query');

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      title: 'Result One',
      url: 'https://example.com/1',
      snippet: 'This is the first snippet.',
      date: '2024-01-15',
      content: 'This is the first summary.',
    });
    expect(results[1]).toMatchObject({
      title: 'Result Two',
      url: 'https://example.com/2',
      snippet: 'This is the second snippet.',
    });
    expect(results[1]!.date).toBeUndefined();
    expect(results[1]!.content).toBeUndefined();
  });

  it('sends correct request payload', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    await provider.search('my query', { limit: 5, includeContent: true });

    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('https://api.langsearch.com/v1/web-search');
    const body = JSON.parse((call?.[1] as { body: string })?.body ?? '{}');
    expect(body.query).toBe('my query');
    expect(body.freshness).toBe('noLimit');
    expect(body.summary).toBe(true);
    expect(body.count).toBe(5);
  });

  it('clamps limit to range 1–10', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    // Below minimum
    await provider.search('q', { limit: 0 });
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string })?.body ?? '{}').count).toBe(1);

    // Above maximum
    await provider.search('q', { limit: 50 });
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as { body: string })?.body ?? '{}').count).toBe(10);
  });

  it('defaults count to 10 when limit is undefined', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    await provider.search('q');
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string })?.body ?? '{}').count).toBe(10);
  });

  it('summary is false by default', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    await provider.search('q', { includeContent: false });
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string })?.body ?? '{}').summary).toBe(false);
  });

  it('passes toolCallId as X-Tool-Call-Id header', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    await provider.search('q', { toolCallId: 'call-123' });

    const headers = (fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> })?.headers;
    expect(headers?.['X-Tool-Call-Id']).toBe('call-123');
  });

  it('does not send X-Tool-Call-Id when toolCallId is empty', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    await provider.search('q', { toolCallId: '' });

    const headers = (fetchImpl.mock.calls[0]?.[1] as { headers?: Record<string, string> })?.headers;
    expect(headers?.['X-Tool-Call-Id']).toBeUndefined();
  });

  it('throws on HTTP 401', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('unauthorized', { status: 401 }),
    );
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'bad-key',
      fetchImpl,
    });

    await expect(provider.search('q')).rejects.toThrow(/401/);
  });

  it('throws on HTTP 500', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('server error', { status: 500 }),
    );
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    await expect(provider.search('q')).rejects.toThrow(/500/);
  });

  it('handles empty webPages.value', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      data: { webPages: { value: [] } },
    });
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await provider.search('q');
    expect(results).toEqual([]);
  });

  it('handles missing data field', async () => {
    const fetchImpl = mockFetch(200, { code: 200 });
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await provider.search('q');
    expect(results).toEqual([]);
  });

  it('uses custom base URL when provided', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      baseUrl: 'https://custom.example/search',
      fetchImpl,
    });

    await provider.search('q');
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://custom.example/search');
  });

  it('retries on HTTP 429 with backoff', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve(new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '1' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify(sampleResponse), { status: 200 }));
    });

    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await provider.search('q');
    expect(callCount).toBe(3);
    expect(results).toHaveLength(2);
  });

  it('handles webPages present but value absent', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      data: { webPages: {} },
    });
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await provider.search('q');
    expect(results).toEqual([]);
  });

  it('filters out empty-string datePublished and summary', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      data: {
        webPages: {
          value: [{
            name: 'Test',
            url: 'https://example.com',
            snippet: 'Snippet',
            datePublished: '',
            summary: '',
          }],
        },
      },
    });
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await provider.search('q');
    expect(results[0]!.date).toBeUndefined();
    expect(results[0]!.content).toBeUndefined();
  });

  it('clamps fractional limit values', async () => {
    const fetchImpl = mockFetch(200, sampleResponse);
    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    // 0.4 → round to 0 → clamp to 1
    await provider.search('q', { limit: 0.4 });
    expect(JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string })?.body ?? '{}').count).toBe(1);

    // 10.6 → round to 11 → clamp to 10
    await provider.search('q', { limit: 10.6 });
    expect(JSON.parse((fetchImpl.mock.calls[1]?.[1] as { body: string })?.body ?? '{}').count).toBe(10);
  });

  it('reorders results via reranker when provided', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      data: {
        webPages: {
          value: [
            { name: 'Result A', url: 'https://a.com', snippet: 'snippet A' },
            { name: 'Result B', url: 'https://b.com', snippet: 'snippet B' },
            { name: 'Result C', url: 'https://c.com', snippet: 'snippet C' },
          ],
        },
      },
    });

    const rerankFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        code: 200,
        results: [
          { index: 1, relevance_score: 0.95, document: { text: 'snippet B' } },
          { index: 0, relevance_score: 0.80, document: { text: 'snippet A' } },
          { index: 2, relevance_score: 0.30, document: { text: 'snippet C' } },
        ],
      }), { status: 200 }),
    );

    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl: rerankFetch,
    });

    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      reranker,
      fetchImpl,
    });

    const results = await provider.search('test query');

    expect(results).toHaveLength(3);
    expect(results[0]!.title).toBe('Result B');
    expect(results[1]!.title).toBe('Result A');
    expect(results[2]!.title).toBe('Result C');
  });

  it('falls back to original order when reranker throws', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      data: {
        webPages: {
          value: [
            { name: 'Result A', url: 'https://a.com', snippet: 'A' },
            { name: 'Result B', url: 'https://b.com', snippet: 'B' },
          ],
        },
      },
    });

    const reranker = {
      rerank: vi.fn().mockRejectedValue(new Error('rerank failed')),
    } as unknown as LangSearchReranker;

    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      reranker,
      fetchImpl,
    });

    const results = await provider.search('q');
    expect(results[0]!.title).toBe('Result A');
    expect(results[1]!.title).toBe('Result B');
  });

  it('skips rerank when only one result', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      data: {
        webPages: {
          value: [
            { name: 'Only', url: 'https://x.com', snippet: 'x' },
          ],
        },
      },
    });

    const reranker = {
      rerank: vi.fn(),
    } as unknown as LangSearchReranker;

    const provider = new LangSearchWebSearchProvider({
      apiKey: 'test-key',
      reranker,
      fetchImpl,
    });

    await provider.search('q');
    expect(reranker.rerank).not.toHaveBeenCalled();
  });
});
