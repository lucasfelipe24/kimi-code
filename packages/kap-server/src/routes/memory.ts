/**
 * `/workspaces/{workspace_id}/memories` route handlers — persistent memory.
 *
 * Exposes durable cross-session memory as a workspace-scoped CRUD surface, so
 * the web/TUI can view and manage memories without an active session:
 *
 *   GET    /workspaces/{workspace_id}/memories                → list
 *   POST   /workspaces/{workspace_id}/memories                → create
 *   PATCH  /workspaces/{workspace_id}/memories/{memory_id}    → update (scope in body)
 *   DELETE /workspaces/{workspace_id}/memories/{memory_id}?scope= → forget
 *
 * Every verb resolves the workspace's live instance
 * (`IWorkspaceInstanceManager.getOrCreate`, materialized on demand) and reads
 * the Workspace-scope `IWorkspaceMemoryCatalog` from its program. Reads use
 * the public read catalog (`list`); writes enter the authorized mutation
 * boundary via `memoryAccessForActor(catalog, 'main')` — the user acting
 * through the app is the main actor. All validation (feature flag, workspace
 * trust, redaction, byte/scope caps, actor scope) stays inside
 * `WorkspaceMemoryCatalogService`; the edge only maps the resulting
 * `MemoryError` onto wire error codes.
 */

import {
  IWorkspaceInstanceManager,
  IWorkspaceService,
  IWorkspaceMemoryCatalog,
  memoryAccessForActor,
  isError2,
  MemoryErrors,
  type EffectiveMemory,
  type MemoryScope,
  type Scope,
} from '@moonshot-ai/agent-core-v2';

import { errEnvelope, okEnvelope } from '../envelope';
import { requestLog } from '../lib/requestLog';
import { defineRoute } from '../middleware/defineRoute';
import { ErrorCode } from '../protocol/error-codes';
import {
  createMemoryRequestSchema,
  deleteMemoryQuerySchema,
  deleteMemoryResponseSchema,
  listMemoriesResponseSchema,
  memoryIdParamSchema,
  memoryRecordSchema,
  updateMemoryRequestSchema,
  type MemoryRecordWire,
} from '../protocol/rest-memory';
import { workspaceIdParamSchema } from '../protocol/rest-workspace';

