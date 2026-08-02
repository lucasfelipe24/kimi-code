/**
 * `persistentMemory` domain — durable memory document store.
 *
 * Reads bounded, schema-valid records through `persistence` and exposes only
 * read operations through `IMemoryStore`. Internal writes require an opaque
 * capability, validate physical/logical scope agreement, and serialize per
 * physical scope within this process. Atomic documents prevent partial writes,
 * but separate processes can still race because no cross-process lock is owned
 * here. Logs only fixed corruption categories. Bound at App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { MemoryErrors } from './errors';
import {
  DEFAULT_MEMORY_STORE_CAPS,
  IMemoryStore,
  MEMORY_ID_REGEX,
  MEMORY_LIST_CAP,
  MEMORY_SCAN_CAP,
  MEMORY_STORE_SCOPE_REGEX,
  MemoryError,
  MemoryRecordSchema,
  type MemoryRecord,
  type MemoryScope,
  type MemoryStoreCaps,
} from './memoryStore';
import {
  hasStoreMutationCapability,
  memoryStoreMutation,
  type MemoryStoreMutationHost,
} from './memoryStoreMutation';

const JSON_SUFFIX = '.json';

function isValidMemoryId(id: string): boolean {
  return MEMORY_ID_REGEX.test(id);
}

function isValidStoreScope(scope: string): boolean {
  return MEMORY_STORE_SCOPE_REGEX.test(scope);
}

function logicalScope(scope: string): MemoryScope | undefined {
  if (scope === 'user') return 'user';
  if (scope.startsWith('workspace/')) return 'workspace';
  if (scope.startsWith('project/')) return 'project';
  return undefined;
}

export class MemoryStoreService extends Disposable implements MemoryStoreMutationHost {
  declare readonly _serviceBrand: undefined;

  private readonly baseScope: string;
  private readonly caps: MemoryStoreCaps = DEFAULT_MEMORY_STORE_CAPS;
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    @IBootstrapService bootstrap: IBootstrapService,
    @IAtomicDocumentStore private readonly docs: IAtomicDocumentStore,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.baseScope = bootstrap.scope('memory');
  }

  async get(scope: string, id: string): Promise<MemoryRecord | undefined> {
    this.assertValidScope(scope);
    this.assertValidId(id);
    return this.readValid(scope, `${id}${JSON_SUFFIX}`);
  }

  async list(scope: string): Promise<readonly MemoryRecord[]> {
    this.assertValidScope(scope);
    return this.listValid(scope);
  }

  async [memoryStoreMutation](
    capability: object,
    operation: 'put' | 'delete',
    scope: string,
    value: MemoryRecord | string,
  ): Promise<void> {
    if (!hasStoreMutationCapability(capability)) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_MUTATION_DENIED,
        'memory mutation denied',
      );
    }
    this.assertValidScope(scope);
    return this.enqueue(scope, async () => {
      if (operation === 'put' && typeof value !== 'string') {
        await this.put(scope, value);
        return;
      }
      if (operation === 'delete' && typeof value === 'string') {
        this.assertValidId(value);
        await this.docs.delete(this.scopePath(scope), `${value}${JSON_SUFFIX}`);
        return;
      }
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_INVALID_RECORD,
        'memory mutation input is invalid',
      );
    });
  }

  private scopePath(scope: string): string {
    return `${this.baseScope}/${scope}`;
  }

  private assertValidScope(scope: string): void {
    if (!isValidStoreScope(scope)) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_INVALID_SCOPE,
        'memory scope is not in the allowlist',
      );
    }
  }

  private assertValidId(id: string): void {
    if (!isValidMemoryId(id)) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_INVALID_ID,
        'memory id must be a ULID',
      );
    }
  }

  private assertScopeAgreement(scope: string, record: MemoryRecord): void {
    if (record.scope !== logicalScope(scope)) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_INVALID_RECORD,
        'memory record scope does not match storage scope',
      );
    }
  }

  private async put(scope: string, record: MemoryRecord): Promise<void> {
    this.assertValidId(record.id);
    const parsed = MemoryRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_INVALID_RECORD,
        'memory record failed validation',
      );
    }
    this.assertScopeAgreement(scope, parsed.data);

    const bodyBytes = Buffer.byteLength(record.body, 'utf8');
    if (bodyBytes > this.caps.maxBodyBytes) {
      throw new MemoryError(
        MemoryErrors.codes.MEMORY_BODY_TOO_LARGE,
        'memory body exceeds the byte cap',
        { details: { bytes: bodyBytes, cap: this.caps.maxBodyBytes } },
      );
    }

    const existing = await this.readValid(scope, `${record.id}${JSON_SUFFIX}`);
    if (existing !== undefined) {
      if (record.version !== existing.version + 1) {
        throw new MemoryError(
          MemoryErrors.codes.MEMORY_VERSION_CONFLICT,
          'memory version conflict',
          { details: { expected: existing.version + 1, received: record.version } },
        );
      }
    } else {
      const current = await this.listValid(scope);
      if (current.length >= this.caps.maxPerScope) {
        throw new MemoryError(
          MemoryErrors.codes.MEMORY_SCOPE_FULL,
          'memory scope is at capacity',
          { details: { cap: this.caps.maxPerScope } },
        );
      }
    }

    await this.docs.set(this.scopePath(scope), `${record.id}${JSON_SUFFIX}`, record);
  }

  private async listValid(scope: string): Promise<readonly MemoryRecord[]> {
    const keys = await this.docs.list(this.scopePath(scope));
    const records: MemoryRecord[] = [];
    let scanned = 0;
    for (const key of keys) {
      if (!key.endsWith(JSON_SUFFIX)) continue;
      const id = key.slice(0, -JSON_SUFFIX.length);
      if (!isValidMemoryId(id)) continue;
      if (scanned >= MEMORY_SCAN_CAP || records.length >= MEMORY_LIST_CAP) break;
      scanned += 1;
      const record = await this.readValid(scope, key);
      if (record !== undefined) records.push(record);
    }
    return records;
  }

  private async readValid(scope: string, key: string): Promise<MemoryRecord | undefined> {
    let value: unknown;
    try {
      value = await this.docs.get<unknown>(this.scopePath(scope), key);
    } catch {
      this.log.debug('persistent memory document unreadable');
      return undefined;
    }
    if (value === undefined) return undefined;
    const parsed = MemoryRecordSchema.safeParse(value);
    if (!parsed.success || parsed.data.scope !== logicalScope(scope)) {
      this.log.debug('persistent memory document invalid');
      return undefined;
    }
    return parsed.data;
  }

  private enqueue<T>(scope: string, work: () => Promise<T>): Promise<T> {
    const tail = this.mutationTails.get(scope) ?? Promise.resolve();
    const run = tail.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.mutationTails.set(scope, settled);
    void settled.finally(() => {
      if (this.mutationTails.get(scope) === settled) this.mutationTails.delete(scope);
    });
    return run;
  }
}

registerScopedService(
  LifecycleScope.App,
  IMemoryStore,
  MemoryStoreService,
  ScopeActivation.OnScopeCreated,
  'persistentMemory',
);
