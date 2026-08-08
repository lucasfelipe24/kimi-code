import { describe, expect, it } from 'vitest';

import {
  BraveAnswersInputSchema,
  BraveImageSearchInputSchema,
  BraveLLMContextInputSchema,
  BraveLocalSearchInputSchema,
  BraveNewsSearchInputSchema,
  BraveSpellcheckInputSchema,
  BraveSuggestInputSchema,
  BraveVideoSearchInputSchema,
  BraveWebSearchInputSchema,
} from '#/features/brave-search/contracts';

describe('Brave Search tool contracts', () => {
  it('applies only documented search defaults', () => {
    expect(BraveWebSearchInputSchema.parse({ q: 'query' })).toMatchObject({
      count: 20,
      safesearch: 'moderate',
    });
    expect(BraveNewsSearchInputSchema.parse({ q: 'query' })).toMatchObject({
      count: 20,
      safesearch: 'strict',
    });
    expect(BraveImageSearchInputSchema.parse({ q: 'query' })).toEqual({
      q: 'query',
      count: 50,
      safesearch: 'strict',
    });
    expect(BraveVideoSearchInputSchema.parse({ q: 'query' })).toMatchObject({
      count: 20,
      safesearch: 'moderate',
    });
    expect(BraveSuggestInputSchema.parse({ q: 'query' })).toEqual({ q: 'query' });
    expect(BraveSpellcheckInputSchema.parse({ q: 'query' })).toEqual({ q: 'query' });
    expect(BraveLocalSearchInputSchema.parse({ q: 'query' })).toEqual({
      q: 'query',
      include_descriptions: false,
    });
  });

  it('rejects unknown fields and endpoint-specific invalid ranges', () => {
    expect(() => BraveWebSearchInputSchema.parse({ q: 'q', count: 21 })).toThrow();
    expect(() => BraveNewsSearchInputSchema.parse({ q: 'q', count: 51 })).toThrow();
    expect(() => BraveImageSearchInputSchema.parse({ q: 'q', offset: 1 })).toThrow();
    expect(() => BraveImageSearchInputSchema.parse({ q: 'q', safesearch: 'moderate' })).toThrow();
    expect(() => BraveVideoSearchInputSchema.parse({ q: 'q', offset: 10 })).toThrow();
    expect(() => BraveSuggestInputSchema.parse({ q: 'q', count: 0 })).toThrow();
    expect(() => BraveSpellcheckInputSchema.parse({ q: 'q', rich: true })).toThrow();
    expect(() => BraveWebSearchInputSchema.parse({ q: 'q', result_filter: 'web,bad' })).toThrow();
  });

  it('validates LLM Context query, location, ranges, and defaults', () => {
    const parsed = BraveLLMContextInputSchema.parse({ q: 'ground this answer' });
    expect(parsed).toMatchObject({
      method: 'GET',
      country: 'us',
      search_lang: 'en',
      count: 20,
      maximum_number_of_urls: 20,
      maximum_number_of_tokens: 8192,
      maximum_number_of_snippets: 50,
      maximum_number_of_tokens_per_url: 4096,
      maximum_number_of_snippets_per_url: 50,
    });
    expect(() => BraveLLMContextInputSchema.parse({ q: 'word '.repeat(51) })).toThrow();
    expect(() => BraveLLMContextInputSchema.parse({ q: 'x'.repeat(401) })).toThrow();
    expect(() => BraveLLMContextInputSchema.parse({ q: 'q', location: { lat: 91 } })).toThrow();
    expect(() => BraveLLMContextInputSchema.parse({ q: 'q', location: { long: -181 } })).toThrow();
    expect(() => BraveLLMContextInputSchema.parse({ q: 'q', maximum_number_of_tokens: 1000 })).toThrow();
  });

  it('requires streaming for answer entities, citations, and research', () => {
    const messages = [{ role: 'user' as const, content: 'answer me' }];
    expect(BraveAnswersInputSchema.parse({ messages })).toMatchObject({ stream: false });
    expect(() => BraveAnswersInputSchema.parse({ messages, enable_citations: true })).toThrow();
    expect(() => BraveAnswersInputSchema.parse({ messages, enable_entities: true })).toThrow();
    expect(() => BraveAnswersInputSchema.parse({ messages, enable_research: true })).toThrow();
    expect(
      BraveAnswersInputSchema.parse({ messages, stream: true, enable_citations: true }),
    ).toMatchObject({ stream: true, enable_citations: true });
  });
});
