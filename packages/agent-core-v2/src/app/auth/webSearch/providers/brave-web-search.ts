/**
 * `auth` domain — Brave-backed generic web-search provider.
 *
 * Implements the `WebSearchProvider` contract through the shared `auth/brave`
 * JSON client and maps Brave web results into the generic tool result shape.
 * It owns no scoped state and is constructed by `WebSearchProviderService`.
 */

import type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';
import { BraveClient, type BraveClientOptions } from '#/app/auth/brave/braveClient';

export interface BraveWebSearchProviderOptions extends BraveClientOptions {
  count?: number;
}

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
  published?: string;
  page_age?: string;
  age?: string;
  profile?: {
    long_name?: string;
    name?: string;
  };
  meta_url?: {
    hostname?: string;
  };
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

const DEFAULT_COUNT = 10;

export class BraveWebSearchProvider implements WebSearchProvider {
  private readonly client: BraveClient;
  private readonly count: number;

  constructor(options: BraveWebSearchProviderOptions) {
    this.client = new BraveClient(options);
    this.count = options.count ?? DEFAULT_COUNT;
  }

  async search(
    query: string,
    options?: { toolCallId?: string; signal?: AbortSignal },
  ): Promise<WebSearchResult[]> {
    const response = await this.client.requestJson<BraveSearchResponse>('/web/search', {
      query: { q: query, count: this.count },
      signal: options?.signal,
    });
    const results = response.web?.results;
    if (!Array.isArray(results)) return [];

    return results.map((result): WebSearchResult => {
      const mapped: WebSearchResult = {
        title: stripStrongTags(result.title ?? ''),
        url: result.url ?? '',
        snippet: stripStrongTags(result.description ?? ''),
      };
      const siteName = result.profile?.long_name ?? result.profile?.name ?? result.meta_url?.hostname;
      const date = result.published ?? result.page_age ?? result.age;
      if (typeof siteName === 'string' && siteName.length > 0) mapped.siteName = siteName;
      if (typeof date === 'string' && date.length > 0) mapped.date = date;
      return mapped;
    });
  }
}

function stripStrongTags(value: string): string {
  return value.replaceAll(/<\/?strong>/gi, '');
}
