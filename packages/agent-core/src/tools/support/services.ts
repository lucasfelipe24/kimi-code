import type { UrlFetcher, WebSearchProvider } from '../builtin';
import type { FetchCache } from './fetch-cache';

/** Options passed to WebSearchProvider.search(). */
export interface WebSearchOptions {
  limit?: number;
  includeContent?: boolean;
  toolCallId?: string;
  /** Only include search results from these domains. */
  allowedDomains?: string[];
  /** Never include search results from these domains. */
  blockedDomains?: string[];
}

export interface ToolServices {
  readonly urlFetcher?: UrlFetcher;
  readonly webSearcher?: WebSearchProvider;
  /** Optional cache for FetchURL responses (15-min TTL, 50MB max). */
  readonly fetchCache?: FetchCache;
}
