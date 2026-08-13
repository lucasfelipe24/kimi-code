/**
 * `tools` domain — `MonitorTool` implementation.
 *
 * Spawns a session-shell monitor through `runner`, creates a detached
 * `MonitorTask` through `tasks`, and gates background execution through
 * `toolPolicy`. Bound at Agent scope.
 *
 * Collaborators injected via constructor:
 *   - `runner` — spawns the shell process through the session process runner
 *   - `env` — supplies the host shell and platform details
 *   - `ctx` — supplies the session working directory
 *   - `tasks` — owns monitor lifecycle and event delivery
 *   - `toolPolicy` — verifies TaskList/TaskOutput/TaskStop availability
 */

import { IAgentTaskService } from '#/agent/task/task';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionProcessRunner, type IProcess } from '#/session/process/processRunner';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { MonitorTask } from './monitor-task';
import { IMonitorTool, MonitorInputSchema, type MonitorInput } from './monitor';
import MONITOR_DESCRIPTION from './monitor.md?raw';

const DEFAULT_MONITOR_TIMEOUT_S = 300;
const MS_PER_SECOND = 1000;

export class MonitorTool implements IMonitorTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Monitor' as const;
  readonly description = MONITOR_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(MonitorInputSchema);
  private readonly isWindowsBash: boolean;

  constructor(
    @ISessionProcessRunner private readonly runner: ISessionProcessRunner,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionContext private readonly ctx: ISessionContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
  ) {
    this.isWindowsBash = this.env.osKind === 'Windows';
  }

  resolveExecution(args: MonitorInput): ToolExecution {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    return {
      description: `Monitoring: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: this.ctx.cwd,
        description: args.description,
        language: 'bash',
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.command),
      execute: ({ signal }) => this.execution(args, signal),
    };
  }

  private allowBackground(): boolean {
    return (
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop')
    );
  }

  private spawn(effectiveCwd: string, command: string): Promise<IProcess> {
    const shellCwd = this.isWindowsBash ? windowsPathToPosixPath(effectiveCwd) : effectiveCwd;
    const shellArgs = [this.env.shellPath, '-c', `cd ${shellQuote(shellCwd)} && ${command}`];
    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: this.env.shellPath,
    };
    return this.runner.exec(shellArgs, { env: noninteractiveEnv });
  }

  private async execution(args: MonitorInput, signal: AbortSignal): Promise<ExecutableToolResult> {
    if (!this.allowBackground()) {
      return {
        isError: true,
        output:
          'Monitor is unavailable because TaskList, TaskOutput, and TaskStop must all be enabled ' +
          'for background task management.',
      };
    }
    if (signal.aborted) return { isError: true, output: 'Aborted before monitor started' };

    const persistent = args.persistent ?? false;
    const timeoutMs = persistent
      ? undefined
      : (args.timeout ?? DEFAULT_MONITOR_TIMEOUT_S) * MS_PER_SECOND;
    const description = args.description.trim();
    let proc: IProcess;
    try {
      proc = await this.spawn(this.ctx.cwd, args.command);
    } catch (error) {
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }
    closeProcessStdin(proc);

    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new MonitorTask(proc, args.command, args.kind, description, persistent),
        { detached: true, timeoutMs },
      );
    } catch (error) {
      await killSpawnedProcess(proc);
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }

    const status = this.tasks.getTask(taskId)?.status ?? 'running';
    return {
      isError: false,
      output:
        `task_id: ${taskId}\n` +
        `pid: ${String(proc.pid)}\n` +
        `description: ${description}\n` +
        `kind: ${args.kind}\n` +
        `persistent: ${String(persistent)}\n` +
        `status: ${status}\n` +
        'next_step: Events arrive automatically; do not wait or poll this monitor.\n' +
        'next_step: Use TaskStop to cancel it, or /tasks to inspect background tasks.\n' +
        'human_shell_hint: Tell the human to run /tasks to open the interactive background-task panel.',
    };
  }
}

registerAgentToolService(IMonitorTool, MonitorTool, { name: 'Monitor', domain: 'agentTask' });

function closeProcessStdin(proc: IProcess): void {
  try {
    proc.stdin.end();
  } catch {
  }
}

async function killSpawnedProcess(proc: IProcess): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {
  } finally {
    try {
      await proc.dispose();
    } catch {
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function windowsPathToPosixPath(path: string): string {
  if (path.startsWith('\\\\')) return path.replaceAll('\\', '/');
  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = path.slice(2).replaceAll('\\', '/');
    return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
  }
  return path.replaceAll('\\', '/');
}
