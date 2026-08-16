/**
 * `tools` domain — `IMemoryTool` implementation (the `Memory` tool).
 *
 * The LLM-facing typed surface over durable cross-session memory: validates the
 * discriminated input, then remembers / forgets / lists through the Session
 * seed `ISessionMemoryAccess` (never the Workspace catalog directly, keeping
 * the Agent scope decoupled from the Workspace). The seed is already
 * actor-bound (main vs subagent) by the Workspace catalog, so the cross-scope
 * escalation invariant — only the main agent may write or forget `user`
 * memory, subagents are limited to `workspace`/`project` — plus secret
 * redaction, content rejection, write caps and the trust gate are all enforced
 * behind that access at the catalog boundary; the tool stays actor-agnostic and
 * lets those rejections surface as tool errors. Emits content-free
 * `memory_write` / `memory_forget` telemetry through `telemetry`.
 *
 * Registered via the module-level `registerAgentToolService(IMemoryTool,
 * MemoryTool)` at the bottom of this file. Persistent memory is a native v2
 * capability, so the tool is always available (no flag gate). Bound at Agent
 * scope.
 */

import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { MemoryErrors } from '#/app/persistentMemory/errors';
import { MemoryError } from '#/app/persistentMemory/memoryStore';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionMemoryAccess } from '#/session/persistentMemory/memorySeed';

import {
  IMemoryTool,
  MEMORY_TOOL_NAME,
  MemoryToolAdvertisedSchema,
  MemoryToolInputSchema,
  type MemoryToolInput,
} from './memory';

import MEMORY_DESCRIPTION from './memory.md?raw';

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  [MemoryErrors.codes.MEMORY_INVALID_ID]: 'memory error: invalid memory id',
  [MemoryErrors.codes.MEMORY_INVALID_SCOPE]: 'memory error: invalid memory scope',
  [MemoryErrors.codes.MEMORY_INVALID_RECORD]: 'memory error: invalid memory record',
  [MemoryErrors.codes.MEMORY_BODY_TOO_LARGE]: 'memory error: memory body is too large',
  [MemoryErrors.codes.MEMORY_SCOPE_FULL]: 'memory error: memory scope is full',
  [MemoryErrors.codes.MEMORY_VERSION_CONFLICT]: 'memory error: memory version conflict',
  [MemoryErrors.codes.MEMORY_TRUST_REQUIRED]: 'memory error: trusted workspace required',
  [MemoryErrors.codes.MEMORY_NOT_FOUND]: 'memory error: memory not found',
  [MemoryErrors.codes.MEMORY_MUTATION_DENIED]: 'memory error: memory mutation denied',
  [MemoryErrors.codes.MEMORY_CONTENT_REJECTED]: 'memory error: memory content rejected',
};

function memoryErrorMessage(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return typeof code === 'string'
    ? (ERROR_MESSAGES[code] ?? 'memory error: memory operation failed')
    : 'memory error: memory operation failed';
}

export class MemoryTool implements IMemoryTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = MEMORY_TOOL_NAME;
  readonly description: string = MEMORY_DESCRIPTION;
  // Advertise the flat schema (providers cannot fill a bare top-level union);
  // the strict per-action union is still enforced in `resolveExecution`.
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MemoryToolAdvertisedSchema);

  constructor(
    @ISessionMemoryAccess private readonly access: ISessionMemoryAccess,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  resolveExecution(args: MemoryToolInput): ToolExecution {
    const parsed = MemoryToolInputSchema.safeParse(args);
    if (!parsed.success) {
      // Reject malformed input (bad ULID, unknown action, oversized fields)
      // before touching the store — the id validation is the traversal
      // contention, so nothing reaches the fs on an invalid call.
      return { output: `memory error: invalid input`, isError: true };
    }
    const input = parsed.data;
    return {
      description: `Memory ${input.action}`,
      accesses: ToolAccesses.none(),
      display: this.display(input),
      approvalRule: this.name,
      execute: (ctx) => this.execution(input, ctx.signal),
    };
  }

  private display(input: MemoryToolInput): ToolInputDisplay {
    switch (input.action) {
      case 'remember':
        return { kind: 'generic', summary: `Remember "${input.name}" (${input.scope})` };
      case 'forget':
        return { kind: 'generic', summary: `Forget memory (${input.scope})` };
      case 'list':
        return {
          kind: 'generic',
          summary: input.scope === undefined ? 'List memories' : `List memories (${input.scope})`,
        };
    }
  }

  private async execution(
    input: MemoryToolInput,
    signal: AbortSignal,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      switch (input.action) {
        case 'remember':
          return await this.remember(input);
        case 'forget':
          return await this.forget(input);
        case 'list':
          return await this.list(input);
      }
    } catch (error) {
      return { output: memoryErrorMessage(error), isError: true };
    }
  }

  private async remember(
    input: Extract<MemoryToolInput, { action: 'remember' }>,
  ): Promise<ExecutableToolResult> {
    try {
      const created = await this.access.create({
        scope: input.scope,
        type: input.type,
        name: input.name,
        description: input.description,
        body: input.body,
      });
      this.telemetry.track2('memory_write', {
        scope: input.scope,
        type: input.type,
        outcome: 'success',
      });
      return {
        output: JSON.stringify(
          { id: created.id, scope: created.origin, type: created.type },
          null,
          2,
        ),
      };
    } catch (error) {
      this.telemetry.track2('memory_write', {
        scope: input.scope,
        type: input.type,
        outcome: error instanceof MemoryError ? 'rejected' : 'error',
      });
      throw error;
    }
  }

  private async forget(
    input: Extract<MemoryToolInput, { action: 'forget' }>,
  ): Promise<ExecutableToolResult> {
    try {
      const existing = await this.access.list();
      const located = existing.find(
        (memory) => memory.id === input.id && memory.origin === input.scope,
      );
      await this.access.forget(input.scope, input.id);
      this.telemetry.track2('memory_forget', {
        scope: input.scope,
        outcome: located === undefined ? 'not_found' : 'success',
      });
      return { output: JSON.stringify({ id: input.id, forgotten: true }, null, 2) };
    } catch (error) {
      this.telemetry.track2('memory_forget', {
        scope: input.scope,
        outcome: error instanceof MemoryError ? 'rejected' : 'error',
      });
      throw error;
    }
  }

  private async list(
    input: Extract<MemoryToolInput, { action: 'list' }>,
  ): Promise<ExecutableToolResult> {
    const memories = await this.access.list();
    const filtered =
      input.scope === undefined
        ? memories
        : memories.filter((memory) => memory.origin === input.scope);
    const projected = filtered.map((memory) => ({
      id: memory.id,
      name: memory.name,
      description: memory.description,
      type: memory.type,
      scope: memory.origin,
      updatedAt: memory.updatedAt,
    }));
    return { output: JSON.stringify({ memories: projected }, null, 2) };
  }
}

registerAgentToolService(IMemoryTool, MemoryTool, {
  name: MEMORY_TOOL_NAME,
  domain: 'persistentMemory',
});
