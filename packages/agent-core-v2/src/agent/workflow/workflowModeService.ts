/**
 * `workflow` domain (L4) — `IWorkflowModeService` implementation.
 *
 * Tracks workflow-mode enter/exit in the `workflowModeKey` state (mutated only
 * through the durable `WorkflowModeEnter` / `WorkflowModeExit` events, read
 * through `agentState.get(workflowModeKey)`), derives the
 * `AgentStatusUpdated` workflow-mode slice from the event folds, announces the
 * mode through the `workflow_mode` context-injection provider
 * (`WorkflowModeInjection`), and publishes the live-only `context.spliced`
 * for the trailing enter-reminder pop on exit.
 *
 * The enter-reminder removal on exit is a fold on `contextMemoryKey` (see
 * `workflowModeOps.ts`): dispatching `WorkflowModeExit` pops the reminder when
 * it is the last message, both live and on replay. The service only publishes
 * the live-only `context.spliced` event for that pop (so injector bookkeeping
 * stays in step) and appends the exit reminder when nothing was popped.
 *
 * Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ContextSpliced } from '#/agent/contextMemory/contextEvents';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import { IEventDispatcher } from '#/state/eventDispatcher';
import EXIT_REMINDER from './exit-reminder.md?raw';
import { IWorkflowModeService, type WorkflowModeTrigger } from './workflowMode';
import { WorkflowModeEnter, WorkflowModeExit, workflowModeKey } from './workflowModeOps';
import { WorkflowModeInjection, buildWorkflowEnterReminder } from './workflowModeInjector';

export class WorkflowModeService extends Disposable implements IWorkflowModeService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IWorkflowCatalogService private readonly catalog: IWorkflowCatalogService,
  ) {
    super();
    this.agentState.contributeState(workflowModeKey);
    this._register(new WorkflowModeInjection(dynamicInjector, this.context, this, this.catalog, this.agentState));
  }

  enter(trigger: WorkflowModeTrigger): void {
    if (this.agentState.get(workflowModeKey) !== null) return;
    void this.dispatcher.dispatch(new WorkflowModeEnter({ trigger }));
    this.reminders.appendSystemReminder(buildWorkflowEnterReminder(this.catalog), {
      kind: 'injection',
      variant: 'workflow_mode',
    });
  }

  exit(): void {
    if (this.agentState.get(workflowModeKey) === null) return;
    const history = this.context.get();
    const last = history.at(-1);
    const willPop =
      last?.origin?.kind === 'injection' && last.origin.variant === 'workflow_mode';
    void this.dispatcher.dispatch(new WorkflowModeExit({}));
    if (willPop) {
      this.eventBus.publish(
        new ContextSpliced({
          start: history.length - 1,
          deleteCount: 1,
          messages: [],
        }),
      );
      return;
    }
    this.reminders.appendSystemReminder(EXIT_REMINDER, {
      kind: 'injection',
      variant: 'workflow_mode_exit',
    });
  }

  get isActive(): boolean {
    return this.agentState.get(workflowModeKey) !== null;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWorkflowModeService,
  WorkflowModeService,
  ScopeActivation.OnScopeCreated,
  'workflow',
);
