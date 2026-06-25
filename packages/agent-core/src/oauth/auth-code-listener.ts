/**
 * Local HTTP server that captures OAuth redirect callbacks.
 *
 * Binds to `http://localhost:{port}` and listens for GET requests at
 * `{callbackPath}?code=X&state=Y`. Validates the `state` parameter and
 * resolves the returned Promise with the authorization code.
 *
 * After capturing a code (or timing out), the server is closed.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface AuthCodeListenerOptions {
  /**
   * Port to bind to. 0 for an OS-assigned ephemeral port (default).
   * Some providers (e.g. OpenAI) require a fixed port registered with
   * their OAuth application.
   */
  readonly port?: number;
  /**
   * Callback path relative to `http://localhost:{port}`.
   * Defaults to `"/callback"`.
   */
  readonly callbackPath?: string;
  /**
   * Expected state value for CSRF validation. When provided, the listener
   * verifies that the `state` query parameter in the callback matches.
   */
  readonly state?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class AuthCodeListener {
  private readonly port: number;
  private readonly callbackPath: string;
  private readonly state: string | undefined;
  private server: Server | undefined;
  private actualPort: number | undefined;
  /** Resolved result: either { code } or { error }. */
  private result: { code: string } | { error: Error } | undefined;
  private settled = false;

  constructor(options: AuthCodeListenerOptions = {}) {
    this.port = options.port ?? 0;
    this.callbackPath = options.callbackPath ?? '/callback';
    this.state = options.state;
  }

  /**
   * Start the server and return the `redirect_uri` that the OAuth provider
   * should redirect to after authorization.
   */
  start(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && this.port !== 0) {
          reject(
            new Error(
              `Port ${this.port} is already in use. Close the application using it or choose a different port.`,
            ),
          );
        } else {
          reject(error);
        }
      });

      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr === null || typeof addr === 'string') {
          reject(new Error('Server address is not available'));
          return;
        }
        this.actualPort = addr.port;
        resolve(this.getRedirectUri());
      });
    });
  }

  /**
   * Wait for the authorization code to arrive via the callback.
   * Rejects after `timeoutMs` (default 5 minutes) or when the `signal` is aborted.
   */
  async waitForAuthCode(options?: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;

    // Check if we already have a result
    if (this.result !== undefined) {
      return this.resolveResult();
    }

    // Poll until we have a result, timeout, or abort
    while (!this.settled) {
      if (this.result !== undefined) {
        return this.resolveResult();
      }
      if (options?.signal?.aborted) {
        this.settled = true;
        throw new Error('OAuth authorization was cancelled.');
      }
      if (Date.now() >= deadline) {
        this.settled = true;
        throw new Error('OAuth authorization timed out. Please try again.');
      }
      // Poll every 200ms
      await new Promise((r) => setTimeout(r, 200));
    }

    throw new Error('OAuth authorization ended unexpectedly.');
  }

  private resolveResult(): string {
    const result = this.result;
    this.result = undefined;
    this.settled = true;
    if ('error' in result!) {
      throw result.error;
    }
    return (result as { code: string }).code;
  }

  /** Stop the server immediately. */
  async close(): Promise<void> {
    this.settled = true;
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => resolve());
      });
    }
  }

  /** The actual redirect_uri the provider should use. */
  getRedirectUri(): string {
    // If we haven't started yet, return what it will be
    const port = this.actualPort ?? this.port;
    return `http://localhost:${port}${this.callbackPath}`;
  }

  /** Handle an incoming HTTP request. */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${this.actualPort}`);
      if (url.pathname !== this.callbackPath) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');

      if (code === null || code.length === 0) {
        const error = url.searchParams.get('error');
        const errorDescription = url.searchParams.get('error_description');
        this.respondHtml(
          res,
          false,
          'Authorization failed',
          errorDescription ?? error ?? 'No authorization code received.',
        );
        this.result = {
          error: new Error(
            `Authorization failed: ${errorDescription ?? error ?? 'No authorization code received.'}`,
          ),
        };
        return;
      }

      // Validate state if one was configured
      if (this.state !== undefined && state !== this.state) {
        this.respondHtml(res, false, 'Invalid state', 'CSRF validation failed. Please try again.');
        this.result = {
          error: new Error('OAuth state mismatch — possible CSRF attack.'),
        };
        return;
      }

      // Success
      this.respondHtml(
        res,
        true,
        'Authorization successful',
        'You may close this window and return to the terminal.',
      );
      this.result = { code };
    } catch {
      // Ignore errors from writing HTTP responses (client may have disconnected)
    }
  }

  private respondHtml(
    res: ServerResponse,
    success: boolean,
    title: string,
    message: string,
  ): void {
    const color = success ? '#22c55e' : '#ef4444';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #0a0a0a; color: #e5e5e5;
    }
    .card {
      text-align: center; padding: 2rem; max-width: 400px;
    }
    .status {
      font-size: 3rem; margin-bottom: 1rem; color: ${color};
    }
    h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
    p { color: #737373; font-size: 0.875rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status">${success ? '&#10003;' : '&#10007;'}</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
  </div>
</body>
</html>`;
    res.writeHead(success ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
