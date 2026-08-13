/**
 * `auth/webSearch` domain — experimental LangSearch provider contribution.
 *
 * Registers the LangSearch search-provider and semantic-rerank gate. Bound at
 * App scope.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const LANGSEARCH_WEB_SEARCH_FLAG_ID = 'langsearch-web-search';
export const LANGSEARCH_WEB_SEARCH_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_LANGSEARCH_WEB_SEARCH';

export const langSearchWebSearchFlag: FlagDefinitionInput = {
  id: LANGSEARCH_WEB_SEARCH_FLAG_ID,
  title: 'LangSearch web search',
  description:
    'Use LangSearch as a configurable WebSearch backend and optionally rerank search results with its semantic reranker.',
  env: LANGSEARCH_WEB_SEARCH_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(langSearchWebSearchFlag);
