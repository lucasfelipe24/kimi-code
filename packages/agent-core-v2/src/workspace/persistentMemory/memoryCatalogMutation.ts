/**
 * `persistentMemory` domain — authorized catalog-mutation access.
 *
 * Binds the Workspace-scoped catalog's internal mutation surface to a main or
 * subagent actor. The opaque capability and symbol-only dispatch keep mutation
 * unavailable to JSON reflection. Trust, feature gates, content checks, and
 * persistence remain owned by the catalog implementation.
 */

import type { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';

import type { IWorkspaceMemoryCatalog } from './memoryCatalog';

const CATALOG_MUTATION_CAPABILITY = Object.freeze({});

export type MemoryMutationActor = 'main' | 'subagent';

export const memoryCatalogMutation = Symbol('memoryCatalogMutation');

export interface MemoryCatalogMutationHost extends IWorkspaceMemoryCatalog {
  [memoryCatalogMutation](capability: object, actor: MemoryMutationActor): ISessionMemoryAccess;
}

export function memoryAccessForActor(
  catalog: IWorkspaceMemoryCatalog,
  actor: MemoryMutationActor,
): ISessionMemoryAccess {
  return (catalog as MemoryCatalogMutationHost)[memoryCatalogMutation](
    CATALOG_MUTATION_CAPABILITY,
    actor,
  );
}

export function hasCatalogMutationCapability(capability: object): boolean {
  return capability === CATALOG_MUTATION_CAPABILITY;
}
