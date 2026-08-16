/**
 * `persistentMemory` domain — session close-flush contract.
 *
 * Defines `ISessionMemoryExtractFlushService`, the Session-scoped coordinator
 * that flushes every live agent's automatic memory extraction when the session
 * closes, so queued drafts and the un-mined transcript tail survive close,
 * archive, and teardown instead of being lost with the agent scopes. The
 * implementation registers a bounded `waitUntil` on the session's
 * `onWillCloseSession` and fans out to each agent's `flush()`; the contract
 * exposes the same bounded flush for direct callers and tests.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionMemoryExtractFlushService {
  readonly _serviceBrand: undefined;

  /**
   * Flush every live agent's automatic memory extraction (remaining transcript
   * span + queued drafts). Bounded: never takes longer than the memory-extract
   * timeout overall, and a slow or failing agent is skipped, never awaited.
   */
  flushAll(): Promise<void>;
}

export const ISessionMemoryExtractFlushService: ServiceIdentifier<ISessionMemoryExtractFlushService> =
  createDecorator<ISessionMemoryExtractFlushService>('sessionMemoryExtractFlushService');
