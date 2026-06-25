/**
 * LocalFetchURLProvider — host-side URL fetcher.
 *
 * Flow:
 *   1. GET the URL with a Chrome-like UA.
 *   2. Reject HTTP >= 400 with the status code in the message.
 *   3. Reject responses larger than `maxBytes` (content-length first,
 *      then measured body length as a defensive second check).
 *   4. `text/plain` / `text/markdown` → passthrough verbatim.
 *   5. Otherwise (assumed HTML) → run Readability over a linkedom
 *      document. Return `# ${title}\n\n${text}` (title omitted when
 *      absent). If extraction yields no meaningful text, fall back to
 *      common content containers (`<article>` / `<main>` / `<body>`)
 *      before throwing a "meaningful content" error.
 */

import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Readability } from '@mozilla/readability';
import { parseHTML as rawParseHTML } from 'linkedom';

import { HttpFetchError, type UrlFetcher, type UrlFetchResult } from '../builtin';
import { CrossOriginRedirectError } from '../support/fetch-errors';

// Readability's .d.ts references the global `Document` type, but this
// package compiles with `lib: ES2023` (no DOM). Extracting the
// constructor parameter type keeps us off the global `Document` name
// while still accepting whatever Readability wants.
type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];

// linkedom's published types depend on DOM libs we don't load. Declare
// the minimal surface we actually use so the rest of the file stays
// type-safe without pulling lib.dom.d.ts into the host build.
interface DomElementLike {
  textContent: string | null;
  querySelector(selector: string): DomElementLike | null;
}
interface DomParseResult {
  document: DomElementLike;
}
const parseHTML = rawParseHTML as unknown as (html: string) => DomParseResult;

const DEFAULT_USER_AGENT =
  'KimiCode-User/1.0 (+https://kimi.com/support) ' +
  'Mozilla/5.0 (compatible; Windows NT 10.0; Win64; x64)';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export interface LocalFetchURLProviderOptions {
  userAgent?: string;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
  /**
   * Allow fetching loopback / RFC 1918 / link-local / ULA addresses.
   * Defaults to `false` — enabled only for tests and (future) explicit
   * opt-in. Keeps an LLM that's been prompt-injected from exfiltrating
   * AWS/GCP metadata (169.254.169.254), probing internal services
   * (10.x, 192.168.x), or reading local daemons (127.0.0.1:*).
   */
  allowPrivateAddresses?: boolean;
}

/**
 * SSRF guard — reject non-http(s) schemes and (by default) any hostname
 * that is, or parses as, a private / loopback / link-local / ULA IP
 * literal. This is a *static* check against the URL string; it does NOT
 * do DNS resolution, so a domain that resolves to a private IP via
 * DNS-rebinding is **not** caught here. That attack is a known
 * limitation; mitigations (e.g. pinning the resolved IP through to
 * fetch) are left for a follow-up.
 */
