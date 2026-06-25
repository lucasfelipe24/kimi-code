/**
 * PKCE (Proof Key for Code Exchange) S256 primitives.
 *
 * Generates cryptographically-secure random bytes via `node:crypto` and encodes
 * them using unpadded base64url (RFC 7636 Appendix A).
 *
 * ─── Output sizes ───
 *   code_verifier:    32 random bytes → 43 base64url characters
 *   code_challenge:   SHA-256 digest  → 43 base64url characters
 *   state:            32 random bytes → 43 base64url characters
 */

import { createHash, randomBytes } from 'node:crypto';

import type { PKCEParams } from './types';

/**
 * Encode a Buffer as unpadded base64url.
 *
 * base64url = base64 with `+`→`-`, `/`→`_`, and trailing `=` stripped.
 */
function base64URLEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Generate a cryptographically-random code verifier (32 bytes → 43 chars). */
export function generateCodeVerifier(): string {
  return base64URLEncode(randomBytes(32));
}

/** SHA-256 hash of the code verifier, base64url-encoded. */
export function generateCodeChallenge(verifier: string): string {
  const hash = createHash('sha256');
  hash.update(verifier);
  return base64URLEncode(hash.digest());
}

/** Generate a random state value for CSRF protection. */
export function generateState(): string {
  return base64URLEncode(randomBytes(32));
}

/** Generate all PKCE parameters at once. */
export function generatePKCEParams(): PKCEParams {
  const codeVerifier = generateCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: generateCodeChallenge(codeVerifier),
    state: generateState(),
  };
}
