/**
 * v2 workflow shape mapping — pure functions that project the agent-core-v2
 * workflow domain shapes onto the v1 SDK shapes the RPC contract returns.
 * The klient facade's `WorkflowDefinition` / `WorkflowRunRecordWire` are the
 * engine's own `WorkflowDefinition` / `WorkflowRunRecord` JSON-round-tripped
 * through the memory transport, so this layer types them as the engine
 * shapes and re-shapes them for the v1 wire.
 *
 * Why a mapping layer exists: v1's `WorkflowSummary` / `WorkflowDetail`
 * flatten the v2 `meta` document into top-level fields, the v1 run snapshot
 * drops the script text and the caller id (`getWorkflowRun`'s detail is the
 * only shape that carries the script), and the v1 list results wrap the
 * arrays in the `{workflows, skipped}` / `{runs}` envelopes the v1 payloads
 * use. The two derivations (runWorkflow's `workflowName`, saveWorkflow's
 * `name`) are resolved by the caller and passed in — this layer stays a
 * pure shape mapping like the other `src/v2/*-mapper.ts` modules.
 */
import type {
  SkippedWorkflow,
  WorkflowDefinition,
  WorkflowRunRecord,
} from '@moonshot-ai/agent-core-v2';

import type {
  SkippedWorkflowInfo,
  WorkflowDetail,
  WorkflowRunDetail,
  WorkflowRunSnapshot,
  WorkflowSummary,
} from '#/types';

export interface WorkflowListResultV1 {
  readonly workflows: readonly WorkflowSummary[];
  readonly skipped: readonly SkippedWorkflowInfo[];
}

export interface WorkflowGetResultV1 {
  readonly workflow: WorkflowDetail | null;
}

export interface WorkflowRunListResultV1 {
  readonly runs: readonly WorkflowRunSnapshot[];
}

export interface WorkflowRunGetResultV1 {
  readonly run: WorkflowRunDetail | null;
}

export interface WorkflowRunStartedResultV1 {
  readonly runId: string;
  readonly taskId: string;
  readonly workflowName: string;
}

export interface WorkflowCancelResultV1 {
  readonly cancelled: boolean;
}

export interface WorkflowSaveResultV1 {
  readonly path: string;
  readonly name: string;
}

/** v1's `WorkflowSummary` flattens v2's nested `meta` document. */
export function workflowDefinitionToSummary(definition: WorkflowDefinition): WorkflowSummary {
  return {
    name: definition.meta.name,
    description: definition.meta.description,
    whenToUse: definition.meta.whenToUse,
    argumentHint: definition.meta.argumentHint,
    phases: definition.meta.phases,
    path: definition.path,
    source: definition.source,
  };
}

/** `WorkflowDetail` is the summary plus the full script text. */
export function workflowDefinitionToDetail(definition: WorkflowDefinition): WorkflowDetail {
  return { ...workflowDefinitionToSummary(definition), script: definition.script };
}

/**
 * list / reload result. `SkippedWorkflow` and v1's `SkippedWorkflowInfo` are
 * field-identical (`path` + `reason`), so the diagnostics pass through.
 */
export function workflowListToV1(
  definitions: readonly WorkflowDefinition[],
  skipped: readonly SkippedWorkflow[],
): WorkflowListResultV1 {
  return {
    workflows: definitions.map(workflowDefinitionToSummary),
    skipped,
  };
}

export function workflowGetToV1(
  definition: WorkflowDefinition | undefined,
): WorkflowGetResultV1 {
  return { workflow: definition === undefined ? null : workflowDefinitionToDetail(definition) };
}

/**
 * v1's list snapshot drops the script text and the caller id and trims the
 * log tail to the last 50 entries (v1's `snapshotWorkflowRun(record, 50)`);
 * `WorkflowRunDetail` is the only shape that carries the script and the full
 * log buffer (see {@link workflowRunRecordToDetail}).
 */
export function workflowRunRecordToSnapshot(
  record: WorkflowRunRecord,
  logTail?: number,
): WorkflowRunSnapshot {
  return {
    runId: record.runId,
    workflowName: record.workflowName,
    description: record.description,
    phases: record.phases,
    status: record.status,
    phase: record.phase,
    phaseIndex: record.phaseIndex,
    agentCalls: record.agentCalls,
    logs: logTail !== undefined ? record.logs.slice(-logTail) : [...record.logs],
    error: record.error,
    resultJson: record.resultJson,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    taskId: record.taskId,
    scriptPath: record.scriptPath,
    source: record.source,
    args: record.args,
  };
}

/** `WorkflowRunDetail` is the snapshot plus the full script text. */
export function workflowRunRecordToDetail(record: WorkflowRunRecord): WorkflowRunDetail {
  return { ...workflowRunRecordToSnapshot(record), script: record.script };
}

export function workflowRunListToV1(records: readonly WorkflowRunRecord[]): WorkflowRunListResultV1 {
  return { runs: records.map((record) => workflowRunRecordToSnapshot(record, 50)) };
}

export function workflowRunGetToV1(
  record: WorkflowRunRecord | undefined,
): WorkflowRunGetResultV1 {
  return { run: record === undefined ? null : workflowRunRecordToDetail(record) };
}

/** runWorkflow result: v1 adds the resolved `workflowName` to the start ids. */
export function workflowRunStartedToV1(
  started: { readonly runId: string; readonly taskId: string },
  workflowName: string,
): WorkflowRunStartedResultV1 {
  return { runId: started.runId, taskId: started.taskId, workflowName };
}

/** cancelWorkflowRun result: the wire boolean is wrapped in the v1 envelope. */
export function workflowCancelToV1(cancelled: boolean): WorkflowCancelResultV1 {
  return { cancelled };
}

/** saveWorkflow result: v1 adds the meta-derived `name` to the saved path. */
export function workflowSaveToV1(
  saved: { readonly path: string },
  name: string,
): WorkflowSaveResultV1 {
  return { path: saved.path, name };
}
