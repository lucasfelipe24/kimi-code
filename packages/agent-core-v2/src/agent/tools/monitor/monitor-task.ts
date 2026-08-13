/**
 * `tools` domain — `MonitorTask` process adapter.
 *
 * Observes stdout as a bounded, line-framed event stream while retaining both
 * stdout and stderr in the task output log. Uses `IAgentTaskSink` for event
 * delivery and is bound indirectly through `AgentTaskService` at Agent scope.
 */

import type { Readable } from 'node:stream';

import type { IProcess } from '#/session/process/processRunner';
import type {
  AgentTask,
  AgentTaskInfoBase,
  AgentTaskSink,
  AgentTaskSettlement,
} from '#/agent/task/types';
import {
  createPrematureCloseError,
  errorMessage,
  observeProcessStream,
  waitForStreamDrain,
} from '#/agent/tools/os/bash/process-task';

export interface MonitorTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'monitor';
  readonly command: string;
  readonly monitorKind: 'log' | 'poll' | 'watch' | 'other';
  readonly pid: number;
  readonly exitCode: number | null;
  readonly persistent: boolean;
  readonly eventCount: number;
}

declare module '#/agent/task/types' {
  interface AgentTaskInfoByKind {
    readonly monitor: MonitorTaskInfo;
  }
}

const MONITOR_NOTIFICATION_LINE_MAX_BYTES = 16 * 1024;
const MONITOR_NOTIFICATION_LINE_MAX_LINES = 20;
const PERSISTENT_MONITOR_DEBOUNCE_MS = 250;

export class MonitorTask implements AgentTask {
  readonly kind = 'monitor' as const;
  readonly idPrefix = 'monitor';
  private exitCode: number | null = null;
  private eventCount = 0;
  private latestLine: string | undefined;
  private coalescedCount = 0;
  private sequence = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly proc: IProcess,
    readonly command: string,
    readonly monitorKind: MonitorTaskInfo['monitorKind'],
    readonly description: string,
    readonly persistent: boolean,
  ) {}

  async start(sink: AgentTaskSink): Promise<void> {
    const streamDrained = Promise.all([
      observeStdoutLines(this.proc.stdout, sink, (line) => {
        this.onRawLine(line, sink);
      }),
      observeProcessStream(this.proc.stderr, 'stderr', sink),
    ]).then(() => undefined);
    void streamDrained.catch(() => {});

    const requestStop = (): void => {
      void this.proc.kill('SIGTERM').catch(() => {});
    };
    if (sink.signal.aborted) {
      requestStop();
    } else {
      sink.signal.addEventListener('abort', requestStop, { once: true });
    }

    let settlement: AgentTaskSettlement;
    try {
      const exitCode = await this.proc.wait();
      await waitForStreamDrain(streamDrained);
      this.flushPersistentNotification(sink);
      this.exitCode = exitCode;
      settlement = {
        status: sink.signal.aborted ? 'killed' : exitCode === 0 ? 'completed' : 'failed',
      };
    } catch (error: unknown) {
      try {
        await waitForStreamDrain(streamDrained);
      } catch {
      }
      this.flushPersistentNotification(sink);
      this.exitCode = this.proc.exitCode;
      settlement = {
        status: sink.signal.aborted ? 'killed' : 'failed',
        stopReason: sink.signal.aborted ? undefined : errorMessage(error),
      };
    } finally {
      sink.signal.removeEventListener('abort', requestStop);
      this.clearFlushTimer();
      await this.disposeProcess();
    }
    await sink.settle(settlement);
  }

  async forceStop(): Promise<void> {
    try {
      if (this.proc.exitCode === null) {
        await this.proc.kill('SIGKILL');
      }
    } finally {
      this.clearFlushTimer();
      await this.disposeProcess();
    }
  }

  toInfo(base: AgentTaskInfoBase): MonitorTaskInfo {
    return {
      ...base,
      kind: 'monitor',
      command: this.command,
      monitorKind: this.monitorKind,
      pid: this.proc.pid,
      exitCode: this.exitCode,
      persistent: this.persistent,
      eventCount: this.eventCount,
    };
  }

  private onRawLine(line: string, sink: AgentTaskSink): void {
    if (sink.signal.aborted) return;
    const truncated = truncateMonitorLine(line);
    if (!this.persistent) {
      if (this.eventCount !== 0) return;
      this.eventCount = 1;
      sink.notifyEvent?.(truncated, { notificationId: '0', coalescedCount: 0 });
      void this.proc.kill('SIGTERM').catch(() => {});
      return;
    }

    this.latestLine = truncated;
    this.sequence += 1;
    if (this.flushTimer !== undefined) {
      this.coalescedCount += 1;
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushPersistentNotification(sink);
    }, PERSISTENT_MONITOR_DEBOUNCE_MS);
    this.flushTimer.unref?.();
  }

  private flushPersistentNotification(sink: AgentTaskSink): void {
    if (!this.persistent || this.latestLine === undefined) return;
    const line = this.latestLine;
    const coalescedCount = this.coalescedCount;
    const notificationId = String(this.sequence);
    this.latestLine = undefined;
    this.coalescedCount = 0;
    this.clearFlushTimer();
    sink.notifyEvent?.(line, { notificationId, coalescedCount });
    this.eventCount += 1;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private async disposeProcess(): Promise<void> {
    try {
      await this.proc.dispose();
    } catch {
    }
  }
}

