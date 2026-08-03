/**
 * `tool` domain — tool-parameter JSON Schema rendering.
 *
 * Shared helper for deriving the JSON Schema that a tool advertises to the
 * model for its parameters.
 *
 * A tool's parameter schema describes the *input* the model is expected to
 * supply. zod v4's `toJSONSchema` defaults to the *output* view, which marks
 * any field carrying a chain-tail `.default()` as `required` — producing a
 * schema that simultaneously declares a `default` and lists the field as
 * required. That contradiction also makes the runtime AJV validator reject
 * legal calls that omit the defaulted fields.
 *
 * Always render parameter schemas through this helper so the `io: 'input'`
 * view is applied uniformly and defaulted fields remain optional, while the
 * closed-object guard (`additionalProperties: false`) is kept so unknown
 * arguments are still rejected.
 */

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
