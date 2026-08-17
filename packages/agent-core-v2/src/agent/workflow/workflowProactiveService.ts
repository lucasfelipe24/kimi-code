/**
 * `workflow` domain (L5) — `IWorkflowProactiveService` implementation.
 *
 * Hooks `TurnStarted` (mirroring the step-retry service) and enters workflow
 * mode with the `auto` trigger when the turn's prompt matches the conservative
 * large / multi-phase heuristic, so the main agent adopts workflows
 * proactively. Guards: the agent must be the main agent (the `Workflow` tool
 * is main-agent-only via the builtin `agent` profile allowlist), the
 * `Workflow` tool must actually be registered for the agent (custom profiles
 * may remove it), and workflow mode must not already be active. Bound at
 * Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { WORKFLOW_TOOL_NAME } from '#/app/workflow/workflow.types';
import { IWorkflowModeService } from '#/agent/workflow/workflowMode';
import { MAIN_AGENT_ID } from '#/session/agentLifecycle/agentLifecycle';

import {
  IWorkflowProactiveService,
  promptSuggestsWorkflow,
} from './workflowProactive';

export class WorkflowProactiveService extends Disposable implements IWorkflowProactiveService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventBus eventBus: IEventBus,
    @IWorkflowModeService private readonly modes: IWorkflowModeService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    super();
    if (scopeContext.agentId === MAIN_AGENT_ID) {
      this._register(
        eventBus.subscribe(TurnStarted, (event) => {
          this.onTurnStarted(event.prompt);
        }),
      );
    }
  }

  private onTurnStarted(prompt: string | undefined): void {
    if (this.modes.isActive) return;
    if (this.tools.resolve(WORKFLOW_TOOL_NAME) === undefined) return;
    if (!promptSuggestsWorkflow(prompt)) return;
    this.modes.enter('auto');
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWorkflowProactiveService,
  WorkflowProactiveService,
  ScopeActivation.OnScopeCreated,
  'workflow',
);
