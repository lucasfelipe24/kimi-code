/**
 * `auth/brave` domain — shared HTTP client for Brave Search APIs.
 *
 * Owns authenticated GET and POST requests against the configured Brave API
 * endpoint, including repeated query values, per-request headers, bounded GET
 * retries, request timeouts, streaming responses, and boundary error
 * translation. It owns no scoped state and is constructed by Brave-backed
 * providers.
 */

import { isAbortError } from '#/_base/utils/abort';
import { Error2, ErrorCodes } from '#/errors';

export type BraveQueryValue = string | number | boolean;
export type BraveQuery = Readonly<
  Record<string, BraveQueryValue | readonly BraveQueryValue[] | undefined>
>;

export interface BraveClientOptions {
  apiKey: string;
  baseUrl?: string;
  customHeaders?: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryAfterMaxMs?: number;
}

export interface BraveRequestOptions {
  method?: 'GET' | 'POST';
  query?: BraveQuery;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

const DEFAULT_BASE_URL = 'https://api.search.brave.com/res/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_AFTER_MAX_MS = 2_000;

export class BraveClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly customHeaders: Readonly<Record<string, string>>;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retryAfterMaxMs: number;

  constructor(options: BraveClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.customHeaders = options.customHeaders ?? {};
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = Math.max(0, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.retryAfterMaxMs = Math.max(0, options.retryAfterMaxMs ?? DEFAULT_RETRY_AFTER_MAX_MS);
  }

  async request(path: string, options: BraveRequestOptions = {}): Promise<Response> {
    const method = options.method ?? 'GET';
    const url = this.buildUrl(path, options.query);
    const init = this.buildRequestInit(method, options);
    const maxAttempts = method === 'GET' ? 2 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, init, options.signal);
        if (response.ok) return response;
        if (attempt + 1 < maxAttempts && isRetryableStatus(response.status)) {
          await response.body?.cancel();
          await this.waitBeforeRetry(response.headers.get('Retry-After'), options.signal);
          continue;
        }
        throw httpError(response.status);
      } catch (error) {
        if (options.signal?.aborted === true) throw options.signal.reason ?? error;
        if (isAbortError(error)) throw error;
        if (error instanceof Error2) throw error;
        if (isTimeoutError(error)) throw error;
        if (attempt + 1 < maxAttempts) {
          await this.waitBeforeRetry(undefined, options.signal);
          continue;
        }
        throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'Brave API request failed.');
      }
    }

    throw new Error2(ErrorCodes.WEB_FETCH_FAILED, 'Brave API request failed.');
  }

  async requestJson<T>(path: string, options: BraveRequestOptions = {}): Promise<T> {
    const response = await this.request(path, options);
    try {
      return (await response.json()) as T;
    } catch {
      throw new Error2(
        ErrorCodes.WEB_FETCH_FAILED,
        'Brave API returned an invalid JSON response.',
        { details: { status: response.status } },
      );
    }
  }

  private buildRequestInit(
    method: 'GET' | 'POST',
    options: BraveRequestOptions,
  ): Omit<RequestInit, 'signal'> {
    const headers = new Headers({
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'Cache-Control': 'no-cache',
    });
    for (const [name, value] of Object.entries(this.customHeaders)) headers.set(name, value);
    for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
    headers.set('X-Subscription-Token', this.apiKey);

    let body: string | undefined;
    if (method === 'POST') {
      headers.set('Content-Type', 'application/json');
      body = JSON.stringify(options.body);
    }
    return { method, headers, body };
  }

  private async fetchWithTimeout(
    url: string,
    init: Omit<RequestInit, 'signal'>,
    externalSignal: AbortSignal | undefined,
  ): Promise<Response> {
    if (externalSignal?.aborted === true) {
      throw externalSignal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }

    const controller = new AbortController();
    const onExternalAbort = (): void => {
      controller.abort(externalSignal?.reason);
    };
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
    const timeout =
      this.timeoutMs > 0
        ? setTimeout(() => {
            controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
          }, this.timeoutMs)
        : undefined;

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (externalSignal?.aborted) throw externalSignal.reason ?? error;
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private async waitBeforeRetry(
    retryAfter: string | null | undefined,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const delayMs = Math.min(parseRetryAfter(retryAfter), this.retryAfterMaxMs);
    if (delayMs <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (): void => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted === true) onAbort();
    });
  }

  private buildUrl(path: string, query: BraveQuery | undefined): string {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, '')}`);
    for (const [name, raw] of Object.entries(query ?? {})) {
      if (raw === undefined) continue;
      const values = Array.isArray(raw) ? raw : [raw];
      for (const value of values) url.searchParams.append(name, String(value));
    }
    return url.toString();
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function parseRetryAfter(value: string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function httpError(status: number): Error2 {
  return new Error2(
    ErrorCodes.WEB_FETCH_FAILED,
    `Brave API request failed: HTTP ${String(status)}.`,
    { details: { status } },
  );
}
