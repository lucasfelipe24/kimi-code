/**
 * `brave-search` domain — `BraveAnswersTool` implementation.
 *
 * Executes Brave chat completions in JSON or streaming SSE mode, incrementally
 * separating normal answer text from citation, entity, and usage tags while
 * reporting safe progress through the Agent tool context. Bound at Agent scope
 * by the feature unit.
 */

import type { ToolExecution, ToolUpdate } from '#/tool/toolContract';

import {
  BraveAnswersInputSchema,
  type BraveAnswersInput,
  type IBraveAnswersTool,
} from './contracts';
import { BraveToolBase, isRecord } from './shared';
import DESCRIPTION from './brave-answers.md?raw';

interface AnswerStreamResult {
  readonly content: string;
  readonly citations: readonly unknown[];
  readonly entities: readonly unknown[];
  readonly usage: readonly unknown[];
}

type MetadataKind = 'citations' | 'entities' | 'usage';

const TAGS = [
  { open: '<citation>', close: '</citation>', kind: 'citations' },
  { open: '<enum_item>', close: '</enum_item>', kind: 'entities' },
  { open: '<usage>', close: '</usage>', kind: 'usage' },
] as const;

export class BraveAnswersTool
  extends BraveToolBase<{ q: string }>
  implements IBraveAnswersTool
{
  readonly name = 'BraveAnswers' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters = this.parametersFor(BraveAnswersInputSchema);

  resolveExecution(args: BraveAnswersInput): ToolExecution {
    const query =
      [...args.messages].reverse().find((message) => message.role === 'user')?.content ??
      'Brave answer';
    return this.executionFor(args, query, {
      name: this.name,
      schema: BraveAnswersExecutionSchema,
      execute: async (input, client, ctx) => {
        const { q: _query, ...body } = input;
        const response = await client.request('/chat/completions', {
          method: 'POST',
          body: { ...body, model: 'brave', stream: body.stream },
          signal: ctx.signal,
        });
        if (!body.stream) return readJsonResponse(response);
        return readAnswerStream(response, ctx.onUpdate);
      },
    });
  }
}

const BraveAnswersExecutionSchema = BraveAnswersInputSchema.transform((value) => ({
  ...value,
  q: [...value.messages].reverse().find((message) => message.role === 'user')?.content ?? 'Brave answer',
}));

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error('Brave Answers returned invalid JSON.');
  }
}

async function readAnswerStream(
  response: Response,
  onUpdate: ((update: ToolUpdate) => void) | undefined,
): Promise<AnswerStreamResult> {
  if (response.body === null) throw new Error('Brave Answers returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = new TaggedContentParser(onUpdate);
  let lines = '';
  let done = false;

  try {
    while (!done) {
      const read = await reader.read();
      if (read.done) {
        lines += decoder.decode();
        break;
      }
      lines += decoder.decode(read.value, { stream: true });
      let newline = lines.indexOf('\n');
      while (newline >= 0) {
        const line = lines.slice(0, newline).replace(/\r$/u, '');
        lines = lines.slice(newline + 1);
        done = processSseLine(line, parser);
        if (done) break;
        newline = lines.indexOf('\n');
      }
    }
    if (!done && lines.length > 0) processSseLine(lines.replace(/\r$/u, ''), parser);
    return parser.finish();
  } finally {
    reader.releaseLock();
  }
}

function processSseLine(line: string, parser: TaggedContentParser): boolean {
  if (!line.startsWith('data:')) return false;
  const data = line.slice(5).trimStart();
  if (data === '[DONE]') return true;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return false;
  }
  for (const choice of arrayField(payload, 'choices')) {
    const delta = recordField(choice, 'delta');
    const content = stringField(delta, 'content');
    if (content !== undefined) parser.push(content);
  }
  return false;
}

class TaggedContentParser {
  private pending = '';
  private text = '';
  private readonly metadata: Record<MetadataKind, unknown[]> = {
    citations: [],
    entities: [],
    usage: [],
  };

  constructor(private readonly onUpdate: ((update: ToolUpdate) => void) | undefined) {}

  push(content: string): void {
    this.pending += content;
    this.drain(false);
  }

  finish(): AnswerStreamResult {
    this.drain(true);
    return {
      content: this.text,
      citations: this.metadata.citations,
      entities: this.metadata.entities,
      usage: this.metadata.usage,
    };
  }

  private drain(flush: boolean): void {
    while (this.pending.length > 0) {
      const match = earliestTag(this.pending);
      if (match === undefined) {
        const retained = flush ? 0 : partialOpeningTagLength(this.pending);
        this.emitText(this.pending.slice(0, this.pending.length - retained));
        this.pending = this.pending.slice(this.pending.length - retained);
        return;
      }
      if (match.index > 0) {
        this.emitText(this.pending.slice(0, match.index));
        this.pending = this.pending.slice(match.index);
      }
      const closeIndex = this.pending.indexOf(match.tag.close, match.tag.open.length);
      if (closeIndex < 0) {
        if (flush) {
          this.emitText(this.pending);
          this.pending = '';
        }
        return;
      }
      const encoded = this.pending.slice(match.tag.open.length, closeIndex);
      const value = parseTaggedValue(encoded);
      this.metadata[match.tag.kind].push(value);
      this.onUpdate?.({
        kind: 'custom',
        customKind: 'brave-answers-metadata',
        customData: { kind: match.tag.kind, value },
      });
      this.pending = this.pending.slice(closeIndex + match.tag.close.length);
    }
  }

  private emitText(text: string): void {
    if (text.length === 0) return;
    this.text += text;
    this.onUpdate?.({ kind: 'progress', text });
  }
}

function earliestTag(input: string):
  | { readonly index: number; readonly tag: (typeof TAGS)[number] }
  | undefined {
  let found: { readonly index: number; readonly tag: (typeof TAGS)[number] } | undefined;
  for (const tag of TAGS) {
    const index = input.indexOf(tag.open);
    if (index >= 0 && (found === undefined || index < found.index)) found = { index, tag };
  }
  return found;
}

function partialOpeningTagLength(input: string): number {
  let length = 0;
  for (const tag of TAGS) {
    const max = Math.min(input.length, tag.open.length - 1);
    for (let size = max; size > length; size--) {
      if (input.endsWith(tag.open.slice(0, size))) {
        length = size;
        break;
      }
    }
  }
  return length;
}

function parseTaggedValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function arrayField(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}
