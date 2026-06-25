/**
 * Blocklist preflight checker.
 *
 * Checks whether a domain is allowed by querying an external blocklist
 * service.  When the service is unavailable or unconfigured the checker
 * defaults to permissive (allow).
 */

/** Result of checking a single domain against the blocklist. */
export type DomainCheckResult =
  | { readonly status: 'allowed' }
  | { readonly status: 'blocked' }
  | { readonly status: 'check_failed'; readonly error: Error };

/** Interface for a domain blocklist checker. */
export interface BlocklistChecker {
  /**
   * Check whether `domain` is allowed.
   *
   * Implementations MUST NOT throw — errors are surfaced through the
   * returned {@link DomainCheckResult}.
   */
  checkDomain(domain: string): Promise<DomainCheckResult>;
}

// ---------------------------------------------------------------------------
// HttpBlocklistChecker
// ---------------------------------------------------------------------------

/** Options for {@link HttpBlocklistChecker}. */
export interface HttpBlocklistCheckerOptions {
  /**
   * Base URL of the blocklist service.
   *
   * The checker sends `GET {baseUrl}?domain={domain}`.  When omitted the
   * checker behaves permissively (`'allowed'` for every domain), acting as a
   * feature gate.
   */
  readonly baseUrl?: string;

  /** Request timeout in milliseconds (default 10 000). */
  readonly timeout?: number;

  /** Fetch implementation (defaults to the global `fetch`). */
  readonly fetchImpl?: typeof fetch;
}

interface AllowedCacheEntry {
  readonly status: 'allowed';
  cachedAt: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * HTTP-based domain blocklist checker.
 *
 * Queries an external service on cache miss and caches `'allowed'` results
 * for 5 minutes.  `'blocked'` and `'check_failed'` results are never cached
 * so that transient errors and blocklist removals are picked up quickly.
 */
export class HttpBlocklistChecker implements BlocklistChecker {
  private readonly baseUrl: string | undefined;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;

  /**
   * In-memory cache of *allowed* domains.
   *
   * Only `'allowed'` results are cached (5-min TTL).  We deliberately do not
   * cache `'blocked'` because blocklists change and we want prompt
   * reflection.  We also do not cache `'check_failed'` so that transient
   * network issues self-heal.
   */
  private readonly allowedCache = new Map<string, AllowedCacheEntry>();

  constructor(options: HttpBlocklistCheckerOptions = {}) {
    this.baseUrl = options.baseUrl;
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async checkDomain(domain: string): Promise<DomainCheckResult> {
    // 1. In-memory cache (only stores 'allowed' entries).
    const cached = this.allowedCache.get(domain);
    if (cached !== undefined) {
      if (Date.now() - cached.cachedAt < CACHE_TTL_MS) {
        return { status: 'allowed' };
      }
      // Expired — evict and fall through.
      this.allowedCache.delete(domain);
    }

    // 2. Permissive default when no baseUrl is configured.
    if (this.baseUrl === undefined) {
      return { status: 'allowed' };
    }

    // 3. Query the blocklist service.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      let response: Response;
      try {
        const url = `${this.baseUrl}?domain=${encodeURIComponent(domain)}`;
        response = await this.fetchImpl(url, {
          method: 'GET',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        return {
          status: 'check_failed',
          error: new Error(
            `Blocklist service returned HTTP ${String(response.status)} for domain "${domain}"`,
          ),
        };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return {
          status: 'check_failed',
          error: new Error(
            `Blocklist service returned invalid JSON for domain "${domain}"`,
          ),
        };
      }

      const canFetch = extractCanFetch(body);
      if (canFetch === true) {
        this.allowedCache.set(domain, { status: 'allowed', cachedAt: Date.now() });
        return { status: 'allowed' };
      }

      if (canFetch === false) {
        return { status: 'blocked' };
      }

      // Unexpected body shape.
      return {
        status: 'check_failed',
        error: new Error(
          `Blocklist service returned unexpected body for domain "${domain}"`,
        ),
      };
    } catch (error) {
      return {
        status: 'check_failed',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }
}

/**
 * Safely extract the `can_fetch` boolean from the parsed JSON body.
 *
 * Returns `undefined` when the field is missing or of the wrong type.
 */
function extractCanFetch(body: unknown): boolean | undefined {
  if (
    body !== null &&
    typeof body === 'object' &&
    'can_fetch' in body
  ) {
    const value = (body as Record<string, unknown>)['can_fetch'];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// NoopBlocklistChecker
// ---------------------------------------------------------------------------

/**
 * No-op blocklist checker that permits every domain.
 *
 * Use this when the blocklist feature is disabled or the service is not
 * available, so that callers always receive a valid {@link BlocklistChecker}
 * without conditional wrapping.
 */
export class NoopBlocklistChecker implements BlocklistChecker {
  async checkDomain(_domain: string): Promise<DomainCheckResult> {
    return { status: 'allowed' };
  }
}
