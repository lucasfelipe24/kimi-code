/**
 * AuthCodeOAuthManager — Authorization Code + PKCE token lifecycle.
 *
 * Handles:
 *  - `login()`:  browser-based OAuth flow with PKCE, local callback server,
 *                token exchange, and storage.
 *  - `ensureFresh()`: lazy token refresh with cross-process locking (same
 *                pattern as the device-code OAuthManager).
 *  - `logout()` / `hasToken()` / `getCachedAccessToken()`: storage helpers.
 *
 * The refresh path uses the provider's `tokenUrl` directly (not the Kimi
 * `/api/oauth/token` path), making this suitable for any standard OAuth 2.0
 * server that supports `grant_type=refresh_token`.
 */

import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { TokenInfo, TokenStorage } from '@moonshot-ai/kimi-code-oauth';
import { OAuthUnauthorizedError } from '@moonshot-ai/kimi-code-oauth';

import { AuthCodeListener } from './auth-code-listener';
import { generatePKCEParams } from './pkce';
import type {
  AuthCodeFlowConfig,
  AuthCodeLoginResult,
  BearerTokenProvider,
} from './types';

// ─── Constants ────────────────────────────────────────────────────────────

const MIN_REFRESH_THRESHOLD_SECONDS = 300; // 5 minutes
const REFRESH_THRESHOLD_RATIO = 0.5;
const DEFAULT_TIMEOUT_MS = 30_000;

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

// ─── Helpers ──────────────────────────────────────────────────────────────

interface TokenStateValid {
  readonly kind: 'valid';
  readonly token: TokenInfo;
}

interface TokenStateRevoked {
  readonly kind: 'revoked';
}

interface TokenStateMissing {
  readonly kind: 'missing';
}

type TokenState = TokenStateValid | TokenStateRevoked | TokenStateMissing;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function classifyToken(
  storage: TokenStorage,
  name: string,
): Promise<TokenState> {
  const token = await storage.load(name);
  if (token === undefined) return { kind: 'missing' };
  // A revoked token has an empty access token and zero expiry
  if (token.accessToken.length === 0 && token.expiresAt === 0 && token.refreshToken.length > 0) {
    return { kind: 'revoked' };
  }
  return { kind: 'valid', token };
}

function revokedTombstone(token: TokenInfo): TokenInfo {
  return {
    ...token,
    accessToken: '',
    expiresAt: 0,
    expiresIn: 0,
    scope: '',
    tokenType: '',
  };
}

function defaultRefreshThreshold(expiresIn: number): number {
  if (expiresIn > 0) {
    return Math.max(MIN_REFRESH_THRESHOLD_SECONDS, expiresIn * REFRESH_THRESHOLD_RATIO);
  }
  return MIN_REFRESH_THRESHOLD_SECONDS;
}

function extractApiErrorMessage(data: Record<string, unknown>): string | undefined {
  const msg = data['error_message'] ?? data['message'] ?? data['error_description'] ?? data['error'];
  return typeof msg === 'string' ? msg : undefined;
}

// ─── Token refresh / exchange HTTP ────────────────────────────────────────

