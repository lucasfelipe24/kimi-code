import { describe, expect, it } from 'vitest';

import { AuthCodeListener } from '../../src/oauth/auth-code-listener';

describe('AuthCodeListener', () => {
  describe('start / close', () => {
    it('starts on an ephemeral port and returns a redirect_uri', async () => {
      const listener = new AuthCodeListener();
      const uri = await listener.start();
      expect(uri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
      await listener.close();
    });

    it('uses a custom callback path', async () => {
      const listener = new AuthCodeListener({ callbackPath: '/auth/callback' });
      const uri = await listener.start();
      expect(uri).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/);
      await listener.close();
    });

    it('returns the same uri from getRedirectUri after start', async () => {
      const listener = new AuthCodeListener();
      const uri = await listener.start();
      expect(listener.getRedirectUri()).toBe(uri);
      await listener.close();
    });

    it('can be closed without starting', async () => {
      const listener = new AuthCodeListener();
      await expect(listener.close()).resolves.toBeUndefined();
    });

    it('can start on a fixed port when available', async () => {
      // Use port 0 first to find an available port, then use that port
      const probe = new AuthCodeListener();
      const probeUri = await probe.start();
      const port = Number(new URL(probeUri).port);
      await probe.close();

      // Now try to reuse that port
      const listener = new AuthCodeListener({ port });
      const uri = await listener.start();
      expect(uri).toBe(`http://localhost:${port}/callback`);
      await listener.close();
    });
  });

  describe('waitForAuthCode', () => {
    it('captures a code from a callback request', async () => {
      const listener = new AuthCodeListener();
      const uri = await listener.start();

      // Simulate a callback by making an HTTP request
      const codePromise = listener.waitForAuthCode({ timeoutMs: 5000 });

      const callbackUrl = new URL(uri);
      callbackUrl.searchParams.set('code', 'test-auth-code-123');
      callbackUrl.searchParams.set('state', 'any');

      const response = await fetch(callbackUrl.toString());

      expect(response.status).toBe(200);

      const code = await codePromise;
      expect(code).toBe('test-auth-code-123');

      await listener.close();
    });

    it('validates state when configured', async () => {
      const listener = new AuthCodeListener({ state: 'expected-state' });
      const uri = await listener.start();

      // Wrong state should fail
      const codePromise = listener.waitForAuthCode({ timeoutMs: 5000 });

      const callbackUrl = new URL(uri);
      callbackUrl.searchParams.set('code', 'test-code');
      callbackUrl.searchParams.set('state', 'wrong-state');

      await fetch(callbackUrl.toString());

      await expect(codePromise).rejects.toThrow('state mismatch');
      await listener.close();
    });

    it('accepts correct state when configured', async () => {
      const listener = new AuthCodeListener({ state: 'correct-state' });
      const uri = await listener.start();

      const codePromise = listener.waitForAuthCode({ timeoutMs: 5000 });

      const callbackUrl = new URL(uri);
      callbackUrl.searchParams.set('code', 'test-code');
      callbackUrl.searchParams.set('state', 'correct-state');

      await fetch(callbackUrl.toString());

      const code = await codePromise;
      expect(code).toBe('test-code');

      await listener.close();
    });

    it('times out after the specified duration', async () => {
      const listener = new AuthCodeListener();
      await listener.start();

      await expect(
        listener.waitForAuthCode({ timeoutMs: 200 }),
      ).rejects.toThrow('timed out');

      await listener.close();
    });

    it('rejects with error when callback has error param', async () => {
      const listener = new AuthCodeListener();
      const uri = await listener.start();

      const codePromise = listener.waitForAuthCode({ timeoutMs: 5000 });

      // Programmatic URL construction to avoid encoding issues
      const callbackUrl = new URL(uri);
      callbackUrl.searchParams.set('error', 'access_denied');
      callbackUrl.searchParams.set('error_description', 'User denied');

      await fetch(callbackUrl.toString());

      await expect(codePromise).rejects.toThrow('Authorization failed');

      await listener.close();
    });

    it('returns 404 for non-callback paths', async () => {
      const listener = new AuthCodeListener();
      const uri = await listener.start();
      const port = Number(new URL(uri).port);

      const response = await fetch(`http://localhost:${port}/other-path`);
      expect(response.status).toBe(404);

      await listener.close();
    });
  });
});
