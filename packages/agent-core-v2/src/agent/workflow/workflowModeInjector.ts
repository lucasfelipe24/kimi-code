/**
 * `workflow` domain (L4) — workflow-mode context injection.
 *
 * Owns the `workflow_mode` context-injection provider: while workflow mode is
 * active it emits the enter reminder — re-injected only when not already in
 * context (so it survives compaction, which drops injection messages, without
 * spamming every step head) — and on the first inject after deactivation it
 * emits the exit reminder exactly once. The rendered enter reminder lists the
 * live workflow catalog through `IWorkflowCatalogService`. The plain-data
 * state (`wasActive`) is registered into `agentState` (`IAgentStateService`)
 * and read/written through it.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentStateService } from '#/agent/state/agentState';
import { IWorkflowCatalogService } from '#/app/workflow/workflowCatalog';
import { defineState } from '#/state/state';
import { IWorkflowModeService } from '#/agent/workflow/workflowMode';
import ENTER_REMINDER from './enter-reminder.md?raw';
import EXIT_REMINDER from './exit-reminder.md?raw';

const WORKFLOW_MODE_INJECTION_VARIANT = 'workflow_mode';
const WORKFLOW_MODE_EXIT_VARIANT = 'workflow_mode_exit';

export const workflowWasActiveKey = defineState<boolean>('workflow.wasActive', () => false);

export function buildWorkflowEnterReminder(catalog: IWorkflowCatalogService): string {
  const names = catalog
    .list()
    .map((workflow) => `- ${workflow.meta.name}: ${workflow.meta.description}`);
  return renderPrompt(ENTER_REMINDER, {
    catalog_list:
      names.length > 0
        ? names.join('\n')
        : 'none — no catalog workflows discovered; use an inline `script` instead.',
  });
}

export class WorkflowModeInjection extends Disposable {
  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IWorkflowModeService private readonly workflow: IWorkflowModeService,
    @IWorkflowCatalogService private readonly catalog: IWorkflowCatalogService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(workflowWasActiveKey);

    this._register(
      dynamicInjector.register(WORKFLOW_MODE_INJECTION_VARIANT, () => this.reminder()),
    );
  }

  private reminder(): string | undefined {
    const { isActive } = this.workflow;
    const rendered = this.renderedState();

    if (isActive) {
      if (!this.states.get(workflowWasActiveKey)) {
        this.states.set(workflowWasActiveKey, true);
      }
      return rendered === 'active' ? undefined : buildWorkflowEnterReminder(this.catalog);
    }

    if (this.states.get(workflowWasActiveKey)) {
      this.states.set(workflowWasActiveKey, false);
      return rendered === 'inactive' ? undefined : EXIT_REMINDER;
    }

    return undefined;
  }

  private renderedState(): 'active' | 'inactive' | undefined {
    const history = this.context.get();
    for (let i = history.length - 1; i >= 0; i--) {
      const origin = history[i]!.origin;
      if (origin?.kind !== 'injection') continue;
      if (origin.variant === WORKFLOW_MODE_EXIT_VARIANT) return 'inactive';
      if (origin.variant === WORKFLOW_MODE_INJECTION_VARIANT) return 'active';
    }
    return undefined;
  }
}
