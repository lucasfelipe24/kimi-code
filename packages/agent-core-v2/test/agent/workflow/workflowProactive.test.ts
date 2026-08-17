import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DisposableStore } from '#/_base/di/lifecycle';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { DYNAMIC_WORKFLOWS_FLAG_ID } from '#/app/workflow/flag';
import { WORKFLOW_TOOL_NAME } from '#/app/workflow/workflow.types';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IWorkflowModeService } from '#/agent/workflow/workflowMode';
import {
  promptSuggestsWorkflow,
  WORKFLOW_PROACTIVE_MIN_PROMPT_CHARS,
} from '#/agent/workflow/workflowProactive';
import { WorkflowProactiveService } from '#/agent/workflow/workflowProactiveService';

const MULTI_PHASE_PROMPT = `Please help me implement a full authentication overhaul for the application. Here is what I need done:
1. Audit the current auth flows and find the gaps
2. Design the new token refresh strategy
3. Refactor the existing session handling code
4. Update the affected tests
5. Document the migration steps
`;

const LONG_SIMPLE_PROMPT = `Can you explain in detail how the token refresh flow works in our authentication service? I want to understand the full lifecycle of a refresh token from issuance to rotation, including all the edge cases around expiry, clock skew, revocation, and what happens when a refresh request arrives after the session has been closed by the server or another client.`;

describe('promptSuggestsWorkflow', () => {
  it('rejects prompts below the length floor', () => {
    expect(promptSuggestsWorkflow('Fix the bug.')).toBe(false);
    expect(promptSuggestsWorkflow('x'.repeat(WORKFLOW_PROACTIVE_MIN_PROMPT_CHARS - 1))).toBe(false);
  });

  it('rejects undefined prompts (system-triggered turns)', () => {
    expect(promptSuggestsWorkflow(undefined)).toBe(false);
  });

  it('rejects a long but single-step question', () => {
    expect(promptSuggestsWorkflow(LONG_SIMPLE_PROMPT)).toBe(false);
  });

  it('accepts a long multi-part task list', () => {
    expect(promptSuggestsWorkflow(MULTI_PHASE_PROMPT)).toBe(true);
  });

  it('accepts a long prompt with sequencing words and phase nouns', () => {
    const prompt = `We are migrating the monolith to microservices. First research the current call graph, then design the new service boundaries, and finally implement the first migration phase. `.repeat(3);
    expect(promptSuggestsWorkflow(prompt)).toBe(true);
  });
});

describe('WorkflowProactiveService', () => {
  let disposables: DisposableStore;
  let onTurnStarted: ((event: { readonly prompt?: string }) => void) | undefined;
  let flagEnabled: boolean;
  let modeActive: boolean;
  let toolAvailable: boolean;
  let enters: string[];

  const eventBus = {
    publish: () => {},
    subscribe: (_cls: unknown, handler: (event: { readonly prompt?: string }) => void) => {
      onTurnStarted = handler;
      return { dispose: () => {} };
    },
  };
  const modes = {
    get isActive(): boolean {
      return modeActive;
    },
    enter: (trigger: string) => {
      enters.push(trigger);
    },
    exit: () => {},
  };
  const flags = {
    enabled: (id: string) => id === DYNAMIC_WORKFLOWS_FLAG_ID && flagEnabled,
  };
  const tools = {
    resolve: (name: string) => (name === WORKFLOW_TOOL_NAME && toolAvailable ? {} : undefined),
  };

  function build(agentId: string): void {
    disposables.add(
      new WorkflowProactiveService(
        eventBus as unknown as IEventBus,
        modes as unknown as IWorkflowModeService,
        flags as unknown as IFlagService,
        tools as unknown as IAgentToolRegistryService,
        makeAgentScopeContext({ agentId, agentScope: `agents/${agentId}` }),
      ),
    );
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    onTurnStarted = undefined;
    flagEnabled = true;
    modeActive = false;
    toolAvailable = true;
    enters = [];
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('subscribes to TurnStarted and enters workflow mode with the auto trigger', () => {
    build('main');
    expect(onTurnStarted).toBeDefined();
    onTurnStarted!({ prompt: MULTI_PHASE_PROMPT });
    expect(enters).toEqual(['auto']);
  });

  it('does not enter for prompts the heuristic rejects', () => {
    build('main');
    onTurnStarted!({ prompt: LONG_SIMPLE_PROMPT });
    onTurnStarted!({ prompt: 'Fix the bug.' });
    expect(enters).toEqual([]);
  });

  it('does not enter when workflow mode is already active', () => {
    modeActive = true;
    build('main');
    onTurnStarted!({ prompt: MULTI_PHASE_PROMPT });
    expect(enters).toEqual([]);
  });

  it('does not enter when the dynamic-workflows flag is off', () => {
    flagEnabled = false;
    build('main');
    onTurnStarted!({ prompt: MULTI_PHASE_PROMPT });
    expect(enters).toEqual([]);
  });

  it('does not enter when the Workflow tool is not registered for the agent', () => {
    toolAvailable = false;
    build('main');
    onTurnStarted!({ prompt: MULTI_PHASE_PROMPT });
    expect(enters).toEqual([]);
  });

  it('never subscribes for subagents (Workflow tool is main-agent-only)', () => {
    build('subagent-1');
    expect(onTurnStarted).toBeUndefined();
  });
});
