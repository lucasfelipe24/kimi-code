/**
 * Shared HTTP helpers for LangSearch providers.
 *
 * Utilities used by both `LangSearchWebSearchProvider` and
 * `LangSearchReranker` to avoid duplication.
 */

export interface PostRequest {
  url: string;
  bodyJson: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
  /** Max retry attempts (default 3). */
  maxRetries?: number;
}

/**
 * POST with retry on HTTP 429 (rate-limited) and network errors.
 *
 * Backs off linearly on 429 (respecting `Retry-After` when numeric),
 * and on network errors. Throws the last error when all retries are
 * exhausted.
 */
export async function postWithRetry(req: PostRequest): Promise<Response> {
  const maxRetries = req.maxRetries ?? 3;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await req.fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.bodyJson,
      });

      if (response.status === 429) {
        lastError = new Error(
          `LangSearch rate limited (HTTP 429) on attempt ${String(attempt + 1)}`,
        );
        const retryAfter = parseRetryAfter(response);
        await sleep(retryAfter * 1000);
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        await sleep(1000 * (attempt + 1));
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}

/**
 * Parse the `Retry-After` response header.
 *
 * Handles both delta-seconds (integer) and HTTP-date (RFC 7231).
 * Falls back to 1 second when unparseable.
 */
export function parseRetryAfter(response: Response): number {
  const header = response.headers.get('Retry-After');
  if (header === null) return 1;

  // Try delta-seconds first.
  const parsed = Number(header);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;

  // Try HTTP-date.
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = Math.ceil((date - Date.now()) / 1000);
    return delta > 0 ? delta : 1;
  }

  return 1;
}

/**
 * Safely read the response body as text, returning '' on failure.
 */
export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
