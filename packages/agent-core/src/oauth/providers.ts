/**
 * Known OAuth provider definitions.
 *
 * Each entry describes an OAuth 2.0 Authorization Code + PKCE provider that
 * kimi-code can authenticate with. To add a new provider, add an entry to
 * `OAUTH_PROVIDERS` with the required flow configuration.
 */

import type { OAuthProviderDefinition } from './types';

function resolveOpenAIClientId(): string {
  return (
    process.env['KIMI_CODE_OPENAI_OAUTH_CLIENT_ID'] ??
    'app_EMoamEEZ73f0CkXaXp7hrann'
  );
}

/**
 * Extract the ChatGPT account ID from an OpenAI access token (JWT).
 *
 * The token payload contains a namespaced claim:
 *   `"https://api.openai.com/auth": { "chatgpt_account_id": "..." }`
 */
function extractOpenAIAccountId(accessToken: string): string {
  const parts = accessToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT: expected 3 parts');
  }
  const payload = JSON.parse(
    Buffer.from(parts[1]!, 'base64url').toString('utf-8'),
  ) as Record<string, unknown>;
  const auth = payload['https://api.openai.com/auth'];
  if (auth === undefined || auth === null || typeof auth !== 'object') {
    throw new Error('Missing https://api.openai.com/auth claim in JWT');
  }
  const accountId = (auth as Record<string, unknown>)['chatgpt_account_id'];
  if (typeof accountId !== 'string' || accountId.length === 0) {
    throw new Error('Missing chatgpt_account_id in JWT auth claim');
  }
  return accountId;
}

/**
 * Registry of known third-party OAuth providers.
 *
 * The `id` field is the stable machine-readable identifier users pass to
 * `kimi provider oauth-login <id>`. The `providerName` is the key written
 * to `config.toml` under `[providers."..."]`.
 */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderDefinition> = {
  openai: {
    id: 'openai',
    flowConfig: {
      name: 'openai-oauth',
      displayName: 'OpenAI',
      authorizeUrl: 'https://auth.openai.com/oauth/authorize',
      tokenUrl: 'https://auth.openai.com/oauth/token',
      clientId: resolveOpenAIClientId(),
      scopes: ['openid', 'profile', 'email', 'offline_access'],
      extraAuthParams: {
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        originator: 'kimi-code',
      },
      extractAccountId: extractOpenAIAccountId,
      redirectPort: 1455,
      callbackPath: '/auth/callback',
    },
    wireType: 'openai_responses',
    defaultModel: 'gpt-5.4',
    providerName: 'openai-oauth',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
  },
};
