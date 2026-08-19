/**
 * Covers: MonitorInputSchema and MonitorTool execution policy, spawning, and registration.
 */

import { Readable, type Writable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  IAgentTaskService,
  type AgentTask,
  type AgentTaskWaitDelivery,
  type IAgentTaskEntry,
  type AgentTaskInfo,
  type AgentTaskOutputSnapshot,
  type AgentTaskTrackOptions,
  type ForegroundTaskReleaseReason,
  type RegisterAgentTaskOptions,
} from '#/agent/task/task';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';
import { MonitorInputSchema } from '#/agent/tools/monitor/monitor';
import { MonitorTool } from '#/agent/tools/monitor/monitorTool';
import type { ExecutableToolContext } from '#/tool/toolContract';

const env: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

const ctx = makeSessionContext({
  sessionId: 'session',
  workspaceId: 'workspace',
  sessionDir: '/tmp/session',
  sessionScope: 'sessions/workspace/session',
  cwd: '/workspace',
});

function policy(active = true): IAgentToolPolicyService {
  return {
    _serviceBrand: undefined,
    isToolActive: () => active,
  } as unknown as IAgentToolPolicyService;
}

function fakeProcess(): IProcess {
  return {
    stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
    stdout: Readable.from([]),
    stderr: Readable.from([]),
    pid: 1234,
    exitCode: null,
    wait: vi.fn(() => new Promise<number>(() => {})),
    kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
    dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
  };
}

function fakeTasks(): IAgentTaskService & { readonly registerSpy: ReturnType<typeof vi.fn> } {
  const registerSpy = vi.fn((_task: AgentTask, _options?: RegisterAgentTaskOptions) => 'monitor-abc12345');
  return {
    _serviceBrand: undefined,
    registerTask: registerSpy,
    getTask: () => ({
      taskId: 'monitor-abc12345',
      kind: 'monitor',
      command: 'tail -f log',
      monitorKind: 'log',
      description: 'log watcher',
      pid: 1234,
      exitCode: null,
      persistent: false,
      eventCount: 0,
      status: 'running',
      detached: true,
      startedAt: 1,
      endedAt: null,
    }),
    track: (_handle, _options: AgentTaskTrackOptions): IAgentTaskEntry => {
      throw new Error('unused');
    },
    list: () => [],
    persistOutput: () => {},
    getOutputSnapshot: async (_id: string, _max: number): Promise<AgentTaskOutputSnapshot> => ({
      outputSizeBytes: 0,
      previewBytes: 0,
      truncated: false,
      fullOutputAvailable: false,
      preview: '',
    }),
    readOutput: async () => '',
    suppressTerminalNotification: async () => {},
    markTasksDeliveredViaWait: (_tasks: readonly AgentTaskWaitDelivery[]): void => {},
    detach: () => undefined,
    stop: async () => undefined,
    stopByUser: async () => undefined,
    stopAll: async () => [],
    stopAllOnExit: async () => [],
    wait: async (_id: string, _timeout?: number, _signal?: AbortSignal) => undefined,
    waitForForegroundRelease: async (_id: string): Promise<ForegroundTaskReleaseReason | undefined> => undefined,
    registerSpy,
  };
}

function executeContext(signal = new AbortController().signal): ExecutableToolContext {
  return { turnId: 0, toolCallId: 'monitor-call', signal };
}

describe('MonitorTool', () => {
  it('validates monitor kinds, required fields, and timeout cap', () => {
    for (const kind of ['log', 'poll', 'watch', 'other'] as const) {
      expect(MonitorInputSchema.safeParse({ command: 'echo x', kind, description: 'test' }).success).toBe(true);
    }
    expect(MonitorInputSchema.safeParse({ command: 'echo x', kind: 'invalid', description: 'test' }).success).toBe(false);
    expect(MonitorInputSchema.safeParse({ command: '', kind: 'log', description: 'test' }).success).toBe(false);
    expect(MonitorInputSchema.safeParse({ command: 'echo x', kind: 'log', description: '' }).success).toBe(false);
    expect(MonitorInputSchema.safeParse({ command: 'echo x', kind: 'log', description: 'test', timeout: 3600 }).success).toBe(true);
    expect(MonitorInputSchema.safeParse({ command: 'echo x', kind: 'log', description: 'test', timeout: 3601 }).success).toBe(false);
  });

  it('resolves command display and literal approval rule', () => {
    const runner = { exec: vi.fn() } as unknown as ISessionProcessRunner;
    const tool = new MonitorTool(runner, env, ctx, fakeTasks(), policy());
    const execution = tool.resolveExecution({ command: 'echo [event]', kind: 'watch', description: 'watch files' });
    if (execution.isError === true) throw new Error(execution.output.toString());

    expect(execution).toMatchObject({
      description: 'Monitoring: echo [event]',
      display: {
        kind: 'command',
        command: 'echo [event]',
        cwd: '/workspace',
        description: 'watch files',
        language: 'bash',
      },
      approvalRule: 'Monitor(echo \\[event\\])',
    });
    expect(execution.matchesRule?.('echo \\[event\\]')).toBe(true);
  });

  it('reports background unavailability before spawning', async () => {
    const runner = { exec: vi.fn() } as unknown as ISessionProcessRunner;
    const tool = new MonitorTool(runner, env, ctx, fakeTasks(), policy(false));
    const execution = tool.resolveExecution({ command: 'echo x', kind: 'log', description: 'log' });
    if (execution.isError === true) throw new Error(execution.output.toString());
    const result = await execution.execute(executeContext());

    expect(result).toEqual({
      isError: true,
      output: 'Monitor is unavailable because TaskList, TaskOutput, and TaskStop must all be enabled for background task management.',
    });
    expect(runner.exec).not.toHaveBeenCalled();
  });

  it('spawns, closes stdin, and registers monitor metadata', async () => {
    const proc = fakeProcess();
    const runner = { exec: vi.fn().mockResolvedValue(proc) } as unknown as ISessionProcessRunner;
    const tasks = fakeTasks();
    const tool = new MonitorTool(runner, env, ctx, tasks, policy());
    const execution = tool.resolveExecution({
      command: 'tail -f log',
      kind: 'log',
      description: '  log watcher  ',
      timeout: 12,
      persistent: true,
    });
    if (execution.isError === true) throw new Error(execution.output.toString());
    const result = await execution.execute(executeContext());

    expect(result).toMatchObject({ isError: false });
    expect(result.output).toContain('task_id: monitor-abc12345');
    expect(result.output).toContain('kind: log');
    expect(result.output).toContain('persistent: true');
    expect(proc.stdin.end).toHaveBeenCalledTimes(1);
    expect(tasks.registerSpy).toHaveBeenCalledWith(expect.anything(), {
      detached: true,
      timeoutMs: undefined,
    });
    expect(runner.exec).toHaveBeenCalledWith(
      ['/bin/bash', '-c', "cd '/workspace' && tail -f log"],
      expect.objectContaining({ env: expect.objectContaining({ NO_COLOR: '1', TERM: 'dumb' }) }),
    );
  });
});
