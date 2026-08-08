/**
 * `brave-search` domain — multi-stage Local and Rich Results tool implementations.
 *
 * Resolves ephemeral location identifiers into POIs and optional descriptions,
 * and follows opaque rich-result callback keys while preserving provider and
 * attribution payloads. Bound at Agent scope by the feature unit.
 */

import type { ToolExecution } from '#/tool/toolContract';

import {
  BraveLocalSearchInputSchema,
  type BraveLocalSearchInput,
  BraveRichResultsInputSchema,
  type BraveRichResultsInput,
  type IBraveLocalSearchTool,
  type IBraveRichResultsTool,
} from './contracts';
import {
  arrayAt,
  BraveToolBase,
  compactQuery,
  isRecord,
  recordAt,
  stringAt,
} from './shared';
import LOCAL_DESCRIPTION from './brave-local-search.md?raw';
import RICH_DESCRIPTION from './brave-rich-results.md?raw';

export class BraveLocalSearchTool
  extends BraveToolBase<BraveLocalSearchInput>
  implements IBraveLocalSearchTool
{
  readonly name = 'BraveLocalSearch' as const;
  readonly description: string = LOCAL_DESCRIPTION;
  readonly parameters = this.parametersFor(BraveLocalSearchInputSchema);

  resolveExecution(args: BraveLocalSearchInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveLocalSearchInputSchema,
      execute: async (input, client, ctx) => {
        const { units, include_descriptions, search_lang, ui_lang, ...searchInput } = input;
        const search = await client.requestJson('/web/search', {
          query: compactQuery({
            ...searchInput,
            search_lang,
            ui_lang,
            result_filter: 'locations',
          }),
          signal: ctx.signal,
        });
        const ids = extractLocationIds(search);
        if (ids.length === 0) return { search, pois: null, descriptions: null };
        const detailQuery = compactQuery({
          ids,
          search_lang: input.search_lang,
          ui_lang: input.ui_lang,
          units,
        });
        const pois = await client.requestJson('/local/pois', {
          query: detailQuery,
          signal: ctx.signal,
        });
        const descriptions = include_descriptions
          ? await client.requestJson('/local/descriptions', {
              query: { ids },
              signal: ctx.signal,
            })
          : null;
        return { search, pois, descriptions };
      },
    });
  }
}

export class BraveRichResultsTool
  extends BraveToolBase<BraveRichResultsInput>
  implements IBraveRichResultsTool
{
  readonly name = 'BraveRichResults' as const;
  readonly description: string = RICH_DESCRIPTION;
  readonly parameters = this.parametersFor(BraveRichResultsInputSchema);

  resolveExecution(args: BraveRichResultsInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveRichResultsInputSchema,
      execute: async (input, client, ctx) => {
        const search = await client.requestJson('/web/search', {
          query: compactQuery({ q: input.q, enable_rich_callback: 1 }),
          signal: ctx.signal,
        });
        const callbackKey = findCallbackKey(search);
        if (callbackKey === undefined) return { search, rich: null };
        const rich = await client.requestJson('/web/rich', {
          query: { callback_key: callbackKey },
          signal: ctx.signal,
        });
        return { search, callback_key: callbackKey, rich };
      },
    });
  }
}

function extractLocationIds(payload: unknown): readonly string[] {
  const locations = recordAt(payload, 'locations');
  const ids: string[] = [];
  for (const entry of arrayAt(locations, 'results')) {
    const id = stringAt(entry, 'id');
    if (id !== undefined) ids.push(id);
    if (ids.length === 20) break;
  }
  return ids;
}

function findCallbackKey(payload: unknown): string | undefined {
  const directHint = recordAt(payload, 'hint');
  const direct = stringAt(directHint, 'callback_key');
  if (direct !== undefined) return direct;
  if (!isRecord(payload)) return undefined;
  for (const value of Object.values(payload)) {
    if (!isRecord(value)) continue;
    const nested = stringAt(recordAt(value, 'hint'), 'callback_key');
    if (nested !== undefined) return nested;
  }
  return undefined;
}
