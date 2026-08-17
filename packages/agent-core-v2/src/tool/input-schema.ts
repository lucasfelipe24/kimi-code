import { z } from 'zod';

export function toInputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  });
  closeObjectNodes(jsonSchema);
  ensureObjectRootType(jsonSchema);
  return jsonSchema;
}

/**
 * Providers require the tool `input_schema` root to carry `type: "object"`.
 * A discriminated/union input (e.g. the `Memory` tool) renders as a bare
 * top-level `oneOf`/`anyOf` of object branches with no root `type`, which the
 * provider rejects (`input_schema.type: Field required`). When the root has no
 * `type` but every combinator branch is an object, stamp `type: "object"` so
 * the union is advertised as an object schema. Only the root needs this — the
 * branches already carry their own `type`.
 */
function ensureObjectRootType(schema: Record<string, unknown>): void {
  if (typeof schema['type'] === 'string') return;
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const branches = schema[key];
    if (
      Array.isArray(branches) &&
      branches.length > 0 &&
      branches.every(
        (branch) =>
          typeof branch === 'object' &&
          branch !== null &&
          (branch as Record<string, unknown>)['type'] === 'object',
      )
    ) {
      schema['type'] = 'object';
      return;
    }
  }
}

function closeObjectNodes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) closeObjectNodes(item);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const node = value as Record<string, unknown>;
  if (node['type'] === 'object' && node['additionalProperties'] === undefined) {
    node['additionalProperties'] = false;
  }
  for (const child of Object.values(node)) {
    closeObjectNodes(child);
  }
}
