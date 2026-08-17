import { createDecorator } from "#/_base/di/instantiation";

export type WorkflowModeTrigger = 'manual' | 'command' | 'auto';

export interface IWorkflowModeService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(trigger: WorkflowModeTrigger): void;
  exit(): void;
}

export const IWorkflowModeService = createDecorator<IWorkflowModeService>('workflowModeService');
