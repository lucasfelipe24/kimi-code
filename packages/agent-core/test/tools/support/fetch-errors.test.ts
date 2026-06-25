import { describe, expect, it } from 'vitest';

import {
  CrossOriginRedirectError,
  DomainBlockedError,
  DomainCheckFailedError,
  EgressBlockedError,
} from '../../../src/tools/support/fetch-errors';

describe('DomainBlockedError', () => {
  it('has domain property and correct message', () => {
    const err = new DomainBlockedError('evil.example.com');
    expect(err.domain).toBe('evil.example.com');
    expect(err.message).toContain('evil.example.com');
    expect(err.message).toContain('restricted');
  });
});

describe('DomainCheckFailedError', () => {
  it('has domain property', () => {
    const err = new DomainCheckFailedError('unreachable.example.com');
    expect(err.domain).toBe('unreachable.example.com');
    expect(err.message).toContain('unreachable.example.com');
  });
});

describe('EgressBlockedError', () => {
  it('message is JSON with error_type', () => {
    const err = new EgressBlockedError('blocked.example.com');
    expect(err.domain).toBe('blocked.example.com');

    const parsed = JSON.parse(err.message);
    expect(parsed.error_type).toBe('EGRESS_BLOCKED');
    expect(parsed.domain).toBe('blocked.example.com');
  });
});

describe('CrossOriginRedirectError', () => {
  it('has originalUrl, redirectUrl, statusCode', () => {
    const err = new CrossOriginRedirectError(
      'https://a.example.com',
      'https://b.example.com',
      302,
    );
    expect(err.originalUrl).toBe('https://a.example.com');
    expect(err.redirectUrl).toBe('https://b.example.com');
    expect(err.statusCode).toBe(302);
  });
});

describe('all errors', () => {
  it('are instanceof Error', () => {
    expect(new DomainBlockedError('x.example.com')).toBeInstanceOf(Error);
    expect(new DomainCheckFailedError('x.example.com')).toBeInstanceOf(Error);
    expect(new EgressBlockedError('x.example.com')).toBeInstanceOf(Error);
    expect(
      new CrossOriginRedirectError('a', 'b', 301),
    ).toBeInstanceOf(Error);
  });
});
