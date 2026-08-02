/**
 * `persistentMemory` domain — seeded session memory-access data contract.
 *
 * Defines `ISessionMemoryAccess`, the pure-data injection contract over the
 * workspace's effective memory catalog: list / create / update / forget plus a
 * change event, with no IO of its own — trust gating, precedence and
 * persistence all live on the Workspace-scope `IWorkspaceMemoryCatalog` this
 * seed projects. Seeded into the Session scope when the session is
 * materialized, so Agent-scope consumers (the `Memory` tool, later recall)
 * resolve memory access without reaching across into the Workspace scope.
 * Session-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { Event } from '#/_base/event';
import type { MemoryScope } from '#/app/persistentMemory/memoryStore';
import type {
  EffectiveMemory,
  MemoryCreateInput,
  MemoryPatch,
} from '#/workspace/persistentMemory/memoryCatalog';

export interface ISessionMemoryAccess {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  list(): Promise<readonly EffectiveMemory[]>;
  create(input: MemoryCreateInput): Promise<EffectiveMemory>;
  // `update`/`forget` are SCOPE-AWARE: the caller declares which scope the id
  // lives in, and the catalog mutates only that scope's store. This closes the
  // inherited bug where an id was located by reverse-precedence scan and a
  // same-id collision across scopes could be mutated/deleted in the wrong scope.
  update(scope: MemoryScope, id: string, patch: MemoryPatch): Promise<EffectiveMemory>;
  forget(scope: MemoryScope, id: string): Promise<void>;

  readonly onDidChange: Event<void>;
}

export const ISessionMemoryAccess: ServiceIdentifier<ISessionMemoryAccess> =
  createDecorator<ISessionMemoryAccess>('sessionMemoryAccess');

export function sessionMemoryAccessSeed(access: ISessionMemoryAccess): ScopeSeed {
  return [[ISessionMemoryAccess as ServiceIdentifier<unknown>, access]];
}
