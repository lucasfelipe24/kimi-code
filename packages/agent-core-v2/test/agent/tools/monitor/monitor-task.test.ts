/**
 * Covers: MonitorTask stdout framing, notification delivery, lifecycle, and truncation.
 */

import { PassThrough, type Writable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { IProcess } from '#/session/process/processRunner';
import type {
  AgentTaskSettlement,
  AgentTaskSink,
} from '#/agent/task/types';
import { MonitorTask } from '#/agent/tools/monitor/monitor-task';

interface MonitorEvent {
  readonly text: string;
  readonly opts: { readonly notificationId: string; readonly coalescedCount: number };
}

interface FakeSink extends AgentTaskSink {
  readonly events: MonitorEvent[];
  readonly output: string[];
  readonly settleSpy: ReturnType<typeof vi.fn>;
}

function fakeSink(signal = new AbortController().signal): FakeSink {
  const events: MonitorEvent[] = [];
  const output: string[] = [];
  const settleSpy = vi.fn(async (_settlement: AgentTaskSettlement) => true);
  return {
    signal,
    appendOutput: (chunk) => {
      output.push(chunk);
    },
    notifyEvent: (text, opts) => {
      events.push({ text, opts });
    },
    settle: settleSpy,
    events,
    output,
    settleSpy,
  };
}

function controlledProcess(): {
  readonly proc: IProcess;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly killSpy: ReturnType<typeof vi.fn>;
  readonly disposeSpy: ReturnType<typeof vi.fn>;
  readonly finish: (exitCode?: number) => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let currentExitCode: number | null = null;
  let resolveWait: (exitCode: number) => void = () => {};
  const wait = new Promise<number>((resolve) => {
    resolveWait = resolve;
  });
  const finish = (exitCode = 0): void => {
    if (currentExitCode !== null) return;
    currentExitCode = exitCode;
    stdout.end();
    stderr.end();
    resolveWait(exitCode);
  };
  const killSpy = vi.fn(async (signal: NodeJS.Signals) => {
    finish(signal === 'SIGKILL' ? 137 : 143);
  });
  const disposeSpy = vi.fn(async () => {});
  const proc: IProcess = {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout,
    stderr,
    pid: 4242,
    get exitCode(): number | null {
      return currentExitCode;
    },
    wait: vi.fn(() => wait),
    kill: killSpy as unknown as IProcess['kill'],
    dispose: disposeSpy as unknown as IProcess['dispose'],
  };
  return { proc, stdout, stderr, killSpy, disposeSpy, finish };
}

async function finishAndWait(
  finish: (exitCode?: number) => void,
  running: Promise<void>,
  exitCode = 0,
): Promise<void> {
  finish(exitCode);
  await running;
}

describe('MonitorTask', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('frames stdout lines across chunks and separates multiple lines in one chunk', async () => {
    vi.useFakeTimers();
    const { proc, stdout, stderr, finish } = controlledProcess();
    const sink = fakeSink();
    const running = new MonitorTask(proc, 'tail log', 'log', 'log monitor', true).start(sink);

    stdout.write('lin');
    stdout.write('ha 1\nlinha');
    stdout.write(' 2\n');
    stdout.write('a\nb\nc\n');

    await vi.advanceTimersByTimeAsync(300);

    expect(sink.events).toEqual([
      {
        text: 'c',
        opts: { notificationId: '5', coalescedCount: 4 },
      },
    ]);
    expect(sink.output.join('')).toBe('linha 1\nlinha 2\na\nb\nc\n');

    await finishAndWait(finish, running);
  });

  it('notifies for stdout while retaining stderr without notifying it', async () => {
    vi.useFakeTimers();
    const { proc, stdout, stderr, finish } = controlledProcess();
    const sink = fakeSink();
    const running = new MonitorTask(proc, 'monitor', 'other', 'mixed streams', true).start(sink);

    stderr.write('warning\n');
    stdout.write('event\n');
    await vi.advanceTimersByTimeAsync(300);

    expect(sink.events).toEqual([
      {
        text: 'event',
        opts: { notificationId: '1', coalescedCount: 0 },
      },
    ]);
    expect(sink.output).toEqual(['warning\n', 'event\n']);

    await finishAndWait(finish, running);
  });

  it('delivers only the first line and terminates a one-shot monitor', async () => {
    const { proc, stdout, killSpy, finish } = controlledProcess();
    const sink = fakeSink();
    const running = new MonitorTask(proc, 'read once', 'poll', 'one shot', false).start(sink);

    stdout.write('first\n');
    stdout.write('second\n');
    await finishAndWait(finish, running);

    expect(sink.events).toEqual([
      {
        text: 'first',
        opts: { notificationId: '0', coalescedCount: 0 },
      },
    ]);
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('debounces persistent output and reports the latest line with coalescing', async () => {
    vi.useFakeTimers();
    const { proc, stdout, finish } = controlledProcess();
    const sink = fakeSink();
    const running = new MonitorTask(proc, 'watch', 'watch', 'watcher', true).start(sink);

    stdout.write('one\ntwo\nthree\nfour\n');
    await vi.advanceTimersByTimeAsync(249);
    expect(sink.events).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(sink.events).toEqual([
      {
        text: 'four',
        opts: { notificationId: '4', coalescedCount: 3 },
      },
    ]);

    await finishAndWait(finish, running);
  });

  it('truncates oversized notification lines to a UTF-8 tail', async () => {
    vi.useFakeTimers();
    const { proc, stdout, finish } = controlledProcess();
    const sink = fakeSink();
    const running = new MonitorTask(proc, 'big output', 'other', 'large line', true).start(sink);
    const line = 'x'.repeat(16 * 1024 + 100);

    stdout.write(`${line}\n`);
    await vi.advanceTimersByTimeAsync(300);

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.text).toContain('[Monitor output truncated: showing last');
    expect(sink.events[0]?.text.endsWith(' bytes]')).toBe(true);

    await finishAndWait(finish, running);
  });

  it.each([
    { exitCode: 0, status: 'completed' as const },
    { exitCode: 7, status: 'failed' as const },
  ])('settles as $status for exit code $exitCode', async ({ exitCode, status }) => {
    const { proc, finish } = controlledProcess();
    const sink = fakeSink();
    const running = new MonitorTask(proc, 'exit', 'other', 'exit monitor', false).start(sink);

    await finishAndWait(finish, running, exitCode);

    expect(sink.settleSpy).toHaveBeenCalledWith({ status });
  });

  it('settles as killed when its signal is aborted', async () => {
    const controller = new AbortController();
    const { proc, killSpy, finish } = controlledProcess();
    const sink = fakeSink(controller.signal);
    const running = new MonitorTask(proc, 'abort', 'other', 'abort monitor', false).start(sink);

    controller.abort();
    await finishAndWait(finish, running);

    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
    expect(sink.settleSpy).toHaveBeenCalledWith({ status: 'killed' });
  });

  it('flushes a debounced line before settling when the process ends', async () => {
    vi.useFakeTimers();
    const { proc, stdout, finish } = controlledProcess();
    const sink = fakeSink();
    const running = new MonitorTask(proc, 'flush', 'log', 'flush monitor', true).start(sink);

    stdout.write('pending line\n');
    await finishAndWait(finish, running);

    expect(sink.events).toEqual([
      {
        text: 'pending line',
        opts: { notificationId: '1', coalescedCount: 0 },
      },
    ]);
    expect(sink.settleSpy).toHaveBeenCalledWith({ status: 'completed' });
  });
});

