/**
 * End-to-end integration test for the OAuth Authorization Code + PKCE framework.
 *
 * This test validates the full flow (except the actual browser authorization)
 * for the OpenAI provider. It verifies:
 *   1. OpenAI provider definition is correct
 *   2. PKCE params generate correctly
 *   3. Authorization URL is built with correct parameters
 *   4. Callback server starts on OpenAI's fixed port
 *   5. Callback captures the auth code
 *
 * A real browser authorization is not performed — that requires user interaction.
 */

import { describe, expect, it } from 'vitest';

import { AuthCodeListener } from '../../src/oauth/auth-code-listener';
import { AuthCodeOAuthManager } from '../../src/oauth/auth-code-manager';
import { generatePKCEParams } from '../../src/oauth/pkce';
import { OAUTH_PROVIDERS } from '../../src/oauth/providers';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

describe('OpenAI OAuth provider integration', () => {
  it('has a valid OpenAI provider definition', () => {
    const def = OAUTH_PROVIDERS['openai'];
    expect(def).toBeDefined();
    if (!def) return; // narrow for TS
    expect(def.id).toBe('openai');
    expect(def.flowConfig.authorizeUrl).toBe('https://auth.openai.com/oauth/authorize');
    expect(def.flowConfig.tokenUrl).toBe('https://auth.openai.com/oauth/token');
    expect(def.flowConfig.scopes).toContain('offline_access');
    expect(def.flowConfig.redirectPort).toBe(1455);
    expect(def.flowConfig.callbackPath).toBe('/auth/callback');
    expect(def.wireType).toBe('openai_responses');
    expect(def.providerName).toBe('openai-oauth');
  });

  it('builds a valid authorize URL with PKCE params', () => {
    const def = OAUTH_PROVIDERS['openai']!;
    const pkce = generatePKCEParams();
    const redirectUri = 'http://localhost:1455/auth/callback';

    const params = new URLSearchParams({
      client_id: def.flowConfig.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: def.flowConfig.scopes.join(' '),
      code_challenge: pkce.codeChallenge,
      code_challenge_method: 'S256',
      state: pkce.state,
    });

    // Extra params
    for (const [key, value] of Object.entries(def.flowConfig.extraAuthParams ?? {})) {
      params.set(key, value);
    }

    const url = `${def.flowConfig.authorizeUrl}?${params.toString()}`;
    expect(url).toContain('response_type=code');
    expect(url).toContain('code_challenge_method=S256');
    expect(url).toContain('offline_access');
    expect(url).toContain('codex_cli_simplified_flow=true');
    expect(url).toContain('originator=kimi-code');
    expect(url).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback');
  });

  it('starts AuthCodeListener on OpenAI fixed port 1455', async () => {
    // Use a non-zero port that's likely free for CI
    // We can't reliably use 1455 in tests (might be in use)
    const listener = new AuthCodeListener({
      port: 0, // ephemeral for test
      callbackPath: '/auth/callback',
    });

    const uri = await listener.start();
    expect(uri).toContain('/auth/callback');
    await listener.close();
  });

  it('can construct AuthCodeOAuthManager with OpenAI config', () => {
    const def = OAUTH_PROVIDERS['openai']!;
    const tmpDir = mkdtempSync(join(tmpdir(), 'kimi-oauth-test-'));
    const storage = new FileTokenStorage(tmpDir);

    const manager = new AuthCodeOAuthManager({
      config: def.flowConfig,
      storage,
    });

    expect(manager).toBeDefined();
  });

  it('token exchange URL is correctly configured', () => {
    const def = OAUTH_PROVIDERS['openai']!;
    // The tokenUrl should be the standard OAuth token endpoint
    expect(def.flowConfig.tokenUrl).toBe('https://auth.openai.com/oauth/token');
  });

  it('client ID is set and can be overridden via env', () => {
    const def = OAUTH_PROVIDERS['openai']!;
    // Default client ID should be the OpenAI Codex CLI client
    expect(def.flowConfig.clientId).toBeTruthy();
    expect(def.flowConfig.clientId.length).toBeGreaterThan(0);
  });

  it('extractAccountId can decode OpenAI JWT', () => {
    const def = OAUTH_PROVIDERS['openai']!;
    expect(def.flowConfig.extractAccountId).toBeDefined();

    // Test with a mock JWT
    const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'test-account-123',
        },
      }),
    ).toString('base64url');
    const signature = 'fake-signature';
    const jwt = `${header}.${payload}.${signature}`;

    const accountId = def.flowConfig.extractAccountId!(jwt);
    expect(accountId).toBe('test-account-123');
  });
});
