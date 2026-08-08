/**
 * `brave-search` domain — shared runtime support for Brave API tools.
 *
 * Resolves the current authenticated client through `braveSearch`, provides
 * defensive structured-data guards and result formatting, and builds the
 * common search-style tool execution contract. Bound through the App-scoped
 * Brave service and Agent tool contexts.
 */

import type { z } from 'zod';

import type { BraveClient, BraveQuery } from '#/app/auth/brave/braveClient';
import { IBraveSearchService } from '#/features/brave-search/braveSearch';
import { toInputJsonSchema } from '#/tool/input-schema';
import { ToolResultBuilder } from '#/tool/result-builder';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

export type UnknownRecord = Record<string, unknown>;

export interface BraveToolDefinition<RawInput, ParsedInput extends { q: string }> {
  readonly name: string;
  readonly schema: z.ZodType<ParsedInput, RawInput>;
  readonly execute: (
    args: ParsedInput,
    client: BraveClient,
    ctx: ExecutableToolContext,
  ) => Promise<unknown>;
}

export abstract class BraveToolBase<_Input extends { q: string }> {
  declare readonly _serviceBrand: undefined;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: Record<string, unknown>;

  constructor(@IBraveSearchService private readonly braveSearch: IBraveSearchService) {}

  protected parametersFor(schema: z.ZodType): Record<string, unknown> {
    return toInputJsonSchema(schema);
  }

  protected executionFor<RawInput, ParsedInput extends { q: string }>(
    args: RawInput,
    query: string,
    definition: BraveToolDefinition<RawInput, ParsedInput>,
  ): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: `Searching Brave: ${preview(query)}`,
      display: { kind: 'search', query },
      approvalRule: literalRulePattern(definition.name, query),
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, query),
      execute: async (ctx) => {
        const parsed = definition.schema.safeParse(args);
        if (!parsed.success) return formatValidationError(parsed.error.issues);
        const client = this.currentClient();
        if (client === undefined) {
          return {
            isError: true,
            output: 'Brave Search is no longer configured for this execution.',
          };
        }
        try {
          const result = await definition.execute(parsed.data, client, ctx);
          return isExecutableResult(result) ? result : formatPayload(result);
        } catch (error) {
          if (ctx.signal.aborted) throw error;
          return {
            isError: true,
            output: error instanceof Error ? `Brave API request failed: ${error.message}` : 'Brave API request failed.',
          };
        }
      },
    };
  }

  private currentClient(): BraveClient | undefined {
    return this.braveSearch.getClient();
  }
}

export function compactQuery(record: Readonly<Record<string, unknown>>): BraveQuery {
  const query: Record<string, string | number | boolean | readonly (string | number | boolean)[]> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      (Array.isArray(value) &&
        value.every(
          (entry) =>
            typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean',
        ))
    ) {
      query[key] = value;
    }
  }
  return query;
}

export function formatPayload(payload: unknown, prefix?: string): ExecutableToolResult {
  const json = JSON.stringify(payload, null, 2) ?? 'null';
  const output = prefix === undefined ? json : `${prefix}\n\n${json}`;
  const builder = new ToolResultBuilder({ maxLineLength: null, maxChars: output.length });
  builder.write(output);
  return builder.ok();
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function recordAt(value: unknown, key: string): UnknownRecord | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined;
}

export function arrayAt(value: unknown, key: string): readonly unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : [];
}

export function stringAt(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined;
}

export function selectFields(value: unknown, keys: readonly string[]): UnknownRecord {
  if (!isRecord(value)) return {};
  const selected: UnknownRecord = {};
  for (const key of keys) {
    if (value[key] !== undefined) selected[key] = value[key];
  }
  return selected;
}

function preview(query: string): string {
  return query.length > 40 ? `${query.slice(0, 40)}…` : query;
}

function formatValidationError(issues: readonly { readonly path: PropertyKey[]; readonly message: string }[]): ExecutableToolResult {
  const details = issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ');
  return { isError: true, output: `Invalid Brave tool input: ${details}` };
}

function isExecutableResult(value: unknown): value is ExecutableToolResult {
  return isRecord(value) && (typeof value['output'] === 'string' || Array.isArray(value['output']));
}
