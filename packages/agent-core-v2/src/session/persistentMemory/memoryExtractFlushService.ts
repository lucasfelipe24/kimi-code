/**
 * `persistentMemory` domain — `ISessionMemoryExtractFlushService` implementation.
 *
 * Registers a bounded `waitUntil` on the session's `onWillCloseSession` (via
 * the App-scope `ISessionManager`, which forwards the workspace controller's
 * event) so a close awaits a flush of every live agent's automatic memory
 * extraction before the agents are drained. The flush fans out to each agent's
 * `IAgentMemoryExtractService.flush()` in parallel and is bounded, so a slow
 * model call can never block session close beyond the memory-extract timeout.
 * Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { registerScopedService, ScopeActivation } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import {
  DEFAULT_MEMORY_EXTRACT_TIMEOUT_MS,
  IAgentMemoryExtractService,
} from '#/agent/memoryExtract/memoryExtract';
import { ISessionManager } from '#/app/sessionManager/sessionManager';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';

import { ISessionMemoryExtractFlushService } from './memoryExtractFlush';

export class SessionMemoryExtractFlushService
  extends Disposable
  implements ISessionMemoryExtractFlushService
{
  declare readonly _serviceBrand: undefined;

  /** Wall-clock bound (ms) for `flushAll`; shrunken by tests. */
  private timeoutMs = DEFAULT_MEMORY_EXTRACT_TIMEOUT_MS;

  constructor(
    @ISessionContext private readonly context: ISessionContext,
    @ISessionManager sessionManager: ISessionManager,
    @IAgentLifecycleService private readonly agents: IAgentLifecycleService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    const onWillClose = sessionManager.onWillCloseSession;
    if (onWillClose !== undefined) {
      this._register(
        onWillClose((event) => {
          if (event.sessionId !== this.context.sessionId) return;
          event.waitUntil(this.flushAll());
        }),
      );
    }
  }

  /** Test seam: shrink the flush bound so the timeout path is fast. */
  setTimeoutForTests(ms: number): void {
    this.timeoutMs = ms;
  }

  async flushAll(): Promise<void> {
    const flush = Promise.all(
      this.agents.list().map(async (agent) => {
        try {
          await agent.accessor.get(IAgentMemoryExtractService).flush();
        } catch {
          this.log.debug(`memory extract: close flush failed for agent ${agent.id}`);
        }
      }),
    );
    // Bound the wait so session close is never blocked beyond the extract
    // timeout even if an agent's flush hangs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.timeoutMs);
    });
    try {
      await Promise.race([flush, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionMemoryExtractFlushService,
  SessionMemoryExtractFlushService,
  ScopeActivation.OnScopeCreated,
  'persistentMemory',
);
