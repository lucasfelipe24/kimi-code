import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IWorkflowModeService } from '#/agent/workflow/workflowMode';
import { WorkflowModeService } from '#/agent/workflow/workflowModeService';
import { workflowModeKey } from '#/agent/workflow/workflowModeOps';
import {
  WorkflowModeInjection,
  workflowWasActiveKey,
} from '#/agent/workflow/workflowModeInjector';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import type { WorkflowDefinition } from '#/app/workflow/runtime/types';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IEventBus, ISessionEventBus } from '#/app/event/eventBus';
import { AgentEventBusView, EventBusService } from '#/app/event/eventBusService';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { stubContextMemory } from '../contextMemory/stubs';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  restoreTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

function stubCatalog(): Partial<IWorkflowCatalogService> {
  return { list: () => [] };
}

function workflowModeState(ix: TestInstantiationService): unknown {
  return ix.get(IAgentStateService).get(workflowModeKey);
}

describe('WorkflowModeService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const sessionBus = new EventBusService();
    ix.stub(ISessionEventBus, sessionBus);
    registerTestAgentWire(ix, testWireScope('wire', 'workflow-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: sessionBus,
    });
    ix.set(IEventBus, new SyncDescriptor(AgentEventBusView));
    registerTestEventDispatcher(ix);
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.stub(IAgentContextInjectorService, {
      register: () => ({ dispose: () => {} }),
      reconcileWhenIdle: async () => {},
    });
    ix.stub(IWorkflowCatalogService, stubCatalog());
    ix.set(IWorkflowModeService, new SyncDescriptor(WorkflowModeService));
  });

  afterEach(() =>{  disposables.dispose(); });

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const workflow = ix.get(IWorkflowModeService);
    const events: {
      readonly type: string;
      readonly workflowMode?: boolean;
      readonly start?: number;
      readonly deleteCount?: number;
      readonly messages?: readonly unknown[];
    }[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          events.push({ type: e.type, workflowMode: (e as AgentStatusUpdated).workflowMode });
        } else if (e.type === 'context.spliced') {
          const spliced = e as ContextSpliced;
          events.push({
            type: e.type,
            start: spliced.start,
            deleteCount: spliced.deleteCount,
            messages: spliced.messages,
          });
        }
      }),
    );

    expect(workflow.isActive).toBe(false);
    workflow.enter('manual');
    expect(workflow.isActive).toBe(true);
    workflow.exit();
    expect(workflow.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', workflowMode: true },
      { type: 'agent.status.updated', workflowMode: false },
      { type: 'context.spliced', start: 0, deleteCount: 1, messages: [] },
    ]);
  });

  it('enter is a no-op when already active', () => {
    const workflow = ix.get(IWorkflowModeService);
    workflow.enter('manual');
    expect(workflow.isActive).toBe(true);

    // Second enter should be a no-op
    workflow.enter('command');
    expect(workflow.isActive).toBe(true);
  });

  it('exit is a no-op when not active', () => {
    const workflow = ix.get(IWorkflowModeService);
    expect(() =>{  workflow.exit(); }).not.toThrow();
    expect(workflow.isActive).toBe(false);
  });

  it('enter accepts the auto trigger used by the proactive service', () => {
    const workflow = ix.get(IWorkflowModeService);
    workflow.enter('auto');
    expect(workflow.isActive).toBe(true);
    expect(workflowModeState(ix)).toBe('auto');
    workflow.exit();
    expect(workflow.isActive).toBe(false);
  });

  it('dispatch persists enter/exit records and replay rebuilds the trigger', async () => {
    const workflow = ix.get(IWorkflowModeService);
    workflow.enter('manual');

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'workflow-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      {
        type: 'workflow_mode.enter',
        agentId: 'test-agent',
        trigger: 'manual',
        time: expect.any(Number),
      },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    registerTestAgentWire(ix2, testWireScope('wire', 'workflow-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    const fresh = registerTestEventDispatcher(ix2);
    const freshState = ix2.get(IAgentStateService);
    freshState.contributeState(workflowModeKey);
    await restoreTestEventDispatcher(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'workflow-replay'),
      records,
    );
    expect(freshState.get(workflowModeKey)).toBe('manual');
  });
});

describe('WorkflowModeInjection dedup', () => {
  let disposables: DisposableStore;
  let active: boolean;
  let state: Record<string, unknown>;
  let providers: ((context: unknown) => unknown)[];
  let context: ReturnType<typeof stubContextMemory>;

  const states = {
    contributeState: (key: { readonly name: string; readonly initial: () => unknown }) => {
      if (state[key.name] === undefined) state[key.name] = key.initial();
    },
    get: (key: { readonly name: string }) => state[key.name],
    set: (key: { readonly name: string }, value: unknown) => {
      state[key.name] = value;
    },
  };
  const workflow = {
    get isActive(): boolean {
      return active;
    },
    enter: () => {},
    exit: () => {},
  };
  const catalog = {
    ready: Promise.resolve(),
    list: () =>
      [
        {
          meta: {
            name: 'deep-research',
            description: 'Fan out research across sources.',
          },
        },
      ] as unknown as readonly WorkflowDefinition[],
    get: () => undefined,
    skipped: () => [],
    reload: async () => {},
    save: async () => ({ path: '' }),
  };
  const injector = {
    register: (name: string, provider: (context: unknown) => unknown) => {
      providers.push(provider);
      return { dispose: () => {} };
    },
    reconcileWhenIdle: async () => {},
  };

  function reminder(variant: string): ContextMessage {
    return {
      role: 'user',
      content: [{ type: 'text', text: 'reminder' }],
      toolCalls: [],
      origin: { kind: 'injection', variant },
    };
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    active = false;
    state = {};
    providers = [];
    context = stubContextMemory();
    disposables.add(
      new WorkflowModeInjection(
        injector as never,
        context as never,
        workflow as never,
        catalog as never,
        states as never,
      ),
    );
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('emits the rendered enter reminder when active and not already in context', () => {
    active = true;
    const content = providers[0]!({}) as string;
    expect(content).toContain('Dynamic Workflow Mode');
    expect(content).toContain('deep-research');
  });

  it('does not re-emit the enter reminder when it is already in context', () => {
    active = true;
    context.append(reminder('workflow_mode'));
    expect(providers[0]!({})).toBeUndefined();
  });

  it('re-emits the enter reminder after compaction drops the injection', () => {
    active = true;
    context.append(reminder('workflow_mode'));
    expect(providers[0]!({})).toBeUndefined();
    context.clear();
    expect(providers[0]!({})).toContain('Dynamic Workflow Mode');
  });

  it('emits the exit reminder once on deactivation and then stays silent', () => {
    active = true;
    providers[0]!({});
    active = false;
    expect(providers[0]!({})).toContain('no longer active');
    expect(providers[0]!({})).toBeUndefined();
  });

  it('skips the exit reminder when the service already appended one', () => {
    active = true;
    providers[0]!({});
    active = false;
    context.append(reminder('workflow_mode_exit'));
    expect(providers[0]!({})).toBeUndefined();
    expect(providers[0]!({})).toBeUndefined();
  });
});
