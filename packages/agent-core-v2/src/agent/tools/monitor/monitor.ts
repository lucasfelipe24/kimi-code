/**
 * `tools` domain — `Monitor` tool contract.
 *
 * Defines the input schema for background stdout monitors and the Agent-scope
 * service identifier used by the tool registry.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const MonitorInputSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Shell command to run as a background monitor. Each stdout line is delivered as a task-notification event.'),
  kind: z
    .enum(['log', 'poll', 'watch', 'other'])
    .describe("Category of monitor: 'log' tails a log file, 'poll' polls a status endpoint, 'watch' watches a directory, 'other' for arbitrary streams."),
  description: z
    .string()
    .min(1)
    .describe('Short human-readable description of what is being monitored. Appears in every notification and in task listings.'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(3600)
    .optional()
    .describe('Optional maximum wall-clock seconds before automatic shutdown. Omit for indefinite (subject to session lifetime). Ignored implicitly for persistent monitors that you stop via TaskStop.'),
  persistent: z
    .boolean()
    .optional()
    .describe('true = streaming monitor with debounced notifications that lives until TaskStop or session end; false (default) = one-shot, delivers the first matching line then stops.'),
});

export type MonitorInput = z.infer<typeof MonitorInputSchema>;

export interface IMonitorTool extends AgentTool<MonitorInput> {
  readonly _serviceBrand: undefined;
}

export const IMonitorTool = createDecorator<IMonitorTool>('monitorTool');
