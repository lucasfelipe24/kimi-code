/**
 * `brave-search` domain — `BraveLLMContextTool` implementation.
 *
 * Executes Brave's GET or POST LLM Context contract with validated optional
 * location headers and preserves grounding and source payloads as structured
 * JSON. Bound at Agent scope by the feature unit.
 */

import type { ToolExecution } from '#/tool/toolContract';

import {
  BraveLLMContextInputSchema,
  type BraveLLMContextInput,
  type IBraveLLMContextTool,
} from './contracts';
import { BraveToolBase, compactQuery } from './shared';
import DESCRIPTION from './brave-llm-context.md?raw';

export class BraveLLMContextTool
  extends BraveToolBase<BraveLLMContextInput>
  implements IBraveLLMContextTool
{
  readonly name = 'BraveLLMContext' as const;
  readonly description: string = DESCRIPTION;
  readonly parameters = this.parametersFor(BraveLLMContextInputSchema);

  resolveExecution(args: BraveLLMContextInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveLLMContextInputSchema,
      execute: (input, client, ctx) => {
        const { method, location, ...parameters } = input;
        const headers = locationHeaders(location);
        const query = compactQuery(parameters);
        return method === 'POST'
          ? client.requestJson('/llm/context', {
              method,
              body: query,
              headers,
              signal: ctx.signal,
            })
          : client.requestJson('/llm/context', {
              query,
              headers,
              signal: ctx.signal,
            });
      },
    });
  }
}

function locationHeaders(
  location: BraveLLMContextInput['location'],
): Readonly<Record<string, string>> | undefined {
  if (location === undefined) return undefined;
  const mappings = [
    ['lat', 'X-Loc-Lat'],
    ['long', 'X-Loc-Long'],
    ['city', 'X-Loc-City'],
    ['state', 'X-Loc-State'],
    ['state_name', 'X-Loc-State-Name'],
    ['country', 'X-Loc-Country'],
    ['postal_code', 'X-Loc-Postal-Code'],
  ] as const;
  const headers: Record<string, string> = {};
  for (const [field, header] of mappings) {
    const value = location[field];
    if (value !== undefined) headers[header] = String(value);
  }
  return headers;
}
