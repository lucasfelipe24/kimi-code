/**
 * `persistentMemory` domain — internal store-mutation capability.
 *
 * Keeps durable-memory writes outside the reflected `IMemoryStore` contract.
 * The opaque capability is module-private and can only be applied through this
 * internal leaf. Scope-agnostic; the store implementation is App-scoped.
 */

import type { MemoryRecord, IMemoryStore } from './memoryStore';

const STORE_MUTATION_CAPABILITY = Object.freeze({});

export const memoryStoreMutation = Symbol('memoryStoreMutation');

export interface MemoryStoreMutation {
  put(scope: string, record: MemoryRecord): Promise<void>;
  delete(scope: string, id: string): Promise<void>;
}

export interface MemoryStoreMutationHost extends IMemoryStore {
  [memoryStoreMutation](
    capability: object,
    operation: 'put' | 'delete',
    scope: string,
    value: MemoryRecord | string,
  ): Promise<void>;
}

export function mutationAccess(store: IMemoryStore): MemoryStoreMutation {
  const host = store as MemoryStoreMutationHost;
  return {
    put: (scope, record) =>
      host[memoryStoreMutation](STORE_MUTATION_CAPABILITY, 'put', scope, record),
    delete: (scope, id) =>
      host[memoryStoreMutation](STORE_MUTATION_CAPABILITY, 'delete', scope, id),
  };
}

export function hasStoreMutationCapability(capability: object): boolean {
  return capability === STORE_MUTATION_CAPABILITY;
}
