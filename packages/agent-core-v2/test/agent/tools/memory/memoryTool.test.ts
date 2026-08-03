import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import type { ExecutableToolContext, RunnableToolExecution } from '#/tool/toolContract';
import { DEFAULT_MEMORY_MAX_BODY_BYTES, MemoryError } from '#/app/persistentMemory/memoryStore';
import { MemoryErrors } from '#/app/persistentMemory/errors';
import { looksLikeSecret, redactMemoryBody } from '#/app/persistentMemory/redact';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { TelemetryProperties } from '#/app/telemetry/telemetry';
import type {
  EffectiveMemory,
  MemoryCreateInput,
  MemoryPatch,
} from '#/workspace/persistentMemory/memoryCatalog';
import type { MemoryMutationActor } from '#/workspace/persistentMemory/memoryCatalogMutation';
import { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';

import { IMemoryTool, MEMORY_TOOL_NAME } from '#/agent/tools/memory/memory';
import { MemoryTool } from '#/agent/tools/memory/memoryTool';

function ctx(): ExecutableToolContext {
  return { turnId: 1, toolCallId: 'call_1', signal: new AbortController().signal };
}

interface TrackedEvent {
  readonly name: string;
  readonly properties: TelemetryProperties | undefined;
}

/** Minimal in-memory `ISessionMemoryAccess`, used to observe writes/forgets. */
class FakeMemoryAccess implements ISessionMemoryAccess {
  declare readonly _serviceBrand: undefined;
  readonly ready = Promise.resolve();
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  readonly records = new Map<string, EffectiveMemory>();
  readonly createCalls: MemoryCreateInput[] = [];
  readonly forgetCalls: { scope: string; id: string }[] = [];

  createError: MemoryError | undefined;

  // The real `ISessionMemoryAccess` is actor-bound: the Workspace catalog wraps
  // it per main/subagent, so cross-scope escalation is rejected before any
  // mutation reaches the store. Modeling `actor` here lets the tool tests
  // exercise that boundary without wiring the full catalog.
  actor: MemoryMutationActor = 'main';

  list(): Promise<readonly EffectiveMemory[]> {
    return Promise.resolve([...this.records.values()]);
  }

  create(input: MemoryCreateInput): Promise<EffectiveMemory> {
    if (this.actor === 'subagent' && input.scope === 'user') {
      return Promise.reject(
        new MemoryError(MemoryErrors.codes.MEMORY_MUTATION_DENIED, 'subagent cannot write user'),
      );
    }
    // The Workspace catalog redacts secret-shaped substrings from name /
    // description / body and rejects residual secrets before persistence
    // (`memoryCatalogService.ts` `sanitizeContent`). The tool calls that
    // actor-bound access, so the stub applies the same sanitization to record
    // what actually reaches the store.
    const sanitized: MemoryCreateInput = {
      ...input,
      name: redactMemoryBody(input.name),
      description: redactMemoryBody(input.description),
      body: redactMemoryBody(input.body),
    };
    if (
      looksLikeSecret(sanitized.name) ||
      looksLikeSecret(sanitized.description) ||
      looksLikeSecret(sanitized.body)
    ) {
      return Promise.reject(
        new MemoryError(MemoryErrors.codes.MEMORY_CONTENT_REJECTED, 'memory content rejected'),
      );
    }
    this.createCalls.push(sanitized);
    if (this.createError !== undefined) return Promise.reject(this.createError);
    const now = Date.now();
    const record: EffectiveMemory = {
      id: ulid(),
      name: sanitized.name,
      description: sanitized.description,
      type: sanitized.type,
      scope: sanitized.scope,
      origin: sanitized.scope,
      createdAt: now,
      updatedAt: now,
      version: 1,
      body: sanitized.body,
    };
    this.records.set(record.id, record);
    this.changeEmitter.fire();
    return Promise.resolve(record);
  }

  update(_scope: string, _id: string, _patch: MemoryPatch): Promise<EffectiveMemory> {
    return Promise.reject(new Error('not used'));
  }

  forget(scope: string, id: string): Promise<void> {
    this.forgetCalls.push({ scope, id });
    const record = this.records.get(id);
    // Scope-aware: only delete when the declared scope matches the record.
    if (record !== undefined && record.origin === scope) this.records.delete(id);
    this.changeEmitter.fire();
    return Promise.resolve();
  }

  seed(record: EffectiveMemory): void {
    this.records.set(record.id, record);
  }
}

function effective(overrides: Partial<EffectiveMemory> & { id: string }): EffectiveMemory {
  const now = Date.now();
  return {
    name: 'seed',
    description: 'seed memory',
    type: 'reference',
    scope: 'workspace',
    origin: 'workspace',
    createdAt: now,
    updatedAt: now,
    version: 1,
    body: 'seed body',
    ...overrides,
  };
}

describe('MemoryTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let access: FakeMemoryAccess;
  let tracked: TrackedEvent[];

  function build(): void {
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(ISessionMemoryAccess, access);
        reg.definePartialInstance(ITelemetryService, {
          track2: (name, properties) => {
            tracked.push({ name, properties: properties as TelemetryProperties | undefined });
          },
        });
        reg.define(IMemoryTool, MemoryTool);
      },
    });
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    access = new FakeMemoryAccess();
    tracked = [];
    build();
  });
  afterEach(() => disposables.dispose());

  it('is registered as a native tool without a flag gate', () => {
    const contribution = getAgentToolContributions().find(
      (entry) => entry.options.name === MEMORY_TOOL_NAME,
    );
    expect(contribution).toBeDefined();
    // Persistent memory is native — no `when` predicate gates the tool.
    expect(contribution!.options.when).toBeUndefined();
  });

  it('advertises a flat, provider-fillable object schema', () => {
    const tool = ix.get(IMemoryTool);
    const params = tool.parameters as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    // A bare top-level union renders as `oneOf` with no `properties`, which
    // providers cannot fill — the advertised schema must be a flat object.
    expect(params.type).toBe('object');
    expect(Object.keys(params.properties ?? {})).toEqual(
      expect.arrayContaining(['action', 'scope', 'type', 'name', 'description', 'body', 'id']),
    );
    expect(params.required).toEqual(['action']);
  });

  it('still rejects a per-action-invalid combination at execution time', () => {
    const tool = ix.get(IMemoryTool);
    // `remember` requires a body; the flat schema allows omitting it, but the
    // strict union in resolveExecution must reject it.
    const execution = tool.resolveExecution({
      action: 'remember',
      scope: 'workspace',
      type: 'reference',
      name: 'n',
      description: 'd',
    } as never);
    expect('execute' in execution).toBe(false);
    expect((execution as { isError?: boolean }).isError).toBe(true);
  });

  it('remember writes a memory and returns its id', async () => {
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({
      action: 'remember',
      scope: 'workspace',
      type: 'reference',
      name: 'build command',
      description: 'how to build',
      body: 'pnpm build',
    });
    expect('execute' in execution).toBe(true);
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(access.createCalls).toHaveLength(1);
    expect(access.createCalls[0]?.body).toBe('pnpm build');
    expect(tracked.map((event) => event.name)).toContain('memory_write');
  });

  it('forget removes a memory in the declared scope', async () => {
    const id = ulid();
    access.seed(effective({ id, scope: 'workspace', origin: 'workspace' }));
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({ action: 'forget', scope: 'workspace', id });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(access.forgetCalls).toEqual([{ scope: 'workspace', id }]);
  });

  it('forget of an unknown id is idempotent (no error, no throw)', async () => {
    const id = ulid();
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({ action: 'forget', scope: 'workspace', id });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    const forget = tracked.find((event) => event.name === 'memory_forget');
    expect(forget?.properties?.['outcome']).toBe('not_found');
  });

  it('remember repeated stays consistent (each call writes)', async () => {
    const tool = ix.get(IMemoryTool);
    const input = {
      action: 'remember' as const,
      scope: 'workspace' as const,
      type: 'reference' as const,
      name: 'note',
      description: 'a note',
      body: 'content',
    };
    await (ix.get(IMemoryTool).resolveExecution(input) as RunnableToolExecution).execute(ctx());
    await (tool.resolveExecution(input) as RunnableToolExecution).execute(ctx());
    expect(access.createCalls).toHaveLength(2);
  });

  it('list projects the effective view without body/paths', async () => {
    access.seed(
      effective({ id: ulid(), name: 'A', description: 'first', body: 'secret-body-A' }),
    );
    access.seed(
      effective({ id: ulid(), name: 'B', description: 'second', body: 'secret-body-B' }),
    );
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({ action: 'list' });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output as string) as {
      memories: { id: string; name: string }[];
    };
    expect(parsed.memories).toHaveLength(2);
    // list output intentionally carries name/description (returned to the model),
    // but must not carry body content.
    expect(result.output).not.toContain('secret-body-A');
  });

  it('rejects invalid input without mutating', async () => {
    const tool = ix.get(IMemoryTool);
    // Unknown action.
    const execution = tool.resolveExecution({ action: 'bogus' } as never);
    expect('execute' in execution).toBe(false);
    expect((execution as { isError?: boolean }).isError).toBe(true);
    expect(access.createCalls).toEqual([]);
    expect(access.forgetCalls).toEqual([]);
  });

  it('rejects a traversal / non-ULID id without touching the store', async () => {
    const tool = ix.get(IMemoryTool);
    for (const id of ['../etc/passwd', 'a\0b', '%2e%2e', 'not-a-ulid']) {
      const execution = tool.resolveExecution({
        action: 'forget',
        scope: 'workspace',
        id,
      } as never);
      expect('execute' in execution).toBe(false);
      expect((execution as { isError?: boolean }).isError).toBe(true);
    }
    expect(access.forgetCalls).toEqual([]);
  });

  it('refuses a subagent writing user-scope memory (escalation)', async () => {
    access.actor = 'subagent';
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({
      action: 'remember',
      scope: 'user',
      type: 'user',
      name: 'pref',
      description: 'a preference',
      body: 'prefers tabs',
    });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBe(true);
    expect(access.createCalls).toEqual([]);
    const write = tracked.find((event) => event.name === 'memory_write');
    expect(write?.properties?.['outcome']).toBe('rejected');
  });

  it('allows the main agent to write user-scope memory', async () => {
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({
      action: 'remember',
      scope: 'user',
      type: 'user',
      name: 'pref',
      description: 'a preference',
      body: 'prefers tabs',
    });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(access.createCalls).toHaveLength(1);
  });

  it('scope-aware forget cannot delete a higher-trust record via a mismatched scope', async () => {
    const id = ulid();
    access.seed(effective({ id, scope: 'user', origin: 'user' }));
    const tool = ix.get(IMemoryTool);
    // Declaring `workspace` for a `user`-origin id is a safe no-op: the catalog
    // deletes only from the declared scope's store, so the user record survives.
    const execution = tool.resolveExecution({ action: 'forget', scope: 'workspace', id });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    // The forget was routed to the workspace scope only; the user record remains.
    expect(access.forgetCalls).toEqual([{ scope: 'workspace', id }]);
    expect(access.records.has(id)).toBe(true);
    // Telemetry reports not_found because nothing matched in the declared scope.
    const forget = tracked.find((event) => event.name === 'memory_forget');
    expect(forget?.properties?.['outcome']).toBe('not_found');
  });

  it('propagates the trust gate error as a tool error', async () => {
    access.createError = new MemoryError(
      MemoryErrors.codes.MEMORY_TRUST_REQUIRED,
      'project memory requires a trusted workspace',
    );
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({
      action: 'remember',
      scope: 'project',
      type: 'project',
      name: 'p',
      description: 'q',
      body: 'r',
    });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('trusted workspace');
    const write = tracked.find((event) => event.name === 'memory_write');
    expect(write?.properties?.['outcome']).toBe('rejected');
  });

  it('redacts secrets from body AND description (and name) before create', async () => {
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({
      action: 'remember',
      scope: 'workspace',
      type: 'reference',
      name: 'token ghp_abcdefghijklmnopqrstuvwxyz012345',
      description: 'call with api_key=SUPERSECRETVALUE to authenticate',
      body: [
        'key sk-ABC123DEF456GHI789',
        'Authorization: Bearer abcdef.token.value',
        '-----BEGIN PRIVATE KEY-----',
        'MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
    });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(access.createCalls).toHaveLength(1);
    const created = access.createCalls[0]!;

    // body: none of the secret shapes survive.
    expect(created.body).not.toContain('sk-ABC123DEF456GHI789');
    expect(created.body).not.toContain('abcdef.token.value');
    expect(created.body).not.toContain('MIIBVAIBADANBgkqhkiG9w0BAQEFAASCAT4wggE6AgEAAkEA');
    expect(created.body).toContain('[redacted]');

    // description: the `api_key=…` assignment is redacted.
    expect(created.description).not.toContain('SUPERSECRETVALUE');
    expect(created.description).toContain('[redacted]');

    // name: the GitHub token is redacted.
    expect(created.name).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz012345');
    expect(created.name).toContain('[redacted]');
  });

  it('accepts a body at the cap and rejects one above it without mutating', async () => {
    const tool = ix.get(IMemoryTool);

    // NOTE (char vs byte cap): the tool schema's `.max()` counts UTF-16 code
    // units, while the store enforces UTF-8 bytes. With ASCII these coincide, so
    // this test exercises the schema boundary using single-byte characters.
    const atCap = 'a'.repeat(DEFAULT_MEMORY_MAX_BODY_BYTES);
    const atExecution = tool.resolveExecution({
      action: 'remember',
      scope: 'workspace',
      type: 'reference',
      name: 'n',
      description: 'd',
      body: atCap,
    });
    expect('execute' in atExecution).toBe(true);
    const atResult = await (atExecution as RunnableToolExecution).execute(ctx());
    expect(atResult.isError).toBeUndefined();
    expect(access.createCalls).toHaveLength(1);

    const overCap = 'a'.repeat(DEFAULT_MEMORY_MAX_BODY_BYTES + 1);
    const overExecution = tool.resolveExecution({
      action: 'remember',
      scope: 'workspace',
      type: 'reference',
      name: 'n',
      description: 'd',
      body: overCap,
    });
    // Over-cap input is rejected at the schema boundary (resolveExecution),
    // before any store call — createCalls stays at the single prior write.
    expect('execute' in overExecution).toBe(false);
    expect((overExecution as { isError?: boolean }).isError).toBe(true);
    expect(access.createCalls).toHaveLength(1);
  });

  it('list({ scope }) projects only the requested origin', async () => {
    access.seed(effective({ id: ulid(), name: 'U', scope: 'user', origin: 'user' }));
    access.seed(
      effective({ id: ulid(), name: 'W', scope: 'workspace', origin: 'workspace' }),
    );
    access.seed(effective({ id: ulid(), name: 'P', scope: 'project', origin: 'project' }));
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({ action: 'list', scope: 'workspace' });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.output as string) as {
      memories: { name: string; scope: string }[];
    };
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0]?.name).toBe('W');
    expect(parsed.memories[0]?.scope).toBe('workspace');
  });

  it('emits a content-free memory_write even when the write is rejected/errors', async () => {
    access.createError = new MemoryError(
      MemoryErrors.codes.MEMORY_TRUST_REQUIRED,
      'project memory requires a trusted workspace',
    );
    const secret = 'super-secret-body-value';
    const tool = ix.get(IMemoryTool);
    await (
      tool.resolveExecution({
        action: 'remember',
        scope: 'project',
        type: 'project',
        name: 'secret-name-xyz',
        description: 'secret-description-xyz',
        body: secret,
      }) as RunnableToolExecution
    ).execute(ctx());

    const allowedKeys = new Set(['scope', 'type', 'outcome']);
    const write = tracked.find((event) => event.name === 'memory_write');
    expect(write?.properties?.['outcome']).toBe('rejected');
    for (const event of tracked) {
      for (const [key, value] of Object.entries(event.properties ?? {})) {
        expect(allowedKeys.has(key), `unexpected telemetry key ${key}`).toBe(true);
        expect(String(value)).not.toContain(secret);
        expect(String(value)).not.toContain('secret-name-xyz');
        expect(String(value)).not.toContain('secret-description-xyz');
      }
    }
  });

  it('lets a subagent write workspace-scope memory (restriction is not over-broad)', async () => {
    access.actor = 'subagent';
    const tool = ix.get(IMemoryTool);
    const execution = tool.resolveExecution({
      action: 'remember',
      scope: 'workspace',
      type: 'reference',
      name: 'shared note',
      description: 'a workspace note',
      body: 'content',
    });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(access.createCalls).toHaveLength(1);
    expect(access.createCalls[0]?.scope).toBe('workspace');
  });

  it('never emits content (name/description/body/path) in telemetry', async () => {
    const secret = 'super-secret-body-value';
    const tool = ix.get(IMemoryTool);
    await (
      tool.resolveExecution({
        action: 'remember',
        scope: 'workspace',
        type: 'reference',
        name: 'secret-name-xyz',
        description: 'secret-description-xyz',
        body: secret,
      }) as RunnableToolExecution
    ).execute(ctx());

    const allowedKeys = new Set(['scope', 'type', 'outcome']);
    expect(tracked.length).toBeGreaterThan(0);
    for (const event of tracked) {
      const properties = event.properties ?? {};
      for (const [key, value] of Object.entries(properties)) {
        expect(allowedKeys.has(key), `unexpected telemetry key ${key}`).toBe(true);
        expect(String(value)).not.toContain(secret);
        expect(String(value)).not.toContain('secret-name-xyz');
        expect(String(value)).not.toContain('secret-description-xyz');
      }
    }
  });
});
