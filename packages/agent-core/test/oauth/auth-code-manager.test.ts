import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { TokenInfo, TokenStorage } from '@moonshot-ai/kimi-code-oauth';

import { AuthCodeOAuthManager } from '../../src/oauth/auth-code-manager';
import type { AuthCodeFlowConfig } from '../../src/oauth/types';

// ─── Helpers ──────────────────────────────────────────────────────────────

function createConfig(overrides: Partial<AuthCodeFlowConfig> = {}): AuthCodeFlowConfig {
  return {
    name: 'test-oauth',
    displayName: 'Test Provider',
    authorizeUrl: 'https://auth.example.com/oauth/authorize',
    tokenUrl: 'https://auth.example.com/oauth/token',
    clientId: 'test-client-id',
    scopes: ['openid', 'profile'],
    ...overrides,
  };
}

function createMockStorage(initial?: TokenInfo): TokenStorage & { _saved: TokenInfo[] } {
  const saved: TokenInfo[] = initial ? [initial] : [];
  return {
    _saved: saved,
    async load(_name: string): Promise<TokenInfo | undefined> {
      return saved.length > 0 ? saved[saved.length - 1] : undefined;
    },
    async save(_name: string, token: TokenInfo): Promise<void> {
      saved.push(token);
    },
    async remove(_name: string): Promise<void> {
      saved.length = 0;
    },
    async list(): Promise<string[]> {
      return saved.length > 0 ? ['test-oauth'] : [];
    },
  };
}

