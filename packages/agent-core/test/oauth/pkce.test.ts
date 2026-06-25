import { describe, expect, it } from 'vitest';

import {
  generateCodeChallenge,
  generateCodeVerifier,
  generatePKCEParams,
  generateState,
} from '../../src/oauth/pkce';

describe('pkce', () => {
  describe('generateCodeVerifier', () => {
    it('returns a non-empty string', () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThan(0);
    });

    it('uses only base64url characters', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('has no padding characters', () => {
      const verifier = generateCodeVerifier();
      expect(verifier).not.toContain('=');
    });

    it('returns 43 characters (32 bytes → base64url)', () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBe(43);
    });

    it('produces different values on each call', () => {
      const a = generateCodeVerifier();
      const b = generateCodeVerifier();
      expect(a).not.toBe(b);
    });
  });

  describe('generateCodeChallenge', () => {
    it('returns a valid base64url string', () => {
      const challenge = generateCodeChallenge('test-verifier');
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('has no padding characters', () => {
      const challenge = generateCodeChallenge('test-verifier');
      expect(challenge).not.toContain('=');
    });

    it('is deterministic for the same verifier', () => {
      const verifier = generateCodeVerifier();
      const a = generateCodeChallenge(verifier);
      const b = generateCodeChallenge(verifier);
      expect(a).toBe(b);
    });

    it('produces different values for different verifiers', () => {
      const a = generateCodeChallenge(generateCodeVerifier());
      const b = generateCodeChallenge(generateCodeVerifier());
      expect(a).not.toBe(b);
    });

    it('returns 43 characters (SHA-256 digest)', () => {
      const challenge = generateCodeChallenge('test');
      expect(challenge.length).toBe(43);
    });
  });

  describe('generateState', () => {
    it('returns a valid base64url string', () => {
      const state = generateState();
      expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('produces different values on each call', () => {
      const a = generateState();
      const b = generateState();
      expect(a).not.toBe(b);
    });

    it('returns 43 characters', () => {
      const state = generateState();
      expect(state.length).toBe(43);
    });
  });

  describe('generatePKCEParams', () => {
    it('returns all three parameters', () => {
      const params = generatePKCEParams();
      expect(params.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(params.codeChallenge).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(params.state).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('codeChallenge is the SHA-256 of codeVerifier', () => {
      const params = generatePKCEParams();
      const expected = generateCodeChallenge(params.codeVerifier);
      expect(params.codeChallenge).toBe(expected);
    });

    it('produces different params on each call', () => {
      const a = generatePKCEParams();
      const b = generatePKCEParams();
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
      expect(a.state).not.toBe(b.state);
    });
  });
});