function assertSafeFetchTarget(url: string, allowPrivate: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}" — only http(s) allowed.`);
  }
  if (allowPrivate) return;
  // URL hostname preserves surrounding `[ ]` for IPv6 literals on some
  // Node versions (and not others). Strip them for uniform comparison.
  const hostRaw = parsed.hostname.toLowerCase();
  const host = hostRaw.startsWith('[') && hostRaw.endsWith(']') ? hostRaw.slice(1, -1) : hostRaw;
  // Literal "localhost" / loopback aliases.
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  // IPv6 loopback / ULA / link-local. Check after bracket strip.
  if (
    host === '::1' ||
    host === '::' ||
    host.startsWith('fe80:') ||
    host.startsWith('fc') ||
    host.startsWith('fd')
  ) {
    throw new Error(`Refusing to fetch private host: "${host}"`);
  }
  // IPv4 literal — only check when the hostname is a dotted-quad; normal
  // domains will never match.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4 !== null) {
    const octets = [v4[1], v4[2], v4[3], v4[4]].map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      throw new Error(`Invalid IPv4 literal: "${host}"`);
    }
    const [a, b] = octets as [number, number, number, number];
    // 127.0.0.0/8 loopback, 10.0.0.0/8, 192.168.0.0/16,
    // 172.16.0.0/12, 169.254.0.0/16 link-local / AWS metadata,
    // 0.0.0.0/8 "this network", 100.64.0.0/10 CGNAT.
    const isLoopback = a === 127;
    const isPrivate10 = a === 10;
    const isPrivate192 = a === 192 && b === 168;
    const isPrivate172 = a === 172 && b >= 16 && b <= 31;
    const isLinkLocal = a === 169 && b === 254;
    const isZero = a === 0;
    const isCgnat = a === 100 && b >= 64 && b <= 127;
    if (
      isLoopback ||
      isPrivate10 ||
      isPrivate192 ||
      isPrivate172 ||
      isLinkLocal ||
      isZero ||
      isCgnat
    ) {
      throw new Error(`Refusing to fetch private address: "${host}"`);
    }
  }
}

const BINARY_TYPES = [
  'application/pdf',
  'application/octet-stream',
  'application/zip',
  'application/gzip',
  'application/x-tar',
];

function isBinaryContentType(ct: string): boolean {
  const base = ct.split(';')[0]!.trim().toLowerCase();
  return (
    BINARY_TYPES.includes(base) ||
    base.startsWith('image/') ||
    base.startsWith('audio/') ||
    base.startsWith('video/')
  );
}

function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  try {
    const orig = new URL(originalUrl);
    const redir = new URL(redirectUrl);
    if (redir.protocol !== orig.protocol) return false;
    if (redir.port !== orig.port) return false;
    const stripWww = (h: string) => h.replace(/^www\./, '');
    return stripWww(orig.hostname) === stripWww(redir.hostname);
  } catch {
    return false;
  }
}

function mimeToExtension(mimeType: string): string {
  const base = mimeType.split(';')[0]!.trim().toLowerCase();
  const MIME_MAP: Record<string, string> = {
    'application/pdf': '.pdf',
    'application/octet-stream': '.bin',
    'application/zip': '.zip',
    'application/gzip': '.gz',
    'application/x-tar': '.tar',
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff',
    'image/x-icon': '.ico',
    'image/svg+xml': '.svg',
    'audio/mpeg': '.mp3',
    'audio/wav': '.wav',
    'audio/ogg': '.oga',
    'audio/flac': '.flac',
    'audio/aac': '.aac',
    'audio/mp4': '.m4a',
    'video/mp4': '.mp4',
    'video/mpeg': '.mpeg',
    'video/x-matroska': '.mkv',
    'video/x-msvideo': '.avi',
    'video/quicktime': '.mov',
    'video/ogg': '.ogv',
    'video/x-ms-wmv': '.wmv',
    'video/webm': '.webm',
  };
  return MIME_MAP[base] ?? '';
}

export class LocalFetchURLProvider implements UrlFetcher {
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxBytes: number;
  private readonly allowPrivateAddresses: boolean;

  constructor(options: LocalFetchURLProviderOptions = {}) {
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
  }

