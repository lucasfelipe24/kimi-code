/**
 * `workflow` domain (L5) — `IWorkflowProactiveService` contract (Agent scope)
 * and the conservative proactive-adoption heuristic.
 *
 * The service enters workflow mode automatically (trigger `auto`) on turn
 * start when a task looks large or multi-phase, so the agent proactively
 * proposes or runs a workflow without the user turning `/workflow on` first.
 * `promptSuggestsWorkflow` is the pure, testable heuristic: it only fires on
 * prompts that are long enough to be non-trivial AND carry at least two
 * independent markers of multi-step structure (task lists, sequencing words,
 * phase nouns, explicit step counts, or task verbs). Simple one-turn prompts
 * never match.
 */

import { createDecorator } from '#/_base/di/instantiation';

export const WORKFLOW_PROACTIVE_MIN_PROMPT_CHARS = 240;
export const WORKFLOW_PROACTIVE_MIN_TASK_MARKERS = 2;

const WORKFLOW_TASK_MARKER_PATTERNS: readonly RegExp[] = [
  /^\s*(?:[-*•]|\d+[.)])\s/m,
  /\b(?:then|afterwards|subsequently|finally|next|meanwhile)\b/i,
  /\b(?:phase|phases|stage|stages|milestone)\b/i,
  /\b\d+\s+steps?\b/i,
  /\b(?:refactor|migrate|audit|research|implement|build|design|analyze|review|debug|investigate|restructure|optimize|document)\b/i,
];

export function promptSuggestsWorkflow(prompt: string | undefined): boolean {
  if (prompt === undefined) return false;
  const text = prompt.trim();
  if (text.length < WORKFLOW_PROACTIVE_MIN_PROMPT_CHARS) return false;
  let kinds = 0;
  for (const pattern of WORKFLOW_TASK_MARKER_PATTERNS) {
    if (pattern.test(text)) kinds += 1;
  }
  return kinds >= WORKFLOW_PROACTIVE_MIN_TASK_MARKERS;
}

export interface IWorkflowProactiveService {
  readonly _serviceBrand: undefined;
}

export const IWorkflowProactiveService =
  createDecorator<IWorkflowProactiveService>('workflowProactiveService');
