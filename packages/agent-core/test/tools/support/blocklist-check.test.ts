import { describe, expect, it, vi } from 'vitest';

import {
  HttpBlocklistChecker,
  type BlocklistChecker,
} from '../../../src/tools/support/blocklist-check';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('HttpBlocklistChecker', () => {
  it('returns allowed when can_fetch is true', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ can_fetch: true }),
    );

    const checker: BlocklistChecker = new HttpBlocklistChecker({
      baseUrl: 'https://blocklist.example.test/api',
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await checker.checkDomain('safe.example.com');
    expect(result).toEqual({ status: 'allowed' });
  });

  it('returns blocked when can_fetch is false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ can_fetch: false }),
    );

    const checker: BlocklistChecker = new HttpBlocklistChecker({
      baseUrl: 'https://blocklist.example.test/api',
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await checker.checkDomain('evil.example.com');
    expect(result).toEqual({ status: 'blocked' });
  });

  it('returns check_failed on network error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Network down'));

    const checker: BlocklistChecker = new HttpBlocklistChecker({
      baseUrl: 'https://blocklist.example.test/api',
      fetchImpl: fetchMock as typeof fetch,
    });

    const result = await checker.checkDomain('unreachable.example.com');
    expect(result.status).toBe('check_failed');
    if (result.status === 'check_failed') {
      expect(result.error.message).toContain('Network down');
    }
  });

  it('caches allowed results and does not re-fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ can_fetch: true }),
    );

    const checker: BlocklistChecker = new HttpBlocklistChecker({
      baseUrl: 'https://blocklist.example.test/api',
      fetchImpl: fetchMock as typeof fetch,
    });

    // First call — should hit the service.
    const first = await checker.checkDomain('cached.example.com');
    expect(first).toEqual({ status: 'allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call — should be served from cache.
    const second = await checker.checkDomain('cached.example.com');
    expect(second).toEqual({ status: 'allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns allowed when no baseUrl configured', async () => {
    const checker: BlocklistChecker = new HttpBlocklistChecker();

    const result = await checker.checkDomain('any.example.com');
    expect(result).toEqual({ status: 'allowed' });
  });
});
