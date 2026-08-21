/**
 * `workflow` domain (L4) — the `workflowModeKey` state and the durable
 * `workflow_mode.enter` (`WorkflowModeEnter`) / `workflow_mode.exit`
 * (`WorkflowModeExit`) events for the agent's workflow mode.
 *
 * The state holds `WorkflowModeTrigger | null` (initial `null`; the trigger is
 * retained, not collapsed to a boolean, so enter/exit can be replayed). The
 * durable classes are the wire-protocol record vocabulary: their
 * `serialize()` output is the on-disk record (flat payload, epoch-ms `time`),
 * byte-compatible with the retired op encoding. Each fold emits the
 * `AgentStatusUpdated` workflow-mode slice after the state commits, live only.
 * The trailing enter-reminder pop on `workflow_mode.exit` is a fold the
 * workflow domain registers onto the core `contextMemoryKey` (mirroring the
 * swarm feature's `popSwarmModeReminder` — the pop returns the same reference
 * on a no-op, and returning the draft keeps the immer base). Consumed by the
 * Agent-scope `workflowModeService`.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { contextMemoryKey } from '#/agent/contextMemory/contextOps';
import { resetFold } from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { WorkflowModeTrigger } from './workflowMode';

const workflowModeEnterSchema = z.object({
  agentId: z.string(),
  trigger: z.custom<WorkflowModeTrigger>(),
});

export class WorkflowModeEnter extends Event2<z.infer<typeof workflowModeEnterSchema>> {
  static override readonly type = 'workflow_mode.enter';
  static override readonly durable = true;
  static override readonly schema = workflowModeEnterSchema;
}
export interface WorkflowModeEnter extends z.infer<typeof workflowModeEnterSchema> {}

const workflowModeExitSchema = z.object({ agentId: z.string() });

export class WorkflowModeExit extends Event2<z.infer<typeof workflowModeExitSchema>> {
  static override readonly type = 'workflow_mode.exit';
  static override readonly durable = true;
  static override readonly schema = workflowModeExitSchema;
}
export interface WorkflowModeExit extends z.infer<typeof workflowModeExitSchema> {}

export const workflowModeKey = defineState('workflowMode', (): WorkflowModeTrigger | null => null)
  .replayable({ schema: z.custom<WorkflowModeTrigger | null>() })
  .on(WorkflowModeEnter, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, workflowMode: true }));
    return e.trigger;
  })
  .on(WorkflowModeExit, (_s, e, ctx) => {
    ctx.emit(new AgentStatusUpdated({ agentId: e.agentId, workflowMode: false }));
    return null;
  });

function popWorkflowModeReminder(state: ContextMessage[]): ContextMessage[] {
  const last = state.at(-1);
  if (last?.origin?.kind !== 'injection' || last.origin.variant !== 'workflow_mode') return state;
  return resetFold(state.slice(0, -1)) as ContextMessage[];
}

contextMemoryKey.on(WorkflowModeExit, (s) => popWorkflowModeReminder(s));
