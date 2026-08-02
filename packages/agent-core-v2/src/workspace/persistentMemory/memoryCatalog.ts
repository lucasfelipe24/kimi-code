/**
 * `persistentMemory` domain — `IWorkspaceMemoryCatalog` contract.
 *
 * Defines the Workspace-scope effective view over durable memory: the
 * per-origin projection (`user` < `workspace` < `project`) with a trust gate
 * on project-origin records, plus create / update / forget mutations and a
 * change event. Ids are per-scope, so a project memory never shadows a user
 * memory. Pure contract — the implementation lives in `memoryCatalogService`.
 * Workspace-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';

import type {
  MemoryRecord,
  MemoryScope,
  MemoryType,
} from '#/app/persistentMemory/memoryStore';

export type MemoryOrigin = MemoryScope;

export interface EffectiveMemory extends MemoryRecord {
  readonly origin: MemoryOrigin;
}

export interface MemoryCreateInput {
  readonly scope: MemoryScope;
  readonly type: MemoryType;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface MemoryPatch {
  readonly name?: string;
  readonly description?: string;
  readonly body?: string;
  readonly type?: MemoryType;
}

export interface IWorkspaceMemoryCatalog {
  readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  list(): Promise<readonly EffectiveMemory[]>;
  readonly onDidChange: Event<void>;
}

export const IWorkspaceMemoryCatalog: ServiceIdentifier<IWorkspaceMemoryCatalog> =
  createDecorator<IWorkspaceMemoryCatalog>('workspaceMemoryCatalog');
