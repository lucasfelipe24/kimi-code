/**
 * Cached result of a URL fetch operation.
 */
export interface CacheEntry {
  /** The response body text. */
  content: string;
  /** The Content-Type header value (e.g. "text/html; charset=utf-8"). */
  contentType: string;
  /** Size of the response body in bytes. */
  bytes: number;
  /** HTTP status code. */
  code: number;
  /** HTTP status text (e.g. "OK"). */
  codeText: string;
  /** Timestamp (ms since Unix epoch) when this entry was cached. */
  cachedAt: number;
}

/**
 * An in-memory LRU cache for URL fetch results.
 *
 * Entries are evicted on two conditions:
 * - **TTL expiry** — a `get()` call drops any entry whose age exceeds `ttlMs`.
 * - **Byte budget** — when a `set()` would push total cached bytes past `maxBytes`,
 *   the oldest entries (by insertion order) are evicted until the new entry fits.
 *
 * Uses a native `Map`; no external dependencies.
 */
export class FetchCache {
  /** Default TTL: 15 minutes. */
  static readonly DEFAULT_TTL_MS = 15 * 60 * 1000;
  /** Default byte budget: 50 MiB. */
  static readonly DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

  readonly #ttlMs: number;
  readonly #maxBytes: number;
  readonly #store = new Map<string, CacheEntry>();
  #totalBytes = 0;

  /**
   * @param ttlMs   Time-to-live in milliseconds (default 15 min).
   * @param maxBytes Maximum total cached bytes before eviction (default 50 MiB).
   */
  constructor(ttlMs: number = FetchCache.DEFAULT_TTL_MS, maxBytes: number = FetchCache.DEFAULT_MAX_BYTES) {
    this.#ttlMs = ttlMs;
    this.#maxBytes = maxBytes;
  }

  /**
   * Retrieve a cached entry by URL.
   *
   * If the entry has expired (age > ttlMs) it is silently removed and `undefined`
   * is returned.
   *
   * @returns The cached entry, or `undefined` if not found or expired.
   */
  get(url: string): CacheEntry | undefined {
    const entry = this.#store.get(url);
    if (!entry) return undefined;

    if (Date.now() - entry.cachedAt > this.#ttlMs) {
      this.#store.delete(url);
      this.#totalBytes -= entry.bytes;
      return undefined;
    }

    return entry;
  }

  /**
   * Store a fetch result in the cache.
   *
   * If adding the entry would cause `totalBytes` to exceed `maxBytes`, the
   * oldest entries (by Map insertion order) are evicted until enough space
   * is freed. When the entry's own byte size exceeds `maxBytes`, all existing
   * entries are evicted first; the oversized entry is still stored so that
   * subsequent `get()` calls can serve it while it remains fresh.
   */
  set(url: string, entry: CacheEntry): void {
    // Evict a previous entry for the same URL so we don't double-count bytes.
    const existing = this.#store.get(url);
    if (existing) {
      this.#totalBytes -= existing.bytes;
    }

    // Evict oldest entries while the budget would be exceeded and the store is
    // non-empty (which also prevents an infinite loop when a single entry is
    // larger than maxBytes).
    while (this.#store.size > 0 && this.#totalBytes + entry.bytes > this.#maxBytes) {
      const [oldestKey, oldestEntry] = this.#store.entries().next().value!;
      this.#store.delete(oldestKey);
      this.#totalBytes -= oldestEntry.bytes;
    }

    this.#store.set(url, entry);
    this.#totalBytes += entry.bytes;
  }

  /**
   * Remove all cached entries and reset the byte counter.
   */
  clear(): void {
    this.#store.clear();
    this.#totalBytes = 0;
  }

  /** Current number of cached entries. */
  get size(): number {
    return this.#store.size;
  }

  /** Current total bytes stored across all entries. */
  get totalBytes(): number {
    return this.#totalBytes;
  }
}