async function postForm(
  url: string,
  params: Record<string, string>,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ status: number; data: Record<string, unknown> }> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = new URLSearchParams(params).toString();
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (options?.signal !== undefined) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
      signal,
    });
  } catch (error) {
    throw new Error(
      `OAuth request to ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const status = response.status;
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed)) data = parsed;
  } catch {
    // Non-JSON response — leave data empty
  }
  return { status, data };
}

function tokenFromResponse(payload: Record<string, unknown>): TokenInfo {
  const accessToken = payload['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new Error('OAuth response missing access_token');
  }
  const refreshToken = payload['refresh_token'];
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
    throw new Error('OAuth response missing refresh_token');
  }
  const expiresInRaw = payload['expires_in'];
  const expiresIn = Number(expiresInRaw);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OAuth response missing or invalid expires_in');
  }
  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    scope: typeof payload['scope'] === 'string' ? payload['scope'] : '',
    tokenType: typeof payload['token_type'] === 'string' ? payload['token_type'] : 'Bearer',
    expiresIn,
  };
}

async function exchangeCodeForTokens(
  tokenUrl: string,
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<TokenInfo> {
  const { status, data } = await postForm(tokenUrl, {
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
  });

  if (status !== 200) {
    const detail = extractApiErrorMessage(data) ?? `HTTP ${status}`;
    throw new Error(`Token exchange failed: ${detail}`);
  }

  return tokenFromResponse(data);
}

// ─── AuthCodeOAuthManager ─────────────────────────────────────────────────

export interface AuthCodeOAuthManagerOptions {
  readonly config: AuthCodeFlowConfig;
  readonly storage: TokenStorage;
  /**
   * Root directory for per-provider cross-process lock files.
   * When omitted, cross-process locking is skipped (same as OAuthManager).
   */
  readonly configDir?: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly openBrowser?: (url: string) => Promise<void>;
}

export class AuthCodeOAuthManager {
  private readonly config: AuthCodeFlowConfig;
  private readonly storage: TokenStorage;
  private readonly configDir: string | undefined;
  private readonly nowFn: () => number;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly openBrowserFn: (url: string) => Promise<void>;
  private inFlightRefresh: { promise: Promise<string>; force: boolean } | undefined;

  constructor(options: AuthCodeOAuthManagerOptions) {
    this.config = options.config;
    this.storage = options.storage;
    this.configDir = options.configDir;
    this.nowFn = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.sleepFn = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.openBrowserFn = options.openBrowser ?? defaultOpenBrowser;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Run the full browser-based OAuth Authorization Code + PKCE login flow.
   *
   * 1. Generate PKCE params (code_verifier, code_challenge, state)
   * 2. Start a local HTTP callback server
   * 3. Build the authorize URL and open the user's browser
   * 4. Wait for the authorization code via the callback
   * 5. Exchange the code for tokens
   * 6. Extract account ID (if the provider supports it)
   * 7. Persist tokens
   */
  async login(options?: {
    readonly signal?: AbortSignal;
    readonly onAuthUrl?: (url: string) => void;
  }): Promise<AuthCodeLoginResult> {
    // 1. PKCE
    const pkce = generatePKCEParams();

    // 2. Start callback server
    const callbackPath = this.config.callbackPath ?? '/callback';
    const listener = new AuthCodeListener({
      port: this.config.redirectPort ?? 0,
      callbackPath,
      state: pkce.state,
    });

    let redirectUri: string;
    try {
      redirectUri = await listener.start();
    } catch (error) {
      throw new Error(
        `Failed to start OAuth callback server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 3. Build authorize URL
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: this.config.scopes.join(' '),
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      state: pkce.state,
    });

    // Append provider-specific extra params
    if (this.config.extraAuthParams) {
      for (const [key, value] of Object.entries(this.config.extraAuthParams)) {
        params.set(key, value);
      }
    }

    const authorizeUrl = `${this.config.authorizeUrl}?${params.toString()}`;

    // 4. Notify caller + open browser
    options?.onAuthUrl?.(authorizeUrl);
    await this.openBrowserFn(authorizeUrl);

    // 5. Wait for code
    let code: string;
    try {
      code = await listener.waitForAuthCode({
        signal: options?.signal,
      });
    } catch (error) {
      await listener.close();
      throw error;
    } finally {
      // Server is closed after callback or timeout — no need to keep it alive
      void listener.close();
    }

    // 6. Exchange code for tokens
    const token = await exchangeCodeForTokens(
      this.config.tokenUrl,
      this.config.clientId,
      code,
      pkce.codeVerifier,
      redirectUri,
    );

    // 7. Extract account ID
    let accountId: string | undefined;
    if (this.config.extractAccountId) {
      try {
        accountId = this.config.extractAccountId(token.accessToken);
      } catch {
        // Non-critical — continue without account ID
      }
    }

    // 8. Persist
    await this.storage.save(this.config.name, token);

    return { token, accountId };
  }

  /**
   * Return a valid access_token, refreshing if near expiry.
   * Throws if no token is persisted (caller should invoke login first).
   */
  async ensureFresh(options: { force?: boolean } = {}): Promise<string> {
    const force = options.force === true;
    const current = this.inFlightRefresh;
    if (current !== undefined) {
      if (!force || current.force) {
        return current.promise;
      }
      // Wait for the non-force call to settle, then start our own forced refresh
      return current.promise.catch(() => undefined).then(() => this.ensureFresh(options));
    }

    const promise = this.doEnsureFresh(force).finally(() => {
      if (this.inFlightRefresh?.promise === promise) {
        this.inFlightRefresh = undefined;
      }
    });
    this.inFlightRefresh = { promise, force };
    return promise;
  }

  /** Delete stored tokens for this provider. */
  async logout(): Promise<void> {
    await this.storage.remove(this.config.name);
  }

  /** Check whether a valid token is persisted. */
  async hasToken(): Promise<boolean> {
    const state = await this.loadState();
    return state.kind === 'valid';
  }

  /** Read the cached access token without refreshing. */
  async getCachedAccessToken(): Promise<string | undefined> {
    const state = await this.loadState();
    return state.kind === 'valid' ? state.token.accessToken : undefined;
  }

  /** Create a BearerTokenProvider suitable for ProviderManager integration. */
  tokenProvider(): BearerTokenProvider {
    return {
      getAccessToken: (opts) => this.ensureFresh(opts),
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private async loadState(): Promise<TokenState> {
    return classifyToken(this.storage, this.config.name);
  }

  private shouldRefresh(token: TokenInfo, force: boolean): boolean {
    if (force) return true;
    if (token.expiresAt === 0) return false;
    const remaining = token.expiresAt - this.nowFn();
    return remaining < defaultRefreshThreshold(token.expiresIn);
  }

  private async doEnsureFresh(force: boolean): Promise<string> {
    const initial = await this.loadState();
    switch (initial.kind) {
      case 'missing':
        throw new OAuthUnauthorizedError(
          `No OAuth token for "${this.config.name}". Run login first.`,
        );
      case 'revoked':
        throw new OAuthUnauthorizedError(
          `Stored OAuth token for "${this.config.name}" was rejected. Re-login required.`,
        );
      case 'valid':
        break;
    }
    const token = initial.token;

    if (!this.shouldRefresh(token, force)) {
      return token.accessToken;
    }

    // Cross-process lock (skipped on Windows)
    const release = await this.acquireRefreshLock();
    try {
      // Post-lock re-read
      const afterLock = await this.loadState();
      let activeToken: TokenInfo;
      switch (afterLock.kind) {
        case 'revoked':
          throw new OAuthUnauthorizedError(
            `Stored OAuth token for "${this.config.name}" was rejected. Re-login required.`,
          );
        case 'missing':
          activeToken = token;
          break;
        case 'valid': {
          const after = afterLock.token;
          if (!this.shouldRefresh(after, force)) {
            return after.accessToken;
          }
          if (force) {
            const changedWhileWaiting =
              after.refreshToken !== token.refreshToken ||
              after.accessToken !== token.accessToken ||
              after.expiresAt !== token.expiresAt ||
              after.expiresIn !== token.expiresIn;
            if (changedWhileWaiting) {
              return after.accessToken;
            }
          }
          activeToken = after;
          break;
        }
      }

      if (activeToken.refreshToken.length === 0) {
        throw new OAuthUnauthorizedError(
          `OAuth token for "${this.config.name}" has no refresh_token. Re-login required.`,
        );
      }

      try {
        const refreshed = await this.refreshToken(activeToken.refreshToken);
        await this.storage.save(this.config.name, refreshed);
        return refreshed.accessToken;
      } catch (error) {
        // 401 might mean token revoked or concurrent process refresh race
        if (error instanceof OAuthUnauthorizedError) {
          await this.sleepFn(100);
          const recovery = await this.loadState();
          if (
            recovery.kind === 'valid' &&
            recovery.token.refreshToken !== activeToken.refreshToken
          ) {
            return recovery.token.accessToken;
          }
          // Genuinely revoked — tombstone
          await this.storage.save(this.config.name, revokedTombstone(activeToken));
        }
        throw error;
      }
    } finally {
      await release();
    }
  }

  private async refreshToken(refreshToken: string): Promise<TokenInfo> {
    const maxRetries = 3;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
      let status: number;
      let data: Record<string, unknown>;
      try {
        ({ status, data } = await postForm(this.config.tokenUrl, {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.config.clientId,
        }));
      } catch (error) {
        lastError =
          error instanceof Error ? error : new Error(String(error));
        if (attempt < maxRetries - 1) {
          await this.sleepFn(2 ** attempt * 1000);
          continue;
        }
        throw lastError;
      }

      if (status === 200 && typeof data['access_token'] === 'string') {
        return tokenFromResponse(data);
      }

      const errorCode = typeof data['error'] === 'string' ? data['error'] : '';
      const detail = extractApiErrorMessage(data);
      if (status === 401 || status === 403 || errorCode === 'invalid_grant') {
        throw new OAuthUnauthorizedError(`Token refresh unauthorized${detail ? `: ${detail}` : ''}`);
      }

      const desc = detail ?? `Token refresh failed (HTTP ${status})`;
      if (RETRYABLE_STATUSES.has(status)) {
        lastError = new Error(desc);
        if (attempt < maxRetries - 1) {
          await this.sleepFn(2 ** attempt * 1000);
          continue;
        }
      } else {
        throw new Error(desc);
      }
    }

    throw lastError ?? new Error('Token refresh failed after retries');
  }

  // ── Cross-process lock ──────────────────────────────────────────────────

  private resolveLockTarget(): string | undefined {
    if (process.platform === 'win32') return undefined;
    if (process.env['KIMI_DISABLE_OAUTH_LOCK'] === '1') return undefined;
    if (this.configDir === undefined) return undefined;
    return `${this.configDir}/oauth/${this.config.name}`;
  }

  private async acquireRefreshLock(): Promise<() => Promise<void>> {
    const target = this.resolveLockTarget();
    if (target === undefined) return async () => {};

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, '', { flag: 'a' });
    } catch (error) {
      throw new Error(
        `Unable to prepare OAuth refresh lock for "${this.config.name}": ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Simple file-based locking using a temp file approach.
    // We use an atomic rename-based lock since proper-lockfile is an
    // optional peer dependency; this is simpler and works cross-platform.
    const lockFile = `${target}.lock`;
    const maxRetries = 120;
    for (let i = 0; i < maxRetries; i++) {
      const tmpFile = `${lockFile}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
      try {
        // Write the lock holder PID
        await writeFile(tmpFile, String(process.pid), { flag: 'wx' });
        try {
          // Try to rename atomically
          const { rename, unlink } = await import('node:fs/promises');
          await rename(tmpFile, lockFile);
          return async () => {
            try {
              await unlink(lockFile);
            } catch {
              // Lock file may already be gone
            }
          };
        } catch {
          // Rename failed — another process won the race
          try {
            const { unlink } = await import('node:fs/promises');
            await unlink(tmpFile);
          } catch {
            // ignore
          }
        }
      } catch {
        // File exists — another process holds the lock
      }
      await this.sleepFn(500 + Math.random() * 500);
    }

    throw new Error(
      `Unable to acquire OAuth refresh lock for "${this.config.name}" after ${maxRetries} retries.`,
    );
  }
}

// ─── Default browser opener ───────────────────────────────────────────────

function defaultOpenBrowser(url: string): Promise<void> {
  const cmd =
    process.platform === 'darwin'
      ? `open "${url}"`
      : process.platform === 'win32'
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  return new Promise((resolve) => {
    exec(cmd, (error: Error | null) => {
      // Don't reject — the browser opened or it didn't; either way
      // the user can copy-paste the URL from the terminal.
      void error;
      resolve();
    });
  });
}