function createToken(overrides: Partial<TokenInfo> = {}): TokenInfo {
  return {
    accessToken: 'access-token-123',
    refreshToken: 'refresh-token-456',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    scope: 'openid profile',
    tokenType: 'Bearer',
    expiresIn: 3600,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('AuthCodeOAuthManager', () => {
  describe('hasToken', () => {
    it('returns false when no token is stored', async () => {
      const storage = createMockStorage();
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      expect(await manager.hasToken()).toBe(false);
    });

    it('returns true when a token is stored', async () => {
      const storage = createMockStorage(createToken());
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      expect(await manager.hasToken()).toBe(true);
    });

    it('returns false for revoked tombstone', async () => {
      const storage = createMockStorage({
        accessToken: '',
        refreshToken: 'some-refresh',
        expiresAt: 0,
        scope: '',
        tokenType: '',
        expiresIn: 0,
      });
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      expect(await manager.hasToken()).toBe(false);
    });
  });

  describe('getCachedAccessToken', () => {
    it('returns access token when stored', async () => {
      const storage = createMockStorage(createToken({ accessToken: 'my-token' }));
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      expect(await manager.getCachedAccessToken()).toBe('my-token');
    });

    it('returns undefined when no token', async () => {
      const storage = createMockStorage();
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      expect(await manager.getCachedAccessToken()).toBeUndefined();
    });
  });

  describe('logout', () => {
    it('removes stored token', async () => {
      const storage = createMockStorage(createToken());
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      await manager.logout();
      expect(await manager.hasToken()).toBe(false);
    });

    it('is idempotent', async () => {
      const storage = createMockStorage();
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      await expect(manager.logout()).resolves.toBeUndefined();
      await expect(manager.logout()).resolves.toBeUndefined();
    });
  });

  describe('ensureFresh', () => {
    it('returns access token when not expired', async () => {
      const storage = createMockStorage(createToken());
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
        now: () => Math.floor(Date.now() / 1000),
      });

      const token = await manager.ensureFresh();
      expect(token).toBe('access-token-123');
    });

    it('throws when no token is stored', async () => {
      const storage = createMockStorage();
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      await expect(manager.ensureFresh()).rejects.toThrow('No OAuth token');
    });

    it('refreshes when token is near expiry', async () => {
      const now = Math.floor(Date.now() / 1000);
      const storage = createMockStorage(
        createToken({
          expiresAt: now + 60, // only 1 minute left
          expiresIn: 3600,
        }),
      );

      // Mock fetch to return refreshed token
      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        json: async () => ({
          access_token: 'refreshed-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      });

      try {
        const manager = new AuthCodeOAuthManager({
          config: createConfig(),
          storage,
          now: () => now,
          sleep: () => Promise.resolve(),
        });

        const token = await manager.ensureFresh();
        expect(token).toBe('refreshed-token');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('throws when refresh returns 401', async () => {
      const now = Math.floor(Date.now() / 1000);
      const storage = createMockStorage(
        createToken({
          expiresAt: now + 60,
          expiresIn: 3600,
        }),
      );

      const origFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 401,
        json: async () => ({ error: 'invalid_grant' }),
      });

      try {
        const manager = new AuthCodeOAuthManager({
          config: createConfig(),
          storage,
          now: () => now,
          sleep: () => Promise.resolve(),
        });

        await expect(manager.ensureFresh()).rejects.toThrow('unauthorized');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });

  describe('tokenProvider', () => {
    it('returns a BearerTokenProvider that delegates to ensureFresh', async () => {
      const storage = createMockStorage(createToken());
      const manager = new AuthCodeOAuthManager({
        config: createConfig(),
        storage,
      });

      const provider = manager.tokenProvider();
      const token = await provider.getAccessToken();
      expect(token).toBe('access-token-123');
    });
  });

  describe('login', () => {
    it('completes the full flow with mocked browser and server', async () => {
      // This test verifies the login flow orchestration.
      // We mock the browser open, the token exchange, and the server callback.

      const origFetch = globalThis.fetch;

      globalThis.fetch = vi.fn().mockImplementation(
        async (_url: string | URL | Request, _init?: RequestInit) => {
          const url = typeof _url === 'string' ? _url : _url instanceof URL ? _url.toString() : _url.url;

          // Only intercept auth.example.com token exchange requests;
          // pass through localhost callbacks to the real fetch.
          if (url.includes('auth.example.com/oauth/token')) {
            const body = typeof _init?.body === 'string' ? _init.body : '';
            if (body.includes('grant_type=authorization_code')) {
              return {
                status: 200,
                json: async () => ({
                  access_token: 'new-access-token',
                  refresh_token: 'new-refresh-token',
                  expires_in: 3600,
                  token_type: 'Bearer',
                  scope: 'openid profile',
                }),
              };
            }
          }

          // Pass through to real fetch (localhost callback, etc.)
          return origFetch(_url, _init);
        },
      );

      try {
        const storage = createMockStorage();
        let browserUrl = '';
        const manager = new AuthCodeOAuthManager({
          config: createConfig({
            redirectPort: 0, // ephemeral
            extractAccountId: (token: string) => `account-for-${token.slice(0, 8)}`,
          }),
          storage,
          openBrowser: async (url: string) => {
            browserUrl = url;
            // Simulate: browser opens, user authorizes, callback hits our server.
            // Extract the redirect_uri and state from the authorize URL
            const urlObj = new URL(url);
            const redirectUri = urlObj.searchParams.get('redirect_uri');
            const state = urlObj.searchParams.get('state');

            // Make the callback request
            if (redirectUri) {
              const callbackUrl = new URL(redirectUri);
              callbackUrl.searchParams.set('code', 'auth-code-from-browser');
              if (state) callbackUrl.searchParams.set('state', state);

              // Small delay to let the server start listening
              await new Promise((r) => setTimeout(r, 100));
              await fetch(callbackUrl.toString());
            }
          },
          sleep: () => Promise.resolve(),
        });

        const result = await manager.login();

        expect(result.token.accessToken).toBe('new-access-token');
        expect(result.token.refreshToken).toBe('new-refresh-token');
        expect(result.accountId).toBe('account-for-new-acce');
        expect(await manager.hasToken()).toBe(true);
        expect(browserUrl).toContain('code_challenge=');
        expect(browserUrl).toContain('code_challenge_method=S256');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
