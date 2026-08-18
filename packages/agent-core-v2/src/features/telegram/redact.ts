import { createHash, randomBytes } from 'node:crypto';

export const TELEGRAM_BOT_TOKEN_PATTERN = /\d{5,20}:[A-Za-z0-9_-]{20,}/g;

export function maskToken(token: string | undefined): string {
  if (token === undefined || token.length === 0) return '(unset)';
  if (token.length <= 4) return `…(len ${String(token.length)})`;
  return `${token.slice(0, 4)}…(len ${String(token.length)})`;
}

export function tokenFingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12);
}

export function sanitizeDiagnostic(detail: string, token?: string): string {
  let redacted = detail;
  if (token !== undefined && token.length > 0) {
    redacted = redacted.split(token).join(`[token:${maskToken(token)}]`);
  }
  return redacted.replace(TELEGRAM_BOT_TOKEN_PATTERN, (match) => `[token:${maskToken(match)}]`);
}

export function randomCorrelationId(): string {
  return randomBytes(8).toString('hex');
}
