import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ExecutableToolContext, RunnableToolExecution } from '#/tool/toolContract';
import { IConfigService } from '#/app/config/config';
import { DEFAULT_WORKFLOWS_CONFIG, WORKFLOWS_SECTION } from '#/app/workflow/configSection';
import { WORKFLOW_TOOL_NAME } from '#/app/workflow/workflow.types';
import type { WorkflowDefinition } from '#/app/workflow/runtime/types';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import {
  IWorkflowRunService,
  type StartWorkflowRunInput,
} from '#/session/workflow/sessionWorkflowRun';

import { IWorkflowTool, WORKFLOW_NAME_OR_SCRIPT_REQUIRED } from '#/agent/tools/workflow/workflow';
import { WorkflowTool } from '#/agent/tools/workflow/workflowTool';

const INLINE_SCRIPT = `export const meta = {
  name: 'inline-flow',
  description: 'Inline workflow.',
  phases: [{ title: 'Main' }],
};
return 'done';
`;

function ctx(): ExecutableToolContext {
  return { turnId: 1, toolCallId: 'call_1', signal: new AbortController().signal };
}

describe('WorkflowTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let started: StartWorkflowRunInput[];
  let catalogEntries: readonly WorkflowDefinition[];

  beforeEach(() => {
    disposables = new DisposableStore();
    started = [];
    catalogEntries = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.definePartialInstance(IWorkflowRunService, {
          start: (input: StartWorkflowRunInput) => {
            started.push(input);
            return Promise.resolve({ runId: 'wfrun-test', taskId: 'task-1' });
          },
        });
        reg.definePartialInstance(IWorkflowCatalogService, {
          ready: Promise.resolve(),
          list: () => catalogEntries,
          get: (name: string) =>
            catalogEntries.find((entry) => entry.meta.name === name),
        });
        reg.definePartialInstance(IConfigService, {
          get: <T = unknown>(domain: string): T =>
            (domain === WORKFLOWS_SECTION ? DEFAULT_WORKFLOWS_CONFIG : undefined) as T,
        });
        reg.defineInstance(IAgentScopeContext, makeAgentScopeContext({ agentId: 'main', agentScope: 'agents/main' }));
        reg.define(IWorkflowTool, WorkflowTool);
      },
    });
  });
  afterEach(() =>{  disposables.dispose(); });

  it('lists the live catalog workflows in the tool description', () => {
    catalogEntries = [
      {
        meta: {
          name: 'deep-research',
          description: 'Fan out research across sources.',
          phases: [{ title: 'Research' }],
        },
        script: "return 'done';",
        path: '',
        source: 'builtin',
      },
    ];
    const tool = ix.get(IWorkflowTool);
    expect(tool.description).toContain('deep-research');
    expect(tool.description).toContain('Fan out research across sources.');
  });

  it('rejects input with both or neither of name and script', async () => {
    const tool = ix.get(IWorkflowTool);
    for (const input of [
      { name: 'deep-research', script: INLINE_SCRIPT },
      {},
    ]) {
      const execution = await tool.resolveExecution(input);
      expect('execute' in execution).toBe(false);
      if (!('execute' in execution)) {
        expect(execution.output).toBe(WORKFLOW_NAME_OR_SCRIPT_REQUIRED);
      }
    }
    expect(started).toEqual([]);
  });

  it('starts a run by name and returns the run/task ids without blocking', async () => {
    const tool = ix.get(IWorkflowTool);
    const execution = await tool.resolveExecution({ name: 'deep-research', args: 'topic' });
    expect('isError' in execution).toBe(false);
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(started).toEqual([
      { name: 'deep-research', script: undefined, args: 'topic', callerAgentId: 'main' },
    ]);
    expect(result.output).toContain('run_id: wfrun-test');
    expect(result.output).toContain('task_id: task-1');
    expect(result.output).toContain('status: running');
  });

  it('starts a run with an inline script', async () => {
    const tool = ix.get(IWorkflowTool);
    const execution = await tool.resolveExecution({ script: INLINE_SCRIPT, args: '' });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBeUndefined();
    expect(started[0]?.script).toBe(INLINE_SCRIPT);
    expect(started[0]?.name).toBeUndefined();
  });

  it('surfaces run-service errors as tool errors', async () => {
    const tool = ix.get(IWorkflowTool);
    ix.stub(IWorkflowRunService, 'start', () => Promise.reject(new Error('Workflow "x" not found')));
    const execution = await tool.resolveExecution({ name: 'x' });
    const result = await (execution as RunnableToolExecution).execute(ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain('not found');
  });
});
