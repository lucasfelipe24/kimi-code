import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FetchCache, type CacheEntry } from '../../../src/tools/support/fetch-cache';

function makeEntry(bytes: number, content = 'x'): CacheEntry {
  return {
    content,
    contentType: 'text/plain',
    bytes,
    code: 200,
    codeText: 'OK',
    cachedAt: Date.now(),
  };
}

describe('FetchCache', () => {
  let cache: FetchCache;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new FetchCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('set and get roundtrip', () => {
    const entry = makeEntry(50);
    cache.set('https://example.com/page', entry);
    const got = cache.get('https://example.com/page');
    expect(got).toEqual(entry);
  });

  it('expires entries after TTL', () => {
    const shortCache = new FetchCache(1); // 1ms TTL
    const entry = makeEntry(50);
    shortCache.set('https://example.com/page', entry);

    // Advance time past the 1ms TTL.
    vi.advanceTimersByTime(2);

    const got = shortCache.get('https://example.com/page');
    expect(got).toBeUndefined();
    expect(shortCache.size).toBe(0);
    expect(shortCache.totalBytes).toBe(0);
  });

  it('clear removes all entries', () => {
    cache.set('https://a.example.com', makeEntry(10));
    cache.set('https://b.example.com', makeEntry(20));
    expect(cache.size).toBe(2);

    cache.clear();

    expect(cache.size).toBe(0);
    expect(cache.totalBytes).toBe(0);
    expect(cache.get('https://a.example.com')).toBeUndefined();
    expect(cache.get('https://b.example.com')).toBeUndefined();
  });

  it('evicts oldest entries when maxBytes exceeded', () => {
    const smallCache = new FetchCache(
      FetchCache.DEFAULT_TTL_MS,
      100, // maxBytes
    );

    // Three entries of 40 bytes each → total 120 > 100.
    smallCache.set('https://first.example.com', makeEntry(40));
    smallCache.set('https://second.example.com', makeEntry(40));
    smallCache.set('https://third.example.com', makeEntry(40));

    // The first entry should have been evicted.
    expect(smallCache.get('https://first.example.com')).toBeUndefined();
    expect(smallCache.get('https://second.example.com')).toBeDefined();
    expect(smallCache.get('https://third.example.com')).toBeDefined();
    expect(smallCache.totalBytes).toBe(80);
  });

  it('get returns undefined for missing key', () => {
    expect(cache.get('https://not-cached.example.com')).toBeUndefined();
  });
});
