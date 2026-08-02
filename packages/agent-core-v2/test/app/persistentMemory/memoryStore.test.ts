/**
 * Scenario: durable memory store — CRUD per scope over the real node-fs
 * `JsonAtomicDocumentStore`, ULID id validation before any fs touch
 * (traversal defense), tolerant scan over corrupted JSON, the 200-doc scan
 * cap, the per-write byte / count caps, optimistic version updates, and a
 * concurrent write on the same id that never corrupts the file.
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/app/persistentMemory/memoryStore.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { MemoryErrors } from '#/app/persistentMemory/errors';
import {
  DEFAULT_MEMORY_MAX_BODY_BYTES,
  DEFAULT_MEMORY_MAX_PER_SCOPE,
  IMemoryStore,
  type MemoryRecord,
} from '#/app/persistentMemory/memoryStore';
import { mutationAccess, type MemoryStoreMutation } from '#/app/persistentMemory/memoryStoreMutation';
import { MemoryStoreService } from '#/app/persistentMemory/memoryStoreService';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';

import { stubLog } from '../../_base/log/stubs';

const MEMORY_ROOT = 'memory';
/** A valid `encodeWorkDirKey`-shaped project store scope (`wd_<slug>_<hash>`). */
const WORKSPACE_SCOPE = 'workspace/wd_repo_0123456789ab';
const PROJECT_SCOPE = 'project/wd_repo_0123456789ab';

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: ulid(),
    name: 'a name',
    description: 'a description',
    type: 'user',
    scope: 'user',
    createdAt: now,
    updatedAt: now,
    version: 1,
    body: 'a body',
    ...overrides,
  };
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('MemoryStoreService', () => {
  let homeDir: string;
  let disposables: DisposableStore;
  let store: IMemoryStore;
  let mutations: MemoryStoreMutation;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-memory-store-home-'));
    disposables = new DisposableStore();
    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        reg.definePartialInstance(IBootstrapService, {
          scope: () => MEMORY_ROOT,
        });
        reg.defineInstance(
          IAtomicDocumentStore,
          new JsonAtomicDocumentStore(new FileStorageService(homeDir)),
        );
        reg.defineInstance(ILogService, stubLog());
        reg.define(IMemoryStore, MemoryStoreService);
      },
    });
    store = ix.get(IMemoryStore);
    mutations = mutationAccess(store);
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  it('round-trips put / get / list / delete per scope', async () => {
    const user = record({ scope: 'user', name: 'user memory' });
    const project = record({ scope: 'project', name: 'project memory' });

    await mutations.put('user', user);
    await mutations.put(PROJECT_SCOPE, project);

    expect(await store.get('user', user.id)).toEqual(user);
    expect(await store.get(PROJECT_SCOPE, project.id)).toEqual(project);
    // scopes are isolated
    expect(await store.get('user', project.id)).toBeUndefined();

    const listed = await store.list('user');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(user.id);

    await mutations.delete('user', user.id);
    expect(await store.get('user', user.id)).toBeUndefined();
    expect(await store.list('user')).toHaveLength(0);
  });

  describe('invalid id is rejected before touching the fs', () => {
    const cases: Record<string, string> = {
      traversal: '../evil',
      nullByte: 'abc\0def',
      percent: '%2e%2e',
      notUlid: 'not-a-ulid',
      tooShort: 'ABC',
    };

    for (const [label, id] of Object.entries(cases)) {
      it(label, async () => {
        expect(await errorCode(store.get('user', id))).toBe(
          MemoryErrors.codes.MEMORY_INVALID_ID,
        );
        expect(await errorCode(mutations.delete('user', id))).toBe(
          MemoryErrors.codes.MEMORY_INVALID_ID,
        );
        expect(await errorCode(mutations.put('user', record({ id })))).toBe(
          MemoryErrors.codes.MEMORY_INVALID_ID,
        );
        // nothing was written to disk under the memory root
        await expect(readdir(join(homeDir, MEMORY_ROOT))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    }
  });

  describe('invalid scope is rejected before touching the fs', () => {
    const cases: Record<string, string> = {
      traversal: '../evil',
      dotDot: '..',
      empty: '',
      nullByte: 'user\0',
      leadingSlash: '/user',
      bareProject: 'project',
      badWid: 'project/not-a-wid',
    };

    for (const [label, scope] of Object.entries(cases)) {
      it(label, async () => {
        const validId = ulid();
        expect(await errorCode(store.get(scope, validId))).toBe(
          MemoryErrors.codes.MEMORY_INVALID_SCOPE,
        );
        expect(await errorCode(store.list(scope))).toBe(
          MemoryErrors.codes.MEMORY_INVALID_SCOPE,
        );
        expect(await errorCode(mutations.delete(scope, validId))).toBe(
          MemoryErrors.codes.MEMORY_INVALID_SCOPE,
        );
        expect(
          await errorCode(mutations.put(scope, record({ id: validId }))),
        ).toBe(MemoryErrors.codes.MEMORY_INVALID_SCOPE);
        // nothing was written to disk under the memory root
        await expect(readdir(join(homeDir, MEMORY_ROOT))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    }
  });

  it('accepts a valid workspace/project scope', async () => {
    const project = record({ scope: 'project' });
    await mutations.put(PROJECT_SCOPE, project);
    expect(await store.get(PROJECT_SCOPE, project.id)).toEqual(project);
  });

  it('rejects every physical/logical scope mismatch on write', async () => {
    const cases = [
      ['user', 'workspace'],
      ['workspace', 'user'],
      ['workspace', 'project'],
      ['project', 'user'],
      ['project', 'workspace'],
    ] as const;
    for (const [physical, logical] of cases) {
      const scope =
        physical === 'user'
          ? 'user'
          : physical === 'workspace'
            ? WORKSPACE_SCOPE
            : PROJECT_SCOPE;
      expect(await errorCode(mutations.put(scope, record({ scope: logical })))).toBe(
        MemoryErrors.codes.MEMORY_INVALID_RECORD,
      );
    }
  });

  it('ignores records whose logical scope disagrees with their physical scope', async () => {
    const cases = [
      ['user', 'workspace'],
      ['workspace', 'user'],
      ['workspace', 'project'],
      ['project', 'user'],
      ['project', 'workspace'],
    ] as const;
    for (const [physical, logical] of cases) {
      const scope =
        physical === 'user'
          ? 'user'
          : physical === 'workspace'
            ? WORKSPACE_SCOPE
            : PROJECT_SCOPE;
      const mismatched = record({ scope: logical });
      const scopeDir = join(homeDir, MEMORY_ROOT, scope);
      await mkdir(scopeDir, { recursive: true });
      await writeFile(
        join(scopeDir, `${mismatched.id}.json`),
        JSON.stringify(mismatched),
        'utf8',
      );
      expect(await store.get(scope, mismatched.id)).toBeUndefined();
      expect((await store.list(scope)).some((entry) => entry.id === mismatched.id)).toBe(false);
    }
  });

  it('tolerates corrupted JSON documents during list', async () => {
    const good = record({ scope: 'user' });
    await mutations.put('user', good);

    // Drop a corrupted document beside the good one, named like a valid id.
    const badId = ulid();
    const scopeDir = join(homeDir, MEMORY_ROOT, 'user');
    await mkdir(scopeDir, { recursive: true });
    await writeFile(join(scopeDir, `${badId}.json`), '{ not valid json', 'utf8');

    const listed = await store.list('user');
    expect(listed.map((r) => r.id)).toEqual([good.id]);
    // a direct get on the corrupted id is swallowed too
    expect(await store.get('user', badId)).toBeUndefined();
  });

  it('caps the scan at 200 documents', async () => {
    const scopeDir = join(homeDir, MEMORY_ROOT, 'user');
    await mkdir(scopeDir, { recursive: true });
    for (let i = 0; i < 205; i++) {
      const r = record({ scope: 'user' });
      await writeFile(join(scopeDir, `${r.id}.json`), JSON.stringify(r), 'utf8');
    }
    const listed = await store.list('user');
    expect(listed.length).toBe(200);
  });

  it('rejects a body over the byte cap', async () => {
    const big = record({ body: 'x'.repeat(DEFAULT_MEMORY_MAX_BODY_BYTES + 1) });
    expect(await errorCode(mutations.put('user', big))).toBe(
      MemoryErrors.codes.MEMORY_BODY_TOO_LARGE,
    );
  });

  it('rejects a new record once the scope is full', async () => {
    const scopeDir = join(homeDir, MEMORY_ROOT, 'user');
    await mkdir(scopeDir, { recursive: true });
    for (let i = 0; i < DEFAULT_MEMORY_MAX_PER_SCOPE; i++) {
      const r = record({ scope: 'user' });
      await writeFile(join(scopeDir, `${r.id}.json`), JSON.stringify(r), 'utf8');
    }
    expect(await errorCode(mutations.put('user', record({ scope: 'user' })))).toBe(
      MemoryErrors.codes.MEMORY_SCOPE_FULL,
    );
  });

  it('serializes concurrent creates competing for the last scope slot', async () => {
    const scopeDir = join(homeDir, MEMORY_ROOT, 'user');
    await mkdir(scopeDir, { recursive: true });
    for (let i = 0; i < DEFAULT_MEMORY_MAX_PER_SCOPE - 1; i++) {
      const persisted = record({ scope: 'user' });
      await writeFile(join(scopeDir, `${persisted.id}.json`), JSON.stringify(persisted), 'utf8');
    }
    const results = await Promise.allSettled([
      mutations.put('user', record({ scope: 'user' })),
      mutations.put('user', record({ scope: 'user' })),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await store.list('user')).toHaveLength(DEFAULT_MEMORY_MAX_PER_SCOPE);
  });

  it('enforces optimistic version on update', async () => {
    const base = record({ scope: 'user', version: 1 });
    await mutations.put('user', base);

    // A stale version (same as persisted) is rejected.
    expect(
      await errorCode(mutations.put('user', { ...base, version: 1, body: 'stale' })),
    ).toBe(MemoryErrors.codes.MEMORY_VERSION_CONFLICT);

    // A skipping version is rejected.
    expect(
      await errorCode(mutations.put('user', { ...base, version: 3, body: 'skip' })),
    ).toBe(MemoryErrors.codes.MEMORY_VERSION_CONFLICT);

    // The exact next version succeeds.
    await mutations.put('user', { ...base, version: 2, body: 'next' });
    expect((await store.get('user', base.id))?.body).toBe('next');
  });

  it('serializes concurrent next-version writes on the same id', async () => {
    const base = record({ scope: 'user', version: 1, body: 'seed' });
    await mutations.put('user', base);

    const results = await Promise.allSettled([
      mutations.put('user', { ...base, version: 2, body: 'A' }),
      mutations.put('user', { ...base, version: 2, body: 'B' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: MemoryErrors.codes.MEMORY_VERSION_CONFLICT,
    });

    const final = await store.get('user', base.id);
    expect(final?.id).toBe(base.id);
    expect(['A', 'B']).toContain(final?.body);
  });
});
