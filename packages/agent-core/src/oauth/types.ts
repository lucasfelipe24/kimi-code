/**
 * OAuth Authorization Code + PKCE type definitions.
 *
 * These types live in agent-core (not packages/oauth) because the oauth package
 * is exclusive to managed:kimi-code Device Code flows. This module defines the
 * contracts for a generic Authorization Code + PKCE framework that supports
 * third-party providers like OpenAI.
 */

import type { TokenInfo } from '@moonshot-ai/kimi-code-oauth';

/** PKCE (Proof Key for Code Exchange) parameters — per-login, never persisted. */
export interface PKCEParams {
  /** Base64url-encoded 32-byte random value. */
  codeVerifier: string;
  /** SHA-256(codeVerifier), base64url-encoded. */
  codeChallenge: string;
  /** CSRF protection — random state value. */
  state: string;
}

/** Configuration for an Authorization Code + PKCE OAuth flow. */
export interface AuthCodeFlowConfig {
  /** Logical provider name for token storage (e.g. "openai-oauth"). */
  readonly name: string;
  /** Human-readable provider name (e.g. "OpenAI"). */
  readonly displayName: string;
  /** Authorization endpoint URL. */
  readonly authorizeUrl: string;
  /** Token exchange AND refresh endpoint URL. */
  readonly tokenUrl: string;
  /** OAuth client ID registered with the provider. */
  readonly clientId: string;
  /** Space-separated OAuth scopes passed to the authorize endpoint. */
  readonly scopes: string[];
  /** Additional static query params appended to the authorize URL. */
  readonly extraAuthParams?: Record<string, string>;
  /**
   * Extract an account identifier from the access token (e.g. JWT claim).
   * Called immediately after token exchange so callers can show who logged in.
   */
  readonly extractAccountId?: (accessToken: string) => string;
  /**
   * Fixed redirect port for providers that require a specific port
   * (OpenAI requires 1455). Omit or set to 0 for an OS-assigned ephemeral port.
   */
  readonly redirectPort?: number;
  /**
   * Callback path relative to `http://localhost:{port}`.
   * Defaults to `"/callback"`.
   */
  readonly callbackPath?: string;
}

/** Known OAuth provider definition — registered in the providers registry. */
export interface OAuthProviderDefinition {
  /** Machine-readable id (e.g. "openai"). */
  readonly id: string;
  /** Flow configuration. */
  readonly flowConfig: AuthCodeFlowConfig;
  /** The kosong wire type for this provider's models. */
  readonly wireType: 'openai' | 'openai_responses';
  /** Default model to set after a successful login. */
  readonly defaultModel: string;
  /** Provider name written to config.toml `[providers."..."]`. */
  readonly providerName: string;
  /** Optional base URL override for the API endpoint. */
  readonly baseUrl?: string;
}

/** Result of a successful auth-code login flow. */
export interface AuthCodeLoginResult {
  /** Persisted token info. */
  readonly token: TokenInfo;
  /** Extracted account identifier, if the provider defines an extractor. */
  readonly accountId?: string;
}

/**
 * Minimal BearerTokenProvider interface — mirrors the one in
 * `@moonshot-ai/kimi-code-oauth` and `packages/agent-core/src/session/provider-manager.ts`
 * so AuthCodeOAuthManager can plug into the existing ProviderManager resolution chain.
 */
export interface BearerTokenProvider {
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
}
