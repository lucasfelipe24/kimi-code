/**
 * Covers: LocalFetchURLProvider content-kind reporting.
 *
 * Verifies the provider tells callers whether the returned content is a
 * verbatim passthrough of the response body or the main text extracted
 * from an HTML page.
 */

import { describe, expect, it, vi } from 'vitest';

import { LocalFetchURLProvider } from '../../../src/tools/providers/local-fetch-url';

function htmlResponse(body: string, contentType: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': contentType },
  });
}

describe('LocalFetchURLProvider content kind', () => {
  it('reports text/plain bodies as a verbatim passthrough', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('plain body', 'text/plain; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/file.txt');

    expect(result).toEqual({ content: 'plain body', kind: 'passthrough' });
  });

  it('reports text/markdown bodies as a verbatim passthrough', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse('# Title\n\nbody', 'text/markdown'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/readme.md');

    expect(result).toEqual({ content: '# Title\n\nbody', kind: 'passthrough' });
  });

  it('reports HTML bodies as extracted main content', async () => {
    const html =
      '<html><head><title>Doc</title></head><body><article>' +
      '<p>The quick brown fox jumps over the lazy dog. '.repeat(20) +
      '</p></article></body></html>';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(htmlResponse(html, 'text/html; charset=utf-8'));
    const provider = new LocalFetchURLProvider({ fetchImpl });

    const result = await provider.fetch('https://example.com/page');

    expect(result.kind).toBe('extracted');
    expect(result.content).toContain('quick brown fox');
  });
});

describe('LocalFetchURLProvider redirects and binary', () => {
  it('follows same-origin redirects', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 301,
        headers: { location: 'https://example.com/target' },
      }))
      .mockResolvedValueOnce(new Response('final content', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));
    const provider = new LocalFetchURLProvider({ fetchImpl });
    const result = await provider.fetch('https://example.com/start');
    expect(result.content).toBe('final content');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('follows www to non-www redirect', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 301,
        headers: { location: 'https://example.com/page' },
      }))
      .mockResolvedValueOnce(new Response('content after redirect', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));
    const provider = new LocalFetchURLProvider({ fetchImpl });
    const result = await provider.fetch('https://www.example.com/page');
    expect(result.content).toBe('content after redirect');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns redirect message on cross-origin redirect', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, {
        status: 301,
        headers: { location: 'https://other.example.test/page' },
      }));
    const provider = new LocalFetchURLProvider({ fetchImpl });
    const result = await provider.fetch('https://example.com/start');
    expect(result.content).toContain('Redirected to different origin');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('detects PDF as binary content', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array(100), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }));
    const provider = new LocalFetchURLProvider({ fetchImpl });
    const result = await provider.fetch('https://example.com/doc.pdf');
    expect(result.content).toContain('Binary content');
    expect(result.content).toContain('Saved to');
  });

  it('uses KimiCode-User agent string', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }));
    const provider = new LocalFetchURLProvider({ fetchImpl });
    await provider.fetch('https://example.com/page');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/page',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ 'User-Agent': expect.stringContaining('KimiCode-User') }),
        redirect: 'manual',
      }),
    );
  });
});
