/**
 * `tools` domain — `IMemoryTool` contract.
 *
 * Public contract of the Memory tool: the discriminated input schema the model
 * calls with (`remember` / `forget` / `list`) and the Agent-scope identifier
 * used to resolve the implementation through the container. The tool is the
 * only typed surface the model uses to mutate durable cross-session memory —
 * not a free-form Write — so scope, type, byte caps, and the ULID id are all
 * validated at the boundary. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import {
  DEFAULT_MEMORY_MAX_BODY_BYTES,
  MEMORY_MAX_DESCRIPTION_LENGTH,
  MEMORY_MAX_NAME_LENGTH,
  MemoryIdSchema,
  MemoryScopeSchema,
  MemoryTypeSchema,
} from '#/app/persistentMemory/memoryStore';
import { type AgentTool } from '#/tool/toolContract';

export const MEMORY_TOOL_NAME = 'Memory';

export const MemoryToolInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('remember'),
    scope: MemoryScopeSchema.describe('Memory scope: user (global), workspace, or project.'),
    type: MemoryTypeSchema.describe('Memory taxonomy type.'),
    name: z
      .string()
      .min(1)
      .max(MEMORY_MAX_NAME_LENGTH)
      .describe('Short, human-readable label for the memory.'),
    description: z
      .string()
      .min(1)
      .max(MEMORY_MAX_DESCRIPTION_LENGTH)
      .describe('One-line summary of when this memory is relevant.'),
    // NOTE (char vs byte cap): zod's `.max()` counts UTF-16 code units, while
    // the store's real cap (`DEFAULT_MEMORY_MAX_BODY_BYTES`) is measured in
    // UTF-8 bytes. This ceiling is therefore only an approximate early guard
    // that keeps obviously oversized inputs out of the tool; the authoritative
    // byte boundary is enforced by `IMemoryStore.put`, which rejects an
    // over-cap body gracefully with `MEMORY_BODY_TOO_LARGE`.
    body: z
      .string()
      .min(1)
      .max(DEFAULT_MEMORY_MAX_BODY_BYTES)
      .describe('The durable content to remember.'),
  }),
  z.object({
    action: z.literal('forget'),
    scope: MemoryScopeSchema.describe('Scope the memory lives in; required to authorize the forget.'),
    id: MemoryIdSchema.describe('ULID of the memory to forget.'),
  }),
  z.object({
    action: z.literal('list'),
    scope: MemoryScopeSchema.optional().describe('Optional scope filter for the listing.'),
  }),
]);

export type MemoryToolInput = z.infer<typeof MemoryToolInputSchema>;

export interface IMemoryTool extends AgentTool<MemoryToolInput> {
  readonly _serviceBrand: undefined;
}

export const IMemoryTool = createDecorator<IMemoryTool>('memoryTool');
