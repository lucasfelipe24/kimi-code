/**
 * `persistentMemory` domain — `IMemoryStore` contract and record schema.
 *
 * Defines the durable memory record (`MemoryRecord`), its validation schemas
 * (ULID id, type, scope), the per-scope write caps, the co-located
 * `MemoryError`, and the `IMemoryStore` access-pattern token. A memory is one
 * JSON document per record, addressed by `(scope, <id>.json)`. Pure contract —
 * the implementation lives in `memoryStoreService`. Bound at App scope.
 */

import { z } from 'zod';

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Error2, type Error2Options } from '#/_base/errors/errors';

import { type MemoryErrorCode } from './errors';

/** ULID, case-insensitive (Crockford base32, 26 chars). Molde: `CRON_ID_REGEX`. */
export const MEMORY_ID_REGEX: RegExp = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export const MemoryIdSchema = z.string().regex(MEMORY_ID_REGEX);
export const MemoryTypeSchema = z.enum(['user', 'feedback', 'project', 'reference']);
export const MemoryScopeSchema = z.enum(['user', 'workspace', 'project']);

export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;

/**
 * Storage-scope allowlist: `user` (global), or `workspace/<wid>` /
 * `project/<wid>` where `<wid>` is an `encodeWorkDirKey` token
 * (`wd_<slug>_<hash>`). This is the traversal contention for the `scope`
 * segment — the byte layer joins `(scope, key)` without sanitizing.
 */
export const MEMORY_STORE_SCOPE_REGEX: RegExp =
  /^(?:user|(?:workspace|project)\/wd_[a-z0-9._-]+_[0-9a-f]{12})$/;

/** Max length for a memory `name`. */
export const MEMORY_MAX_NAME_LENGTH = 200;
/** Max length for a memory `description`. */
export const MEMORY_MAX_DESCRIPTION_LENGTH = 2000;

/** Default byte cap for a single memory `body` (UTF-8 bytes). */
export const DEFAULT_MEMORY_MAX_BODY_BYTES = 4096;
/** Default ceiling on the number of memories persisted per scope. */
export const DEFAULT_MEMORY_MAX_PER_SCOPE = 200;
/** Maximum number of valid records returned by one `list`. */
export const MEMORY_LIST_CAP = 200;
/** Bounded physical documents inspected while filling one valid-record page. */
export const MEMORY_SCAN_CAP = 1_000;

export interface MemoryRecord {
  /** ULID; validated by {@link MemoryIdSchema} before touching the store. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly type: MemoryType;
  readonly scope: MemoryScope;
  /** epoch ms */
  readonly createdAt: number;
  readonly updatedAt: number;
  /** monotonic; used for optimistic update (rejects on divergence). */
  readonly version: number;
  /** content; byte cap validated on write. */
  readonly body: string;
}

export const MemoryRecordSchema: z.ZodType<MemoryRecord> = z.object({
  id: MemoryIdSchema,
  name: z.string().min(1).max(MEMORY_MAX_NAME_LENGTH),
  description: z.string().max(MEMORY_MAX_DESCRIPTION_LENGTH),
  type: MemoryTypeSchema,
  scope: MemoryScopeSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.number(),
  body: z.string(),
});

export class MemoryError extends Error2 {
  constructor(code: MemoryErrorCode, message: string, options?: Error2Options) {
    super(code, message, { ...options, name: 'MemoryError' });
  }
}

/** Write caps enforced by the store on every `put`. */
export interface MemoryStoreCaps {
  readonly maxBodyBytes: number;
  readonly maxPerScope: number;
}

export const DEFAULT_MEMORY_STORE_CAPS: MemoryStoreCaps = {
  maxBodyBytes: DEFAULT_MEMORY_MAX_BODY_BYTES,
  maxPerScope: DEFAULT_MEMORY_MAX_PER_SCOPE,
};

export interface IMemoryStore {
  readonly _serviceBrand: undefined;

  get(scope: string, id: string): Promise<MemoryRecord | undefined>;
  list(scope: string): Promise<readonly MemoryRecord[]>;
}

export const IMemoryStore: ServiceIdentifier<IMemoryStore> =
  createDecorator<IMemoryStore>('memoryStore');