  async fetch(url: string, _options?: { toolCallId?: string }): Promise<UrlFetchResult> {
    assertSafeFetchTarget(url, this.allowPrivateAddresses);

    let response: Response;
    try {
      response = await this.fetchWithRedirects(url, 0);
    } catch (error) {
      if (error instanceof CrossOriginRedirectError) {
        return {
          content: `Redirected to different origin: ${error.redirectUrl}. Unable to follow cross-origin redirects.`,
          kind: 'passthrough',
        };
      }
      throw error;
    }

    if (response.status >= 400) {
      // Drain the unused body so undici can release the socket back to
      // the keep-alive pool instead of leaking it on error paths.
      await response.body?.cancel().catch(() => {
        /* already closed */
      });
      throw new HttpFetchError(
        response.status,
        `HTTP ${String(response.status)} ${response.statusText}`,
      );
    }

    // Reject oversized responses before buffering the full body.
    const contentLengthRaw = response.headers.get('content-length');
    if (contentLengthRaw !== null) {
      const cl = Number(contentLengthRaw);
      if (Number.isFinite(cl) && cl > this.maxBytes) {
        throw new Error(
          `Response body too large: ${String(cl)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        );
      }
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    // Detect and handle binary content before reading as text.
    if (isBinaryContentType(contentType)) {
      const arrayBuf = await response.arrayBuffer();
      const actualBytes = arrayBuf.byteLength;
      if (actualBytes > this.maxBytes) {
        throw new Error(
          `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
        );
      }
      const ext = mimeToExtension(contentType);
      const hex = randomBytes(4).toString('hex');
      const tmpFile = join(tmpdir(), `kimi-fetch-${hex}${ext}`);
      await writeFile(tmpFile, new Uint8Array(arrayBuf));
      const sizeStr =
        actualBytes < 1024
          ? `${String(actualBytes)} B`
          : actualBytes < 1024 * 1024
            ? `${(actualBytes / 1024).toFixed(1)} KB`
            : `${(actualBytes / (1024 * 1024)).toFixed(1)} MB`;
      return {
        content: `Binary content detected (${contentType.split(';')[0]?.trim() ?? contentType}, ${sizeStr}). Saved to: ${tmpFile}`,
        kind: 'passthrough',
      };
    }

    const body = await response.text();

    // Servers may omit content-length — measure again defensively.
    const actualBytes = Buffer.byteLength(body, 'utf8');
    if (actualBytes > this.maxBytes) {
      throw new Error(
        `Response body too large: ${String(actualBytes)} bytes exceeds maxBytes (${String(this.maxBytes)}).`,
      );
    }

    if (contentType.startsWith('text/plain') || contentType.startsWith('text/markdown')) {
      return { content: body, kind: 'passthrough' };
    }

    return { content: this.extractMainContent(body), kind: 'extracted' };
  }

  private async fetchWithRedirects(url: string, depth: number): Promise<Response> {
    if (depth > 10) {
      throw new Error(`Too many redirects while fetching: ${url}`);
    }

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': this.userAgent },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location !== null) {
        const redirectUrl = new URL(location, url).href;
        if (!isPermittedRedirect(url, redirectUrl)) {
          throw new CrossOriginRedirectError(url, redirectUrl, response.status);
        }
        // Drain the redirect response body before following.
        await response.body?.cancel().catch(() => {
          /* already closed */
        });
        return this.fetchWithRedirects(redirectUrl, depth + 1);
      }
    }

    return response;
  }

  private extractMainContent(html: string): string {
    // Readability mutates the DOM it parses, so parse twice — once for
    // the primary extractor and once for the fallback path.
    const primary = parseHTML(html);
    try {
      const reader = new Readability(primary.document as unknown as ReadabilityDocument, {
        charThreshold: 0,
      });
      const article = reader.parse();
      if (article !== null) {
        const text = (article.textContent ?? '').trim();
        if (text.length > 0) {
          const title = (article.title ?? '').trim();
          return title.length > 0 ? `# ${title}\n\n${text}` : text;
        }
      }
    } catch {
      // Fall through to the container-based fallback.
    }

    const { document } = parseHTML(html);
    const titleText = (document.querySelector('title')?.textContent ?? '').trim();
    const container =
      document.querySelector('article') ??
      document.querySelector('main') ??
      document.querySelector('body');
    const fallbackText = (container?.textContent ?? '').trim();

    if (fallbackText.length === 0) {
      throw new Error(
        'Failed to extract meaningful content from the page. The page may require JavaScript to render.',
      );
    }

    return titleText.length > 0 ? `# ${titleText}\n\n${fallbackText}` : fallbackText;
  }
}
