/**
 * `persistentMemory` domain — workspace memory catalog and mutation boundary.
 *
 * Projects the App-scoped memory store into user, workspace, and trusted-project
 * records for one workspace. Public DI reflection sees only the read catalog.
 * Authorized actor-bound closures enter the symbol-only mutation boundary,
 * which enforces capability, actor scope, trust, redaction, and residual-secret
 * rejection before persistence. Bound at Workspace scope.
 */

import { ulid } from 'ulid';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { MemoryErrors } from '#/app/persistentMemory/errors';
import {
  IMemoryStore,
  MemoryError,
  type MemoryRecord,
  type MemoryScope,
} from '#/app/persistentMemory/memoryStore';
import { mutationAccess, type MemoryStoreMutation } from '#/app/persistentMemory/memoryStoreMutation';
import { looksLikeSecret, redactMemoryBody } from '#/app/persistentMemory/redact';
import type { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';

import {
  IWorkspaceMemoryCatalog,
  type EffectiveMemory,
  type MemoryCreateInput,
  type MemoryPatch,
} from './memoryCatalog';
import {
  hasCatalogMutationCapability,
  memoryCatalogMutation,
  type MemoryCatalogMutationHost,
  type MemoryMutationActor,
} from './memoryCatalogMutation';

const PRECEDENCE: readonly MemoryScope[] = ['user', 'workspace', 'project'];

const ORIGIN_PRIORITY: Record<MemoryScope, number> = {
  user: 3,
  workspace: 2,
  project: 1,
};

export class WorkspaceMemoryCatalogService
  extends Disposable
  implements MemoryCatalogMutationHost
{
  declare readonly _serviceBrand: undefined;

  readonly ready: Promise<void>;

  private readonly workspaceId: string;
  private readonly mutations: MemoryStoreMutation;
  private readonly changeEmitter = this._register(new Emitter<void>());
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    @IWorkspaceContext workspace: IWorkspaceContext,
    @IMemoryStore private readonly store: IMemoryStore,
    @IWorkspaceTrust private readonly trust: IWorkspaceTrust,
  ) {
    super();
    this.workspaceId = workspace.workspaceId;
    this.mutations = mutationAccess(store);
    this._register(this.trust.onDidChange(() =>{  this.changeEmitter.fire(); }));
    this.ready = this.trust.ready;
  }

  async list(): Promise<readonly EffectiveMemory[]> {
    const byId = new Map<string, EffectiveMemory>();
    for (const origin of this.visibleOrigins()) {
      const records = await this.store.list(this.storeScope(origin));
      for (const record of records) {
        const incoming = this.toEffective(record, origin);
        const existing = byId.get(record.id);
        if (
          existing === undefined ||
          ORIGIN_PRIORITY[origin] > ORIGIN_PRIORITY[existing.origin]
        ) {
          byId.set(record.id, incoming);
        }
      }
    }
    return [...byId.values()];
  }

  [memoryCatalogMutation](capability: object, actor: MemoryMutationActor): ISessionMemoryAccess {
    this.assertCapability(capability);
    return {
      _serviceBrand: undefined,
      ready: this.ready,
      onDidChange: this.onDidChange,
      list: () => this.list(),
      create: (input) => this.create(capability, actor, input),
      update: (scope, id, patch) => this.update(capability, actor, scope, id, patch),
      forget: (scope, id) => this.forget(capability, actor, scope, id),
    };
  }

  private async create(
    capability: object,
    actor: MemoryMutationActor,
    input: MemoryCreateInput,
  ): Promise<EffectiveMemory> {
    const content = this.sanitizeContent(input);
    const now = Date.now();
    const record: MemoryRecord = {
      id: ulid(),
      name: content.name,
      description: content.description,
      type: input.type,
      scope: input.scope,
      createdAt: now,
      updatedAt: now,
      version: 1,
      body: content.body,
    };
    this.assertWriteAllowed(capability, actor, input.scope);
    await this.mutations.put(this.storeScope(input.scope), record);
    this.changeEmitter.fire();
    return this.toEffective(record, input.scope);
  }

  private async update(
    capability: object,
    actor: MemoryMutationActor,
    scope: MemoryScope,
    id: string,
    patch: MemoryPatch,
  ): Promise<EffectiveMemory> {
    this.assertActorScope(capability, actor, scope);
    const record = await this.store.get(this.storeScope(scope), id);
    if (record === undefined) {
      throw new MemoryError(MemoryErrors.codes.MEMORY_NOT_FOUND, 'memory not found');
    }
    const content = this.sanitizeContent({
      name: patch.name ?? record.name,
      description: patch.description ?? record.description,
      body: patch.body ?? record.body,
    });
    const updated: MemoryRecord = {
      ...record,
      name: content.name,
      description: content.description,
      body: content.body,
      type: patch.type ?? record.type,
      updatedAt: Date.now(),
      version: record.version + 1,
    };
    this.assertWriteAllowed(capability, actor, scope);
    await this.mutations.put(this.storeScope(scope), updated);
    this.changeEmitter.fire();
    return this.toEffective(updated, scope);
  }

  private async forget(
    capability: object,
    actor: MemoryMutationActor,
    scope: MemoryScope,
    id: string,
  ): Promise<void> {
    this.assertActorScope(capability, actor, scope);
    const record = await this.store.get(this.storeScope(scope), id);
    if (record === undefined) return;
    this.assertWriteAllowed(capability, actor, scope);
    await this.mutations.delete(this.storeScope(scope), id);
    this.changeEmitter.fire();
  }

  private sanitizeContent(input: {
    readonly name: string;
    readonly description: string;
    readonly body: string;
  }): { readonly name: string; readonly description: string; readonly body: string } {
    const content = {
      name: redactMemoryBody(input.name),
      description: redactMemoryBody(input.description),
      body: redactMemoryBody(input.body),
    };
    if (
      looksLikeSecret(content.name) ||
      looksLikeSecret(content.description) ||
      looksLikeSecret(content.body)
    ) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_CONTENT_REJECTED,
        'memory content rejected',
      );
    }
    return content;
  }

  private assertCapability(capability: object): void {
    if (!hasCatalogMutationCapability(capability)) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_MUTATION_DENIED,
        'memory mutation denied',
      );
    }
  }

  private assertActorScope(
    capability: object,
    actor: MemoryMutationActor,
    scope: MemoryScope,
  ): void {
    this.assertCapability(capability);
    if (actor === 'subagent' && scope === 'user') {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_MUTATION_DENIED,
        'memory mutation denied',
      );
    }
  }

  private assertWriteAllowed(
    capability: object,
    actor: MemoryMutationActor,
    scope: MemoryScope,
  ): void {
    this.assertActorScope(capability, actor, scope);
    if (scope === 'project' && !this.trust.isTrusted()) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_TRUST_REQUIRED,
        'project memory requires a trusted workspace',
      );
    }
  }

  private storeScope(scope: MemoryScope): string {
    switch (scope) {
      case 'user':
        return 'user';
      case 'workspace':
        return `workspace/${this.workspaceId}`;
      case 'project':
        return `project/${this.workspaceId}`;
    }
  }

  private visibleOrigins(): readonly MemoryScope[] {
    return this.trust.isTrusted()
      ? PRECEDENCE
      : PRECEDENCE.filter((origin) => origin !== 'project');
  }

  private toEffective(record: MemoryRecord, origin: MemoryScope): EffectiveMemory {
    return { ...record, origin };
  }
}

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceMemoryCatalog,
  WorkspaceMemoryCatalogService,
  ScopeActivation.OnDemand,
  'persistentMemory',
);
