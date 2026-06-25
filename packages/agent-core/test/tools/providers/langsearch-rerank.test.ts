import { describe, expect, it, vi } from 'vitest';

import { LangSearchReranker } from '../../../src/tools/providers/langsearch-rerank';

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>().mockImplementation(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );
}

describe('LangSearchReranker', () => {
  it('calls the rerank endpoint with correct payload', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      results: [
        { index: 0, relevance_score: 0.9, document: { text: 'doc A' } },
        { index: 1, relevance_score: 0.5, document: { text: 'doc B' } },
      ],
    });

    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await reranker.rerank('test query', ['doc A', 'doc B']);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ index: 0, relevanceScore: 0.9, text: 'doc A' });
    expect(results[1]).toEqual({ index: 1, relevanceScore: 0.5, text: 'doc B' });

    const call = fetchImpl.mock.calls[0];
    expect(call?.[0]).toBe('https://api.langsearch.com/v1/rerank');
    const body = JSON.parse((call?.[1] as { body: string })?.body ?? '{}');
    expect(body.model).toBe('langsearch-reranker-v1');
    expect(body.query).toBe('test query');
    expect(body.documents).toEqual(['doc A', 'doc B']);
    expect(body.return_documents).toBe(true);
  });

  it('passes top_n when provided', async () => {
    const fetchImpl = mockFetch(200, { code: 200, results: [] });
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    await reranker.rerank('q', ['a', 'b', 'c'], 2);

    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string })?.body ?? '{}');
    expect(body.top_n).toBe(2);
  });

  it('uses custom base URL when provided', async () => {
    const fetchImpl = mockFetch(200, { code: 200, results: [] });
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      baseUrl: 'https://custom.example/rerank',
      fetchImpl,
    });

    await reranker.rerank('q', ['a']);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://custom.example/rerank');
  });

  it('throws on HTTP 401', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('unauthorized', { status: 401 }),
    );
    const reranker = new LangSearchReranker({
      apiKey: 'bad-key',
      fetchImpl,
    });

    await expect(reranker.rerank('q', ['a'])).rejects.toThrow(/401/);
  });

  it('throws on HTTP 500', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('server error', { status: 500 }),
    );
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    await expect(reranker.rerank('q', ['a'])).rejects.toThrow(/500/);
  });

  it('retries on HTTP 429 with backoff', async () => {
    let callCount = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => {
      callCount++;
      if (callCount < 3) {
        return Promise.resolve(new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '0' },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ code: 200, results: [] }), { status: 200 }));
    });

    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    await reranker.rerank('q', ['a']);
    expect(callCount).toBe(3);
  });

  it('handles empty results gracefully', async () => {
    const fetchImpl = mockFetch(200, { code: 200, results: [] });
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await reranker.rerank('q', ['a']);
    expect(results).toEqual([]);
  });

  it('handles null results field', async () => {
    const fetchImpl = mockFetch(200, { code: 200 });
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await reranker.rerank('q', ['a']);
    expect(results).toEqual([]);
  });

  it('handles result item with missing document', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      results: [{ index: 0, relevance_score: 0.5 }],
    });
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await reranker.rerank('q', ['a']);
    expect(results).toHaveLength(1);
    expect(results[0]!.index).toBe(0);
    expect(results[0]!.relevanceScore).toBe(0.5);
    expect(results[0]!.text).toBeUndefined();
  });

  it('handles result item with null relevance_score', async () => {
    const fetchImpl = mockFetch(200, {
      code: 200,
      results: [{ index: 0, relevance_score: null as unknown as number }],
    });
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    const results = await reranker.rerank('q', ['a']);
    expect(results[0]!.relevanceScore).toBe(0);
  });

  it('omits top_n from request when not provided', async () => {
    const fetchImpl = mockFetch(200, { code: 200, results: [] });
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
      fetchImpl,
    });

    await reranker.rerank('q', ['a', 'b']);

    const body = JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string })?.body ?? '{}');
    expect(body).not.toHaveProperty('top_n');
  });

  it('throws when documents exceed maximum (50)', async () => {
    const reranker = new LangSearchReranker({
      apiKey: 'test-key',
    });

    const tooMany = Array.from({ length: 51 }, (_, i) => `doc ${i}`);
    await expect(reranker.rerank('q', tooMany)).rejects.toThrow(/50/);
  });
});
