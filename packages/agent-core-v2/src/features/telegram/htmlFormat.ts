export const TELEGRAM_MESSAGE_LIMIT = 4096;

const ALLOWED_TAGS = new Set([
  'b',
  'i',
  'u',
  's',
  'code',
  'pre',
  'a',
  'blockquote',
  'tg-spoiler',
]);

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

function tag(name: string, escaped: string): string {
  return `<${name}>${escaped}</${name}>`;
}

export function bold(raw: string): string {
  return tag('b', escapeHtml(raw));
}

export function code(raw: string): string {
  return tag('code', escapeHtml(raw));
}

export function pre(raw: string): string {
  return tag('pre', escapeHtml(raw));
}

const PLACEHOLDER_PREFIX = '\u0000ph';
const PLACEHOLDER_SUFFIX = '\u0000';

function isSafeUrl(url: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(url);
}

export function markdownToTelegramHtml(markdown: string): string {
  const placeholders: string[] = [];
  const stash = (html: string): string => {
    const token = `${PLACEHOLDER_PREFIX}${placeholders.length}${PLACEHOLDER_SUFFIX}`;
    placeholders.push(html);
    return token;
  };

  let text = markdown;

  text = text.replaceAll(/```[^\n]*\n?([\s\S]*?)```/g, (_m, body: string) => stash(pre(body)));
  text = text.replaceAll(/`([^`\n]+)`/g, (_m, body: string) => stash(code(body)));
  text = text.replaceAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, label: string, url: string) => {
    if (!isSafeUrl(url)) return whole;
    return stash(`<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`);
  });

  text = escapeHtml(text);

  const lines = text.split('\n');
  const out: string[] = [];
  let quoteBuffer: string[] | null = null;
  const flushQuote = (): void => {
    if (quoteBuffer) {
      out.push(tag('blockquote', quoteBuffer.join('\n')));
      quoteBuffer = null;
    }
  };
  for (const line of lines) {
    const quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      quoteBuffer ??= [];
      quoteBuffer.push(quote[1] ?? '');
      continue;
    }
    flushQuote();
    const header = /^(#{1,6})\s+(.*)$/.exec(line);
    out.push(header ? tag('b', header[2] ?? '') : line);
  }
  flushQuote();
  text = out.join('\n');

  text = text.replaceAll(/\*\*([^*\n]+)\*\*/g, (_m, body: string) => tag('b', body));
  text = text.replaceAll(/\*([^*\n]+)\*/g, (_m, body: string) => tag('i', body));
  text = text.replaceAll(/~~([^~\n]+)~~/g, (_m, body: string) => tag('s', body));

  text = text.replaceAll(
    new RegExp(`${PLACEHOLDER_PREFIX}(\\d+)${PLACEHOLDER_SUFFIX}`, 'g'),
    (_m, i: string) => placeholders[Number(i)] ?? '',
  );

  return text;
}

interface Token {
  readonly value: string;
  open?: string;
  openTag?: string;
  close?: string;
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < html.length) {
    const ch = html[i]!;
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end !== -1) {
        const raw = html.slice(i, end + 1);
        const close = /^<\/([a-z-]+)>$/i.exec(raw);
        const openMatch = /^<([a-z-]+)(?:\s[^>]*)?>$/i.exec(raw);
        const token: Token = { value: raw };
        if (close && ALLOWED_TAGS.has(close[1]!.toLowerCase())) token.close = close[1]!.toLowerCase();
        else if (openMatch && ALLOWED_TAGS.has(openMatch[1]!.toLowerCase())) {
          token.open = openMatch[1]!.toLowerCase();
          token.openTag = raw;
        }
        tokens.push(token);
        i = end + 1;
        continue;
      }
    }
    if (ch === '&') {
      const end = html.indexOf(';', i);
      if (end !== -1 && end - i <= 10) {
        tokens.push({ value: html.slice(i, end + 1) });
        i = end + 1;
        continue;
      }
    }
    tokens.push({ value: ch });
    i++;
  }
  return tokens;
}

export function truncateTelegramHtml(message: string, max = TELEGRAM_MESSAGE_LIMIT, marker = '… [truncated]'): string {
  if (message.length <= max) return message;
  const effectiveMarker = marker.length <= max ? marker : '';
  const tokens = tokenize(message);
  const stack: string[] = [];
  let out = '';

  const closersFor = (s: string[]): string =>
    s
      .map((t) => `</${t}>`)
      .toReversed()
      .join('');

  for (const token of tokens) {
    const nextStack = [...stack];
    if (token.open) nextStack.push(token.open);
    else if (token.close) {
      const idx = nextStack.lastIndexOf(token.close);
      if (idx !== -1) nextStack.splice(idx, 1);
    }
    const projected = out.length + token.value.length + closersFor(nextStack).length + effectiveMarker.length;
    if (projected > max) break;
    out += token.value;
    if (token.open) stack.push(token.open);
    else if (token.close) {
      const idx = stack.lastIndexOf(token.close);
      if (idx !== -1) stack.splice(idx, 1);
    }
  }

  return out + closersFor(stack) + effectiveMarker;
}

export function finalizeTelegramHtml(message?: string): string | undefined {
  if (message === undefined) return undefined;
  return truncateTelegramHtml(message);
}

export function renumberableOptionText(label: string): string {
  return label.replace(/^\s*\d+[.)]\s+/, '');
}

export function buttonLabel(label: string, index: number): string {
  return `${String(index + 1)}. ${renumberableOptionText(label)}`;
}

export function numberedOptionList(labels: readonly string[]): string {
  return labels
    .map((label, i) => `${String(i + 1)}. ${escapeHtml(renumberableOptionText(label))}`)
    .join('\n');
}

export interface InlineButton {
  readonly text: string;
  readonly callbackData: string;
}

const COMPACT_BUTTONS_PER_ROW = 5;

export function buildCompactChoiceGrid(
  labels: readonly string[],
  callbackForIndex: (index: number) => string,
): InlineButton[][] {
  const rows: InlineButton[][] = [];
  let run: InlineButton[] = [];
  for (let i = 0; i < labels.length; i++) {
    run.push({ text: String(i + 1), callbackData: callbackForIndex(i) });
    if (run.length === COMPACT_BUTTONS_PER_ROW) {
      rows.push(run);
      run = [];
    }
  }
  if (run.length > 0) rows.push(run);
  return rows;
}
