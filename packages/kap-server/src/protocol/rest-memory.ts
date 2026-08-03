/**
 * `/api/v1` persistent-memory routes — wire schemas.
 *
 *   GET    /workspaces/{workspace_id}/memories
 *   POST   /workspaces/{workspace_id}/memories
 *   PATCH  /workspaces/{workspace_id}/memories/{memory_id}
 *   DELETE /workspaces/{workspace_id}/memories/{memory_id}?scope=
 *
 * The wire record projects the engine `EffectiveMemory` (`MemoryRecord` +
 * `origin`) onto snake_case timestamps, matching the rest of the v1 surface.
 * `scope` is the storage scope the memory lives in (`user` / `workspace` /
 * `project`); `origin` is the same value the catalog resolves for precedence —
 * kept as a distinct field so clients can label where a listed memory came
 * from without re-deriving it.
 */

import { z } from 'zod';

const memoryScopeSchema = z.enum(['user', 'workspace', 'project']);
const memoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference']);

/** ULID, case-insensitive (Crockford base32, 26 chars). Mirrors `MEMORY_ID_REGEX`. */
export const memoryIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/i, {
  message: 'memory_id must be a ULID',
});

export const memoryRecordSchema = z.object({
  id: memoryIdSchema,
  name: z.string(),
  description: z.string(),
  type: memoryTypeSchema,
  scope: memoryScopeSchema,
  origin: memoryScopeSchema,
  created_at: z.string(),
  updated_at: z.string(),
  version: z.number().int(),
  body: z.string(),
});
export type MemoryRecordWire = z.infer<typeof memoryRecordSchema>;

export const listMemoriesResponseSchema = z.object({
  items: z.array(memoryRecordSchema),
});
export type ListMemoriesResponse = z.infer<typeof listMemoriesResponseSchema>;

export const createMemoryRequestSchema = z.object({
  scope: memoryScopeSchema,
  type: memoryTypeSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1),
});
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;

export const updateMemoryRequestSchema = z.object({
  scope: memoryScopeSchema,
  type: memoryTypeSchema.optional(),
  name: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
});
export type UpdateMemoryRequest = z.infer<typeof updateMemoryRequestSchema>;

export const deleteMemoryQuerySchema = z.object({
  scope: memoryScopeSchema,
});
export type DeleteMemoryQuery = z.infer<typeof deleteMemoryQuerySchema>;

export const deleteMemoryResponseSchema = z.object({
  deleted: z.literal(true),
});
export type DeleteMemoryResponse = z.infer<typeof deleteMemoryResponseSchema>;

export const memoryIdParamSchema = z.object({
  workspace_id: z.string().min(1),
  memory_id: memoryIdSchema,
});
export type MemoryIdParam = z.infer<typeof memoryIdParamSchema>;
