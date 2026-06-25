/**
 * LangSearchReranker — calls the LangSearch Semantic Rerank API.
 *
 * https://docs.langsearch.com/api/semantic-rerank-api
 *
 * Rate limiting is handled by the API itself (HTTP 429 → automatic
 * retry with backoff via `postWithRetry`). No client-side throttling.
 *
 * Used internally by `LangSearchWebSearchProvider` for automatic
 * result re-ranking.
 */

import { postWithRetry, safeReadText } from '../support/langsearch-http';

export interface LangSearchRerankerOptions {
  /** LangSearch API key (free from https://langsearch.com/api-keys). */
  apiKey: string;
  /**
   * Base URL for the rerank endpoint.
   * @default 'https://api.langsearch.com/v1/rerank'
   */
  baseUrl?: string;
  /**
   * Model version.
   * @default 'langsearch-reranker-v1'
   */
  model?: string;
  /** Override for testing. */
  fetchImpl?: typeof fetch;
}

export interface RerankResult {
  /** Original index in the input `documents` array. */
  index: number;
  /** Semantic relevance score (0–1, higher = more relevant). */
  relevanceScore: number;
  /** Original document text (only when `returnDocuments` was true). */
  text?: string;
}

interface LangSearchRerankResponse {
  code: number;
  log_id?: string;
  msg?: string | null;
  model?: string;
  results?: LangSearchRerankItem[];
}

interface LangSearchRerankItem {
  index: number;
  document?: { text: string };
  relevance_score?: number;
}

/** Maximum documents per rerank request (LangSearch API limit). */
const MAX_DOCUMENTS = 50;

export class LangSearchReranker {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LangSearchRerankerOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.langsearch.com/v1/rerank';
    this.model = options.model ?? 'langsearch-reranker-v1';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Rerank a list of documents by semantic relevance to a query.
   *
   * @param query     - Natural-language search query.
   * @param documents - Candidate document texts (max 50).
   * @param topN      - How many top results to return (default: all).
   */
  async rerank(
    query: string,
    documents: string[],
    topN?: number,
  ): Promise<RerankResult[]> {
    if (documents.length > MAX_DOCUMENTS) {
      throw new Error(
        `LangSearch rerank supports at most ${String(MAX_DOCUMENTS)} documents, got ${String(documents.length)}.`,
      );
    }

    const body = {
      model: this.model,
      query,
      documents,
      top_n: topN,
      return_documents: true,
    };

    const response = await postWithRetry({
      url: this.baseUrl,
      bodyJson: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      fetchImpl: this.fetchImpl,
    });

    if (response.status === 401) {
      const detail = await safeReadText(response);
      throw new Error(
        `LangSearch rerank request failed: HTTP 401 (auth/unauthorized). ${detail}`.trim(),
      );
    }

    if (response.status !== 200) {
      const detail = await safeReadText(response);
      throw new Error(
        `LangSearch rerank request failed: HTTP ${String(response.status)}. ${detail}`.trim(),
      );
    }

    const json = (await response.json()) as LangSearchRerankResponse;
    const raw = Array.isArray(json.results) ? json.results : [];

    return raw.map((item): RerankResult => ({
      index: item.index,
      relevanceScore: item.relevance_score ?? 0,
      text: item.document?.text,
    }));
  }
}
