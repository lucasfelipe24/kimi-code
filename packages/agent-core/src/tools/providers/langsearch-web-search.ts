/**
 * LangSearchWebSearchProvider — calls the LangSearch Web Search API
 * with automatic semantic reranking of results.
 *
 * https://docs.langsearch.com/api/web-search-api
 *
 * Rate limiting is handled by the API itself (HTTP 429 → automatic retry
 * with backoff via `postWithRetry`). No client-side throttling is applied.
 *
 * Response format is Bing-compatible.
 */

import type { WebSearchProvider, WebSearchResult } from '../builtin';
import { postWithRetry, safeReadText } from '../support/langsearch-http';
import type { LangSearchReranker } from './langsearch-rerank';

export interface LangSearchWebSearchOptions {
  /** LangSearch API key (free from https://langsearch.com/api-keys). */
  apiKey: string;
  /**
   * Base URL for the web-search endpoint.
   * @default 'https://api.langsearch.com/v1/web-search'
   */
  baseUrl?: string;
  /**
   * Optional reranker for semantic re-ranking of search results.
   * When provided, search results are automatically reordered by
   * relevance before being returned to the LLM.
   */
  reranker?: LangSearchReranker;
  /** Override for testing. */
  fetchImpl?: typeof fetch;
}

// ── Raw API types (Bing-compatible) ─────────────────────────────────

interface LangSearchSearchResponse {
  code: number;
  log_id?: string;
  msg?: string | null;
  data?: LangSearchData;
}

interface LangSearchData {
  _type?: string;
  queryContext?: { originalQuery?: string };
  webPages?: LangSearchWebPages;
}

interface LangSearchWebPages {
  webSearchUrl?: string;
  totalEstimatedMatches?: number | null;
  someResultsRemoved?: boolean;
  value?: LangSearchWebPageValue[];
}

interface LangSearchWebPageValue {
  id?: string;
  name?: string;
  url?: string;
  displayUrl?: string;
  snippet?: string;
  summary?: string;
  datePublished?: string | null;
  dateLastCrawled?: string | null;
}

function filterByDomain(
  results: WebSearchResult[],
  allowed?: string[],
  blocked?: string[],
): WebSearchResult[] {
  if (!allowed?.length && !blocked?.length) return results;

  return results.filter((r) => {
    let hostname: string;
    try {
      hostname = new URL(r.url).hostname.replace(/^www\./, '');
    } catch {
      return false;
    }

    if (allowed?.length) {
      const normalizedAllowed = allowed.map((d) => d.replace(/^www\./, ''));
      if (!normalizedAllowed.includes(hostname)) return false;
    }

    if (blocked?.length) {
      const normalizedBlocked = blocked.map((d) => d.replace(/^www\./, ''));
      if (normalizedBlocked.includes(hostname)) return false;
    }

    return true;
  });
}

export class LangSearchWebSearchProvider implements WebSearchProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly reranker: LangSearchReranker | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LangSearchWebSearchOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.langsearch.com/v1/web-search';
    this.reranker = options.reranker;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async search(
    query: string,
    options?: { limit?: number; includeContent?: boolean; toolCallId?: string; allowedDomains?: string[]; blockedDomains?: string[] },
  ): Promise<WebSearchResult[]> {
    const body = {
      query,
      freshness: 'noLimit' as const,
      summary: options?.includeContent ?? false,
      count: clampLimit(options?.limit),
    };
    const bodyJson = JSON.stringify(body);

    const toolCallId = options?.toolCallId;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (toolCallId !== undefined && toolCallId.length > 0) {
      headers['X-Tool-Call-Id'] = toolCallId;
    }

    const response = await postWithRetry({
      url: this.baseUrl,
      bodyJson,
      headers,
      fetchImpl: this.fetchImpl,
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(
        `LangSearch search request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
      );
    }

    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(
        `LangSearch search request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    const json = (await response.json()) as LangSearchSearchResponse;
    const raw = json.data?.webPages?.value ?? [];

    let results: WebSearchResult[] = raw.map((r): WebSearchResult => {
      const out: WebSearchResult = {
        title: r.name ?? '',
        url: r.url ?? '',
        snippet: r.snippet ?? '',
      };
      if (typeof r.datePublished === 'string' && r.datePublished.length > 0) {
        out.date = r.datePublished;
      }
      if (typeof r.summary === 'string' && r.summary.length > 0) {
        out.content = r.summary;
      }
      return out;
    });

    results = filterByDomain(results, options?.allowedDomains, options?.blockedDomains);

    // ── Semantic rerank (automatic when reranker is configured) ──
    if (this.reranker !== undefined && results.length > 1) {
      try {
        const snippets = results.map((r) => r.snippet);
        const ranked = await this.reranker.rerank(query, snippets);
        const reranked = ranked
          .filter((item) => item.index < results.length)
          .map((item) => results[item.index])
          .filter((r): r is WebSearchResult => r !== undefined);
        if (reranked.length === results.length) {
          results = reranked;
        }
      } catch {
        // Rerank failure is non-fatal — fall back to original order.
      }
    }

    return results;
  }
}

/**
 * Clamp limit to LangSearch's valid range (1–10). The tool schema
 * allows up to 20, but the API caps at 10.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return 10;
  return Math.max(1, Math.min(10, Math.round(limit)));
}
