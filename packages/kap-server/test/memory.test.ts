/**
 * `/api/v1/workspaces/{wid}/memories` routes — persistent-memory CRUD surface.
 *
 * Covers the wire contract:
 *   - GET    empty list on a fresh workspace
 *   - POST   create → GET reflects it
 *   - PATCH  update mutates name/body and bumps version
 *   - DELETE forget removes it
 *   - GET    on an unknown workspace → 40410
 *   - project scope on an untrusted workspace → 40922 (trust required)
 *   - native: create still succeeds with the old experiment env unset
 *
 * Persistent memory is a native engine-v2 capability (no feature flag). The
 * old `KIMI_CODE_EXPERIMENTAL_PERSISTENT_MEMORY` env no longer gates it; the
 * blocks below set/clear it only to prove it has no effect.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/start';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';
import { authHeaders } from './helpers/auth';

const FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PERSISTENT_MEMORY';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface MemoryWire {
  id: string;
  name: string;
  description: string;
  type: string;
  scope: string;
  origin: string;
  created_at: string;
  updated_at: string;
  version: number;
  body: string;
}

describe('server-v2 /api/v1 memories', () => {
  let server: RunningServer | undefined;
  let home: string | undefined;
  let base: string;
  let prevFlag: string | undefined;

  async function boot(flagOn: boolean): Promise<void> {
    prevFlag = process.env[FLAG_ENV];
    if (flagOn) process.env[FLAG_ENV] = '1';
    else delete process.env[FLAG_ENV];
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-memory-'));
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  }

  beforeEach(() => {
    prevFlag = process.env[FLAG_ENV];
  });

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
    if (home !== undefined) {
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 } as never);
      home = undefined;
    }
    if (prevFlag === undefined) delete process.env[FLAG_ENV];
    else process.env[FLAG_ENV] = prevFlag;
  });

  async function getJson<T>(path: string): Promise<{ status: number; body: Envelope<T> }> {
    const res = await fetch(`${base}${path}`, {
      headers: authHeaders(server as RunningServer),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function send<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: Envelope<T> }> {
    // Only set the JSON content-type when a body is actually sent — Fastify
    // rejects an empty body when content-type is application/json (relevant for
    // the body-less DELETE).
    const headers =
      body === undefined
        ? authHeaders(server as RunningServer)
        : authHeaders(server as RunningServer, { 'content-type': 'application/json' });
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    } as never);
    return { status: res.status, body: (await res.json()) as Envelope<T> };
  }

  async function registerWorkspace(root: string): Promise<string> {
    const { body } = await send<{ id: string }>('POST', '/api/v1/workspaces', { root });
    expect(body.code).toBe(0);
    return body.data.id;
  }

  async function makeWorkspaceDir(): Promise<string> {
    const dir = join(
      home as string,
      `workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(dir, { recursive: true });
    return dir;
  }

  describe('with the persistent-memory flag on', () => {
    beforeEach(async () => {
      await boot(true);
    });

    it('lists empty, creates, reflects, updates, and forgets a workspace memory', async () => {
      const wid = await registerWorkspace(await makeWorkspaceDir());

      const empty = await getJson<{ items: MemoryWire[] }>(`/api/v1/workspaces/${wid}/memories`);
      expect(empty.body.code).toBe(0);
      expect(empty.body.data.items).toEqual([]);

      const created = await send<MemoryWire>('POST', `/api/v1/workspaces/${wid}/memories`, {
        scope: 'workspace',
        type: 'project',
        name: 'build command',
        description: 'how to build the app',
        body: 'run pnpm build',
      });
      expect(created.body.code).toBe(0);
      const id = created.body.data.id;
      expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
      expect(created.body.data.origin).toBe('workspace');
      expect(created.body.data.version).toBe(1);

      const listed = await getJson<{ items: MemoryWire[] }>(`/api/v1/workspaces/${wid}/memories`);
      expect(listed.body.data.items.map((m) => m.id)).toContain(id);

      const updated = await send<MemoryWire>(
        'PATCH',
        `/api/v1/workspaces/${wid}/memories/${id}`,
        { scope: 'workspace', name: 'build cmd', body: 'run pnpm -w build' },
      );
      expect(updated.body.code).toBe(0);
      expect(updated.body.data.name).toBe('build cmd');
      expect(updated.body.data.body).toBe('run pnpm -w build');
      expect(updated.body.data.version).toBe(2);

      const del = await send<{ deleted: true }>(
        'DELETE',
        `/api/v1/workspaces/${wid}/memories/${id}?scope=workspace`,
      );
      expect(del.body.code).toBe(0);
      expect(del.body.data.deleted).toBe(true);

      const after = await getJson<{ items: MemoryWire[] }>(`/api/v1/workspaces/${wid}/memories`);
      expect(after.body.data.items.map((m) => m.id)).not.toContain(id);
    });

    it('creates a user-scope memory visible from any workspace', async () => {
      const widA = await registerWorkspace(await makeWorkspaceDir());
      const widB = await registerWorkspace(await makeWorkspaceDir());

      const created = await send<MemoryWire>('POST', `/api/v1/workspaces/${widA}/memories`, {
        scope: 'user',
        type: 'user',
        name: 'prefers portuguese',
        description: 'user language preference',
        body: 'reply in pt-BR',
      });
      expect(created.body.code).toBe(0);

      const fromB = await getJson<{ items: MemoryWire[] }>(`/api/v1/workspaces/${widB}/memories`);
      expect(fromB.body.data.items.map((m) => m.name)).toContain('prefers portuguese');
    });

    it('rejects project-scope creation on an untrusted workspace with 40922', async () => {
      const wid = await registerWorkspace(await makeWorkspaceDir());
      const res = await send<null>('POST', `/api/v1/workspaces/${wid}/memories`, {
        scope: 'project',
        type: 'project',
        name: 'project note',
        description: 'requires trust',
        body: 'trusted-only content',
      });
      expect(res.body.code).toBe(40922);
    });

    it('returns 40410 for an unknown workspace', async () => {
      const res = await getJson<null>('/api/v1/workspaces/wd_missing_0123456789ab/memories');
      expect(res.body.code).toBe(40410);
    });
  });

  describe('without the removed persistent-memory experiment env', () => {
    beforeEach(async () => {
      await boot(false);
    });

    it('creates a memory even with the env unset (memory is native)', async () => {
      const wid = await registerWorkspace(await makeWorkspaceDir());
      const res = await send<MemoryWire>('POST', `/api/v1/workspaces/${wid}/memories`, {
        scope: 'workspace',
        type: 'project',
        name: 'x',
        description: 'y',
        body: 'z',
      });
      expect(res.body.code).toBe(0);
      expect(res.body.data.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
    });
  });
});