interface MemoryRouteHost {
  get(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  post(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  patch(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; body: unknown; params: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
  delete(
    path: string,
    options: { preHandler: unknown[]; schema?: Record<string, unknown> },
    handler: (
      req: { id: string; params: unknown; query: unknown },
      reply: { send(payload: unknown): unknown },
    ) => Promise<void> | void,
  ): unknown;
}

type MemoryReply = { send(payload: unknown): unknown };

/**
 * Resolve the workspace's memory catalog, or send a `40410` envelope and
 * return `undefined` when the workspace id is unknown.
 */
async function resolveCatalog(
  core: Scope,
  workspaceId: string,
  requestId: string,
  reply: MemoryReply,
): Promise<IWorkspaceMemoryCatalog | undefined> {
  const ws = await core.accessor.get(IWorkspaceService).get(workspaceId);
  if (ws === undefined) {
    reply.send(
      errEnvelope(
        ErrorCode.WORKSPACE_NOT_FOUND,
        `workspace ${workspaceId} does not exist`,
        requestId,
      ),
    );
    return undefined;
  }
  const instance = await core.accessor
    .get(IWorkspaceInstanceManager)
    .getOrCreate({ workspaceId, root: ws.root });
  const catalog = instance.program.memory;
  await catalog.ready;
  return catalog;
}

export function registerMemoryRoutes(app: MemoryRouteHost, core: Scope): void {
  // GET /workspaces/{workspace_id}/memories -------------------------------
  const listRoute = defineRoute(
    {
      method: 'GET',
      path: '/workspaces/{workspace_id}/memories',
      params: workspaceIdParamSchema,
      success: { data: listMemoriesResponseSchema },
      errors: { [ErrorCode.WORKSPACE_NOT_FOUND]: {} },
      description: 'List the durable memories visible to a workspace',
      tags: ['memory'],
      operationId: 'listMemories',
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const catalog = await resolveCatalog(core, workspace_id, req.id, reply);
      if (catalog === undefined) return;
      const items = (await catalog.list()).map(toWireMemory);
      reply.send(okEnvelope({ items }, req.id));
    },
  );
  app.get(
    listRoute.path,
    listRoute.options,
    listRoute.handler as Parameters<MemoryRouteHost['get']>[2],
  );

  // POST /workspaces/{workspace_id}/memories ------------------------------
  const createRoute = defineRoute(
    {
      method: 'POST',
      path: '/workspaces/{workspace_id}/memories',
      params: workspaceIdParamSchema,
      body: createMemoryRequestSchema,
      success: { data: memoryRecordSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.MEMORY_TRUST_REQUIRED]: {},
        [ErrorCode.MEMORY_CONTENT_REJECTED]: {},
        [ErrorCode.MEMORY_SCOPE_FULL]: {},
        [ErrorCode.MEMORY_BODY_TOO_LARGE]: {},
      },
      description: 'Create a durable memory in a workspace',
      tags: ['memory'],
      operationId: 'createMemory',
    },
    async (req, reply) => {
      const { workspace_id } = req.params;
      const catalog = await resolveCatalog(core, workspace_id, req.id, reply);
      if (catalog === undefined) return;
      const body = req.body as {
        scope: MemoryScope;
        type: EffectiveMemory['type'];
        name: string;
        description: string;
        body: string;
      };
      try {
        const created = await memoryAccessForActor(catalog, 'main').create(body);
        requestLog(req)?.info({ workspace_id, memory_id: created.id }, 'memory created');
        reply.send(okEnvelope(toWireMemory(created), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.post(
    createRoute.path,
    createRoute.options,
    createRoute.handler as Parameters<MemoryRouteHost['post']>[2],
  );

  // PATCH /workspaces/{workspace_id}/memories/{memory_id} -----------------
  const updateRoute = defineRoute(
    {
      method: 'PATCH',
      path: '/workspaces/{workspace_id}/memories/{memory_id}',
      params: memoryIdParamSchema,
      body: updateMemoryRequestSchema,
      success: { data: memoryRecordSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.MEMORY_NOT_FOUND]: {},
        [ErrorCode.MEMORY_TRUST_REQUIRED]: {},
        [ErrorCode.MEMORY_CONTENT_REJECTED]: {},
        [ErrorCode.MEMORY_BODY_TOO_LARGE]: {},
      },
      description: 'Update a durable memory (scope carried in the body)',
      tags: ['memory'],
      operationId: 'updateMemory',
    },
    async (req, reply) => {
      const { workspace_id, memory_id } = req.params as { workspace_id: string; memory_id: string };
      const catalog = await resolveCatalog(core, workspace_id, req.id, reply);
      if (catalog === undefined) return;
      const body = req.body as {
        scope: MemoryScope;
        type?: EffectiveMemory['type'];
        name?: string;
        description?: string;
        body?: string;
      };
      const { scope, ...patch } = body;
      try {
        const updated = await memoryAccessForActor(catalog, 'main').update(scope, memory_id, patch);
        requestLog(req)?.info({ workspace_id, memory_id }, 'memory updated');
        reply.send(okEnvelope(toWireMemory(updated), req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.patch(
    updateRoute.path,
    updateRoute.options,
    updateRoute.handler as Parameters<MemoryRouteHost['patch']>[2],
  );

  // DELETE /workspaces/{workspace_id}/memories/{memory_id}?scope= ---------
  const deleteRoute = defineRoute(
    {
      method: 'DELETE',
      path: '/workspaces/{workspace_id}/memories/{memory_id}',
      params: memoryIdParamSchema,
      querystring: deleteMemoryQuerySchema,
      success: { data: deleteMemoryResponseSchema },
      errors: {
        [ErrorCode.VALIDATION_FAILED]: {},
        [ErrorCode.WORKSPACE_NOT_FOUND]: {},
        [ErrorCode.MEMORY_TRUST_REQUIRED]: {},
      },
      description: 'Forget a durable memory',
      tags: ['memory'],
      operationId: 'forgetMemory',
    },
    async (req, reply) => {
      const { workspace_id, memory_id } = req.params as { workspace_id: string; memory_id: string };
      const { scope } = req.query as { scope: MemoryScope };
      const catalog = await resolveCatalog(core, workspace_id, req.id, reply);
      if (catalog === undefined) return;
      try {
        await memoryAccessForActor(catalog, 'main').forget(scope, memory_id);
        requestLog(req)?.info({ workspace_id, memory_id }, 'memory forgotten');
        reply.send(okEnvelope({ deleted: true as const }, req.id));
      } catch (error) {
        sendMappedError(reply, req.id, error);
      }
    },
  );
  app.delete(
    deleteRoute.path,
    deleteRoute.options,
    deleteRoute.handler as Parameters<MemoryRouteHost['delete']>[2],
  );
}

// ---------------------------------------------------------------------------
// Projection — engine `EffectiveMemory` → wire `memoryRecordSchema`.
// ---------------------------------------------------------------------------

function toWireMemory(record: EffectiveMemory): MemoryRecordWire {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    type: record.type,
    scope: record.scope,
    origin: record.origin,
    created_at: new Date(record.createdAt).toISOString(),
    updated_at: new Date(record.updatedAt).toISOString(),
    version: record.version,
    body: record.body,
  };
}

// ---------------------------------------------------------------------------
// Error mapping — `MemoryError` (Error2) → wire envelope codes.
// ---------------------------------------------------------------------------

function sendMappedError(reply: MemoryReply, requestId: string, err: unknown): void {
  if (isError2(err)) {
    switch (err.code) {
      case MemoryErrors.codes.MEMORY_NOT_FOUND:
        reply.send(errEnvelope(ErrorCode.MEMORY_NOT_FOUND, err.message, requestId, err.stack));
        return;
      case MemoryErrors.codes.MEMORY_TRUST_REQUIRED:
        reply.send(errEnvelope(ErrorCode.MEMORY_TRUST_REQUIRED, err.message, requestId, err.stack));
        return;
      case MemoryErrors.codes.MEMORY_CONTENT_REJECTED:
        reply.send(
          errEnvelope(ErrorCode.MEMORY_CONTENT_REJECTED, err.message, requestId, err.stack),
        );
        return;
      case MemoryErrors.codes.MEMORY_SCOPE_FULL:
        reply.send(errEnvelope(ErrorCode.MEMORY_SCOPE_FULL, err.message, requestId, err.stack));
        return;
      case MemoryErrors.codes.MEMORY_BODY_TOO_LARGE:
        reply.send(errEnvelope(ErrorCode.MEMORY_BODY_TOO_LARGE, err.message, requestId, err.stack));
        return;
      case MemoryErrors.codes.MEMORY_INVALID_ID:
      case MemoryErrors.codes.MEMORY_INVALID_SCOPE:
      case MemoryErrors.codes.MEMORY_INVALID_RECORD:
        reply.send(errEnvelope(ErrorCode.VALIDATION_FAILED, err.message, requestId, err.stack));
        return;
    }
  }
  throw err;
}
