/**
 * Serialize a persistent memory to an editable markdown document and parse it
 * back. Mirrors the fresh-start memdir shape: a small YAML-ish frontmatter with
 * the scalar fields (`scope`, `type`, `name`, `description`) followed by a blank
 * line and the free-form body.
 *
 * The parser is deliberately tiny and tolerant — it only understands the four
 * known keys, ignores YAML comments (`# …`) and unknown lines, and never pulls
 * in an `agent-core` dependency (the app must not import the engine directly;
 * see `apps/kimi-code/AGENTS.md`).
 */

import type {
  CreateMemoryInput,
  MemoryScope,
  MemorySummary,
  MemoryType,
} from '@moonshot-ai/kimi-code-sdk';

const SCOPES: readonly MemoryScope[] = ['user', 'workspace', 'project'];
const TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

const FRONTMATTER_FENCE = '---';

/** The scalar fields plus the body, as edited in the external editor. */
export interface MemoryDocFields {
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export type MemoryDocParse =
  | { readonly ok: true; readonly value: MemoryDocFields }
  | { readonly ok: false; readonly error: string };

/** Seed document for creating a new memory: prefilled frontmatter + guidance. */
export function newMemoryTemplate(): string {
  return [
    FRONTMATTER_FENCE,
    '# Fill in the fields below, then save and close the editor.',
    '# scope: user | workspace | project',
    '# type:  user | feedback | project | reference',
    'scope: workspace',
    'type: reference',
    'name: ',
    'description: ',
    FRONTMATTER_FENCE,
    '',
    '',
  ].join('\n');
}

/** Render an existing memory as an editable document (frontmatter + body). */
export function serializeMemoryDoc(fields: MemoryDocFields): string {
  return [
    FRONTMATTER_FENCE,
    `scope: ${fields.scope}`,
    `type: ${fields.type}`,
    `name: ${escapeScalar(fields.name)}`,
    `description: ${escapeScalar(fields.description)}`,
    FRONTMATTER_FENCE,
    '',
    fields.body,
  ].join('\n');
}

/** Render an existing memory summary for editing. */
export function memoryToDoc(memory: MemorySummary): string {
  return serializeMemoryDoc({
    scope: memory.scope,
    type: memory.type,
    name: memory.name,
    description: memory.description,
    body: memory.body,
  });
}

/**
 * Parse the edited document. Tolerant of comments, blank lines, and unknown
 * frontmatter keys; strict about the enum values and required fields.
 */
export function parseMemoryDoc(text: string): MemoryDocParse {
  const normalized = text.replaceAll('\r\n', '\n');
  const { frontmatter, body } = splitFrontmatter(normalized);
  if (frontmatter === undefined) {
    return { ok: false, error: 'Missing frontmatter. Keep the `---` fenced header intact.' };
  }

  const fields = new Map<string, string>();
  for (const raw of frontmatter.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'scope' || key === 'type' || key === 'name' || key === 'description') {
      fields.set(key, unquoteScalar(value));
    }
  }

  const scope = fields.get('scope') ?? '';
  const type = fields.get('type') ?? '';
  const name = (fields.get('name') ?? '').trim();
  const description = (fields.get('description') ?? '').trim();
  const trimmedBody = body.trim();

  if (!isScope(scope)) {
    return { ok: false, error: `Invalid scope "${scope}". Use one of: ${SCOPES.join(', ')}.` };
  }
  if (!isType(type)) {
    return { ok: false, error: `Invalid type "${type}". Use one of: ${TYPES.join(', ')}.` };
  }
  if (name.length === 0) {
    return { ok: false, error: 'A memory needs a `name`.' };
  }
  if (description.length === 0) {
    return { ok: false, error: 'A memory needs a one-line `description`.' };
  }
  if (trimmedBody.length === 0) {
    return { ok: false, error: 'The memory body is empty.' };
  }

  return { ok: true, value: { scope, type, name, description, body: trimmedBody } };
}

/** Fields → the SDK create input (a straight subset). */
export function toCreateInput(fields: MemoryDocFields): CreateMemoryInput {
  return {
    scope: fields.scope,
    type: fields.type,
    name: fields.name,
    description: fields.description,
    body: fields.body,
  };
}

function splitFrontmatter(text: string): { frontmatter: string | undefined; body: string } {
  const lines = text.split('\n');
  // Skip leading blank lines before the opening fence.
  let start = 0;
  while (start < lines.length && lines[start]!.trim().length === 0) start++;
  if (lines[start]?.trim() !== FRONTMATTER_FENCE) {
    return { frontmatter: undefined, body: text };
  }
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === FRONTMATTER_FENCE) {
      return {
        frontmatter: lines.slice(start + 1, i).join('\n'),
        body: lines.slice(i + 1).join('\n'),
      };
    }
  }
  return { frontmatter: undefined, body: text };
}

function escapeScalar(value: string): string {
  // Frontmatter scalars are single-line; collapse newlines defensively.
  return value.replaceAll(/\r?\n/g, ' ');
}

function unquoteScalar(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function isScope(value: string): value is MemoryScope {
  return (SCOPES as readonly string[]).includes(value);
}

function isType(value: string): value is MemoryType {
  return (TYPES as readonly string[]).includes(value);
}
