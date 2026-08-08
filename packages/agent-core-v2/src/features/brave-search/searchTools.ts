/**
 * `brave-search` domain — single-request Brave search tool implementations.
 *
 * Executes the Web, News, Image, Video, Suggest, and Spellcheck API contracts
 * through the shared authenticated client and renders provider JSON without
 * coercing heterogeneous vertical payloads. Bound at Agent scope by the
 * feature unit.
 */

import type { ToolExecution } from '#/tool/toolContract';

import {
  BraveImageSearchInputSchema,
  type BraveImageSearchInput,
  BraveNewsSearchInputSchema,
  type BraveNewsSearchInput,
  BraveSpellcheckInputSchema,
  type BraveSpellcheckInput,
  BraveSuggestInputSchema,
  type BraveSuggestInput,
  BraveVideoSearchInputSchema,
  type BraveVideoSearchInput,
  BraveWebSearchInputSchema,
  type BraveWebSearchInput,
  type IBraveImageSearchTool,
  type IBraveNewsSearchTool,
  type IBraveSpellcheckTool,
  type IBraveSuggestTool,
  type IBraveVideoSearchTool,
  type IBraveWebSearchTool,
} from './contracts';
import { BraveToolBase, compactQuery, formatPayload, isRecord } from './shared';
import IMAGE_DESCRIPTION from './brave-image-search.md?raw';
import NEWS_DESCRIPTION from './brave-news-search.md?raw';
import SPELLCHECK_DESCRIPTION from './brave-spellcheck.md?raw';
import SUGGEST_DESCRIPTION from './brave-suggest.md?raw';
import VIDEO_DESCRIPTION from './brave-video-search.md?raw';
import WEB_DESCRIPTION from './brave-web-search.md?raw';

export class BraveWebSearchTool
  extends BraveToolBase<BraveWebSearchInput>
  implements IBraveWebSearchTool
{
  readonly name = 'BraveWebSearch' as const;
  readonly description: string = WEB_DESCRIPTION;
  readonly parameters = this.parametersFor(BraveWebSearchInputSchema);

  resolveExecution(args: BraveWebSearchInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveWebSearchInputSchema,
      execute: (input, client, ctx) =>
        client.requestJson('/web/search', { query: compactQuery(input), signal: ctx.signal }),
    });
  }
}

export class BraveNewsSearchTool
  extends BraveToolBase<BraveNewsSearchInput>
  implements IBraveNewsSearchTool
{
  readonly name = 'BraveNewsSearch' as const;
  readonly description: string = NEWS_DESCRIPTION;
  readonly parameters = this.parametersFor(BraveNewsSearchInputSchema);

  resolveExecution(args: BraveNewsSearchInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveNewsSearchInputSchema,
      execute: (input, client, ctx) =>
        client.requestJson('/news/search', { query: compactQuery(input), signal: ctx.signal }),
    });
  }
}

export class BraveImageSearchTool
  extends BraveToolBase<BraveImageSearchInput>
  implements IBraveImageSearchTool
{
  readonly name = 'BraveImageSearch' as const;
  readonly description: string = IMAGE_DESCRIPTION;
  readonly parameters = this.parametersFor(BraveImageSearchInputSchema);

  resolveExecution(args: BraveImageSearchInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveImageSearchInputSchema,
      execute: (input, client, ctx) =>
        client.requestJson('/images/search', { query: compactQuery(input), signal: ctx.signal }),
    });
  }
}

export class BraveVideoSearchTool
  extends BraveToolBase<BraveVideoSearchInput>
  implements IBraveVideoSearchTool
{
  readonly name = 'BraveVideoSearch' as const;
  readonly description: string = VIDEO_DESCRIPTION;
  readonly parameters = this.parametersFor(BraveVideoSearchInputSchema);

  resolveExecution(args: BraveVideoSearchInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveVideoSearchInputSchema,
      execute: (input, client, ctx) =>
        client.requestJson('/videos/search', { query: compactQuery(input), signal: ctx.signal }),
    });
  }
}

export class BraveSuggestTool
  extends BraveToolBase<BraveSuggestInput>
  implements IBraveSuggestTool
{
  readonly name = 'BraveSuggest' as const;
  readonly description: string = SUGGEST_DESCRIPTION;
  readonly parameters = this.parametersFor(BraveSuggestInputSchema);

  resolveExecution(args: BraveSuggestInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveSuggestInputSchema,
      execute: (input, client, ctx) =>
        client.requestJson('/suggest/search', { query: compactQuery(input), signal: ctx.signal }),
    });
  }
}

export class BraveSpellcheckTool
  extends BraveToolBase<BraveSpellcheckInput>
  implements IBraveSpellcheckTool
{
  readonly name = 'BraveSpellcheck' as const;
  readonly description: string = SPELLCHECK_DESCRIPTION;
  readonly parameters = this.parametersFor(BraveSpellcheckInputSchema);

  resolveExecution(args: BraveSpellcheckInput): ToolExecution {
    return this.executionFor(args, args.q, {
      name: this.name,
      schema: BraveSpellcheckInputSchema,
      execute: async (input, client, ctx) => {
        const payload: unknown = await client.requestJson('/spellcheck/search', {
          query: compactQuery(input),
          signal: ctx.signal,
        });
        if (
          isRecord(payload) &&
          (Object.keys(payload).length === 0 ||
            (Array.isArray(payload['results']) && payload['results'].length === 0))
        ) {
          return formatPayload(
            payload,
            'No spelling suggestion was returned; the query may already be correct.',
          );
        }
        return payload;
      },
    });
  }
}