function observeStdoutLines(
  stream: Readable,
  sink: AgentTaskSink,
  onLine: (line: string) => void,
): Promise<void> {
  stream.setEncoding('utf8');
  let lineBuffer = '';
  const onData = (chunk: string): void => {
    if (chunk.length === 0) return;
    sink.appendOutput(chunk);
    if (sink.signal.aborted) return;
    lineBuffer += chunk;
    let newlineIndex = lineBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = lineBuffer.slice(0, newlineIndex).replace(/\r$/, '');
      lineBuffer = lineBuffer.slice(newlineIndex + 1);
      onLine(line);
      newlineIndex = lineBuffer.indexOf('\n');
    }
  };
  stream.on('data', onData);

  return new Promise<void>((resolve, reject) => {
    let ended = false;
    const cleanup = (): void => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    };
    const done = (): void => {
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    const onEnd = (): void => {
      ended = true;
      done();
    };
    const onClose = (): void => {
      if (ended || sink.signal.aborted) {
        done();
      } else {
        fail(createPrematureCloseError());
      }
    };
    const onError = (error: Error): void => {
      if (sink.signal.aborted) done();
      else fail(error);
    };
    stream.once('end', onEnd);
    stream.once('close', onClose);
    stream.once('error', onError);
  });
}

function truncateMonitorLine(line: string): string {
  const totalBytes = Buffer.byteLength(line, 'utf8');
  const lines = line.split('\n');
  const tooManyLines = lines.length > MONITOR_NOTIFICATION_LINE_MAX_LINES;
  if (totalBytes <= MONITOR_NOTIFICATION_LINE_MAX_BYTES && !tooManyLines) return line;

  let tail = tooManyLines
    ? lines.slice(-MONITOR_NOTIFICATION_LINE_MAX_LINES).join('\n')
    : line;
  let tailBytes = Buffer.byteLength(tail, 'utf8');
  if (tailBytes > MONITOR_NOTIFICATION_LINE_MAX_BYTES) {
    tail = Buffer.from(tail, 'utf8')
      .subarray(-MONITOR_NOTIFICATION_LINE_MAX_BYTES)
      .toString('utf8');
    tailBytes = Buffer.byteLength(tail, 'utf8');
  }
  return `${tail}\n[Monitor output truncated: showing last ${String(tailBytes)} of ${String(totalBytes)} bytes]`;
}
