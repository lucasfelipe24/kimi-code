/**
 * Scenario: workspace memory catalog — the effective projection over the real
 * `MemoryStoreService`, per-scope ids (project never shadows user), the trust
 * gate (untrusted hides project and rejects project create / update), a
 * trust→untrust flip that re-fires `onDidChange` and re-projects, and idempotent
 * `forget`.
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/workspace/persistentMemory/memoryCatalog.test.ts`.
 */

import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { MemoryErrors } from '#/app/persistentMemory/errors';
import { IMemoryStore } from '#/app/persistentMemory/memoryStore';
import { mutationAccess, type MemoryStoreMutation } from '#/app/persistentMemory/memoryStoreMutation';
import { MemoryStoreService } from '#/app/persistentMemory/memoryStoreService';
import type { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';
import { JsonAtomicDocumentStore } from '#/persistence/backends/node-fs/atomicDocumentStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import { IWorkspaceStateService } from '#/workspace/state/workspaceState';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { IWorkspaceTrust } from '#/workspace/workspaceTrust/workspaceTrust';
import { WorkspaceTrustService } from '#/workspace/workspaceTrust/workspaceTrustService';

import { IWorkspaceMemoryCatalog } from '#/workspace/persistentMemory/memoryCatalog';
import { WorkspaceMemoryCatalogService } from '#/workspace/persistentMemory/memoryCatalogService';
import { memoryAccessForActor } from '#/workspace/persistentMemory/memoryCatalogMutation';

import { stubLog } from '../../_base/log/stubs';
import { registerStateServices } from '../../state/stubs';

/** `encodeWorkDirKey`-shaped id so store-scope allowlist accepts `<scope>/<id>`. */
const WORKSPACE_ID = 'wd_repo_0123456789ab';

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('WorkspaceMemoryCatalogService', () => {
  let homeDir: string;
  let cwd: string;
  let disposables: DisposableStore;
  let catalog: IWorkspaceMemoryCatalog;
  let access: ISessionMemoryAccess;
  let subagentAccess: ISessionMemoryAccess;
  let trust: IWorkspaceTrust;
  let store: IMemoryStore;
  let mutations: MemoryStoreMutation;
  let flagEnabled: boolean;

  beforeEach(async () => {
    homeDir = mkdtempSync(join(tmpdir(), 'kimi-memory-catalog-home-'));
    cwd = mkdtempSync(join(tmpdir(), 'kimi-memory-catalog-cwd-'));
    disposables = new DisposableStore();
    flagEnabled = true;

    const ix = createServices(disposables, {
      strict: true,
      additionalServices: (reg) => {
        registerStateServices(reg);
        reg.definePartialInstance(IBootstrapService, { scope: () => 'memory' });
        reg.definePartialInstance(IWorkspaceContext, {
          workspaceId: WORKSPACE_ID,
          cwd,
        });
        reg.defineInstance(
          IAtomicDocumentStore,
          new JsonAtomicDocumentStore(new FileStorageService(homeDir)),
        );
        reg.defineInstance(ILogService, stubLog());
        reg.definePartialInstance(IFlagService, { enabled: () => flagEnabled });
        reg.define(IMemoryStore, MemoryStoreService);
        reg.define(IWorkspaceTrust, WorkspaceTrustService);
        reg.define(IWorkspaceMemoryCatalog, WorkspaceMemoryCatalogService);
      },
    });
    trust = ix.get(IWorkspaceTrust);
    await trust.ready;
    store = ix.get(IMemoryStore);
    mutations = mutationAccess(store);
    catalog = ix.get(IWorkspaceMemoryCatalog);
    access = memoryAccessForActor(catalog, 'main');
    subagentAccess = memoryAccessForActor(catalog, 'subagent');
    await catalog.ready;
  });

  afterEach(async () => {
    disposables.dispose();
    await Promise.all([
      rm(homeDir, { recursive: true, force: true }),
      rm(cwd, { recursive: true, force: true }),
    ]);
  });

  it('projects user < workspace < project precedence with per-scope ids', async () => {
    await trust.trust();

    const user = await access.create({
      scope: 'user',
      type: 'user',
      name: 'user note',
      description: 'd',
      body: 'user body',
    });
    const workspace = await access.create({
      scope: 'workspace',
      type: 'reference',
      name: 'workspace note',
      description: 'd',
      body: 'workspace body',
    });
    const project = await access.create({
      scope: 'project',
      type: 'project',
      name: 'project note',
      description: 'd',
      body: 'project body',
    });

    const listed = await catalog.list();
    const byId = new Map(listed.map((m) => [m.id, m]));

    // All three ids are distinct (per-scope) and present with their origin.
    expect(byId.get(user.id)?.origin).toBe('user');
    expect(byId.get(workspace.id)?.origin).toBe('workspace');
    expect(byId.get(project.id)?.origin).toBe('project');
    expect(listed).toHaveLength(3);
  });

  it('project memory with the same id never shadows user memory', async () => {
    await trust.trust();
    const user = await access.create({
      scope: 'user',
      type: 'user',
      name: 'user note',
      description: 'd',
      body: 'user body',
    });

    // Force a project record that reuses the user id via the raw store (ids are
    // per-scope, so this collision is legal at the store layer). Precedence is
    // by origin, not id, so the project record must NOT shadow the user one.
    const now = Date.now();
    await mutations.put(`project/${WORKSPACE_ID}`, {
      id: user.id,
      name: 'colliding project note',
      description: 'd',
      type: 'project',
      scope: 'project',
      createdAt: now,
      updatedAt: now,
      version: 1,
      body: 'project body',
    });

    const listed = await catalog.list();
    const projected = listed.find((m) => m.id === user.id);
    // The user origin wins for this id; a separate project entry with the same
    // id collapses in the map — the survivor is the user record.
    expect(projected?.origin).toBe('user');
    expect(projected?.name).toBe('user note');
  });

  it('update of a user memory returns the new EffectiveMemory and reflects in list', async () => {
    const user = await access.create({
      scope: 'user',
      type: 'user',
      name: 'user note',
      description: 'd',
      body: 'old body',
    });

    let changes = 0;
    disposables.add(catalog.onDidChange(() => changes++));

    const before = Date.now();
    const updated = await access.update('user', user.id, { body: 'new body' });

    expect(updated.origin).toBe('user');
    expect(updated.version).toBe(2);
    expect(updated.body).toBe('new body');
    expect(updated.updatedAt).toBeGreaterThanOrEqual(before);
    expect(changes).toBe(1);

    const listed = await catalog.list();
    expect(listed.find((m) => m.id === user.id)?.body).toBe('new body');
    expect(listed.find((m) => m.id === user.id)?.version).toBe(2);
  });

  it('scope-aware update mutates only the declared scope on an id collision', async () => {
    await trust.trust();
    const user = await access.create({
      scope: 'user',
      type: 'user',
      name: 'user note',
      description: 'd',
      body: 'user body',
    });
    // Force a project record reusing the SAME id via the raw store.
    const now = Date.now();
    await mutations.put(`project/${WORKSPACE_ID}`, {
      id: user.id,
      name: 'project note',
      description: 'd',
      type: 'project',
      scope: 'project',
      createdAt: now,
      updatedAt: now,
      version: 1,
      body: 'project body',
    });

    // Updating the id in the `project` scope must touch ONLY the project record;
    // the user record with the same id stays intact.
    const updated = await access.update('project', user.id, { body: 'patched project' });
    expect(updated.origin).toBe('project');
    expect(updated.body).toBe('patched project');
    expect((await store.get('user', user.id))?.body).toBe('user body');
  });

  it('scope-aware forget deletes only the declared scope on an id collision', async () => {
    await trust.trust();
    const user = await access.create({
      scope: 'user',
      type: 'user',
      name: 'user note',
      description: 'd',
      body: 'user body',
    });
    const now = Date.now();
    await mutations.put(`project/${WORKSPACE_ID}`, {
      id: user.id,
      name: 'project note',
      description: 'd',
      type: 'project',
      scope: 'project',
      createdAt: now,
      updatedAt: now,
      version: 1,
      body: 'project body',
    });

    await access.forget('project', user.id);
    // Only the project record is gone; the user record survives.
    expect(await store.get(`project/${WORKSPACE_ID}`, user.id)).toBeUndefined();
    expect((await store.get('user', user.id))?.body).toBe('user body');
  });

  it('update of a workspace memory advances the version', async () => {
    const ws = await access.create({
      scope: 'workspace',
      type: 'reference',
      name: 'ws note',
      description: 'd',
      body: 'old',
    });
    const updated = await access.update('workspace', ws.id, { name: 'renamed' });
    expect(updated.origin).toBe('workspace');
    expect(updated.version).toBe(2);
    expect(updated.name).toBe('renamed');
    expect((await catalog.list()).find((m) => m.id === ws.id)?.name).toBe('renamed');
  });

  it('update of an unknown id rejects with MEMORY_NOT_FOUND', async () => {
    expect(
      await errorCode(
        access.update('user', '01BX5ZZKBKACTAV9WEVGEMMVRZ', { body: 'x' }),
      ),
    ).toBe(MemoryErrors.codes.MEMORY_NOT_FOUND);
  });

  it('forget of a project memory while untrusted is rejected', async () => {
    await trust.trust();
    const project = await access.create({
      scope: 'project',
      type: 'project',
      name: 'n',
      description: 'd',
      body: 'b',
    });

    await trust.untrust();
    expect(await errorCode(access.forget('project', project.id))).toBe(
      MemoryErrors.codes.MEMORY_TRUST_REQUIRED,
    );
  });

  describe('trust gate', () => {
    it('hides project memory while untrusted', async () => {
      await trust.trust();
      const project = await access.create({
        scope: 'project',
        type: 'project',
        name: 'project note',
        description: 'd',
        body: 'project body',
      });
      expect((await catalog.list()).some((m) => m.id === project.id)).toBe(true);

      await trust.untrust();
      expect((await catalog.list()).some((m) => m.id === project.id)).toBe(false);
    });

    it('rejects project create while untrusted', async () => {
      await trust.untrust();
      expect(
        await errorCode(
          access.create({
            scope: 'project',
            type: 'project',
            name: 'n',
            description: 'd',
            body: 'b',
          }),
        ),
      ).toBe(MemoryErrors.codes.MEMORY_TRUST_REQUIRED);
    });

    it('rejects project update while untrusted', async () => {
      await trust.trust();
      const project = await access.create({
        scope: 'project',
        type: 'project',
        name: 'n',
        description: 'd',
        body: 'b',
      });

      await trust.untrust();
      expect(
        await errorCode(access.update('project', project.id, { body: 'new body' })),
      ).toBe(MemoryErrors.codes.MEMORY_TRUST_REQUIRED);
    });

    it('still allows user/workspace create while untrusted', async () => {
      await trust.untrust();
      const user = await access.create({
        scope: 'user',
        type: 'user',
        name: 'n',
        description: 'd',
        body: 'b',
      });
      expect((await catalog.list()).some((m) => m.id === user.id)).toBe(true);
    });
  });

  it('fires onDidChange and re-projects on a trust→untrust transition', async () => {
    await trust.trust();
    const project = await access.create({
      scope: 'project',
      type: 'project',
      name: 'n',
      description: 'd',
      body: 'b',
    });
    expect((await catalog.list()).some((m) => m.id === project.id)).toBe(true);

    let changes = 0;
    disposables.add(catalog.onDidChange(() => changes++));

    await trust.untrust();

    expect(changes).toBeGreaterThanOrEqual(1);
    expect((await catalog.list()).some((m) => m.id === project.id)).toBe(false);
  });

  it('fires onDidChange on create and forget', async () => {
    let changes = 0;
    disposables.add(catalog.onDidChange(() => changes++));

    const user = await access.create({
      scope: 'user',
      type: 'user',
      name: 'n',
      description: 'd',
      body: 'b',
    });
    expect(changes).toBe(1);

    await access.forget('user', user.id);
    expect(changes).toBe(2);
  });

  it('forget is idempotent for an unknown id (no-op, no throw, no event)', async () => {
    let changes = 0;
    disposables.add(catalog.onDidChange(() => changes++));

    await expect(access.forget('user', '01BX5ZZKBKACTAV9WEVGEMMVRZ')).resolves.toBeUndefined();
    expect(changes).toBe(0);
  });

  describe('subagent actor escalation guard (real catalog boundary)', () => {
    it('rejects a subagent creating user-scope memory and writes nothing', async () => {
      expect(
        await errorCode(
          subagentAccess.create({
            scope: 'user',
            type: 'user',
            name: 'pref',
            description: 'd',
            body: 'prefers tabs',
          }),
        ),
      ).toBe(MemoryErrors.codes.MEMORY_MUTATION_DENIED);
      // Nothing reached the store — the user scope stays empty.
      expect(await store.list('user')).toHaveLength(0);
    });

    it('rejects a subagent updating user-scope memory, leaving the record intact', async () => {
      const user = await access.create({
        scope: 'user',
        type: 'user',
        name: 'user note',
        description: 'd',
        body: 'user body',
      });
      expect(
        await errorCode(subagentAccess.update('user', user.id, { body: 'hijacked' })),
      ).toBe(MemoryErrors.codes.MEMORY_MUTATION_DENIED);
      expect((await store.get('user', user.id))?.body).toBe('user body');
    });

    it('rejects a subagent forgetting user-scope memory, leaving the record intact', async () => {
      const user = await access.create({
        scope: 'user',
        type: 'user',
        name: 'user note',
        description: 'd',
        body: 'user body',
      });
      expect(await errorCode(subagentAccess.forget('user', user.id))).toBe(
        MemoryErrors.codes.MEMORY_MUTATION_DENIED,
      );
      expect((await store.get('user', user.id))?.body).toBe('user body');
    });

    it('still lets a subagent write workspace-scope memory (guard is scope-specific)', async () => {
      const ws = await subagentAccess.create({
        scope: 'workspace',
        type: 'reference',
        name: 'shared note',
        description: 'd',
        body: 'content',
      });
      expect(ws.origin).toBe('workspace');
      expect((await store.get(`workspace/${WORKSPACE_ID}`, ws.id))?.body).toBe('content');
    });
  });

  describe('secret redaction and residual-secret rejection (real sanitizeContent)', () => {
    it('redacts credential shapes in name, description AND body before persistence', async () => {
      const created = await access.create({
        scope: 'workspace',
        type: 'reference',
        name: 'token ghp_abcdefghijklmnopqrstuvwxyz012345',
        description: 'call with api_key=SUPERSECRETVALUE to authenticate',
        body: 'key sk-ABC123DEF456GHI789 then run it',
      });

      // Returned EffectiveMemory carries the redacted content...
      expect(created.name).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
      expect(created.name).toContain('[redacted]');
      expect(created.description).not.toContain('SUPERSECRETVALUE');
      expect(created.description).toContain('[redacted]');
      expect(created.body).not.toContain('sk-ABC123DEF456GHI789');
      expect(created.body).toContain('[redacted]');

      // ...and so does the durably persisted record (redaction happens before put).
      const persisted = await store.get(`workspace/${WORKSPACE_ID}`, created.id);
      expect(persisted?.name).toContain('[redacted]');
      expect(persisted?.description).toContain('[redacted]');
      expect(persisted?.body).toContain('[redacted]');
      expect(persisted?.body).not.toContain('sk-ABC123DEF456GHI789');
    });

    it('rejects a residual secret that survives redaction on create and writes nothing', async () => {
      // A high-entropy mixed-case+digit blob the deny-list does not target: it
      // survives redaction, so `looksLikeSecret` must quarantine the write.
      const blob = 'Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd';
      expect(
        await errorCode(
          access.create({
            scope: 'workspace',
            type: 'reference',
            name: 'creds',
            description: 'a token',
            body: `credential ${blob}`,
          }),
        ),
      ).toBe(MemoryErrors.codes.MEMORY_CONTENT_REJECTED);
      expect(await store.list(`workspace/${WORKSPACE_ID}`)).toHaveLength(0);
    });

    it('rejects a residual secret introduced by an update, leaving the prior record intact', async () => {
      const ws = await access.create({
        scope: 'workspace',
        type: 'reference',
        name: 'note',
        description: 'clean',
        body: 'clean body',
      });
      const blob = 'Ab3Kd9Xz2Qw7Lm4Rt6Yh1Uj8Nb5Vc0Pd';
      expect(
        await errorCode(access.update('workspace', ws.id, { body: `credential ${blob}` })),
      ).toBe(MemoryErrors.codes.MEMORY_CONTENT_REJECTED);
      // The prior clean record is untouched (still version 1).
      const persisted = await store.get(`workspace/${WORKSPACE_ID}`, ws.id);
      expect(persisted?.body).toBe('clean body');
      expect(persisted?.version).toBe(1);
    });
  });

  describe('feature-flag gate at the mutation boundary', () => {
    it('rejects create with MEMORY_DISABLED when the persistent-memory flag is off', async () => {
      flagEnabled = false;
      expect(
        await errorCode(
          access.create({
            scope: 'workspace',
            type: 'reference',
            name: 'n',
            description: 'd',
            body: 'b',
          }),
        ),
      ).toBe(MemoryErrors.codes.MEMORY_DISABLED);
      expect(await store.list(`workspace/${WORKSPACE_ID}`)).toHaveLength(0);
    });
  });
});
