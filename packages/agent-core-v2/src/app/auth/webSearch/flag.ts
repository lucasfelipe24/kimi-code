/**
 * `auth/webSearch` domain — experimental search-provider flag contributions.
 *
 * Registers the Brave and LangSearch search-provider gates, including the
 * LangSearch semantic-rerank capability. Bound at App scope.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const BRAVE_SEARCH_FLAG_ID = 'brave-search';
export const BRAVE_SEARCH_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_BRAVE_SEARCH';
export const LANGSEARCH_WEB_SEARCH_FLAG_ID = 'langsearch-web-search';
export const LANGSEARCH_WEB_SEARCH_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_LANGSEARCH_WEB_SEARCH';

export const braveSearchFlag: FlagDefinitionInput = {
  id: BRAVE_SEARCH_FLAG_ID,
  title: 'Brave Search',
  description: 'Use Brave Search as a configurable WebSearch backend.',
  env: BRAVE_SEARCH_FLAG_ENV,
  default: true,
  surface: 'both',
};

export const langSearchWebSearchFlag: FlagDefinitionInput = {
  id: LANGSEARCH_WEB_SEARCH_FLAG_ID,
  title: 'LangSearch web search',
  description:
    'Use LangSearch as a configurable WebSearch backend and optionally rerank search results with its semantic reranker.',
  env: LANGSEARCH_WEB_SEARCH_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(braveSearchFlag);
registerFlagDefinition(langSearchWebSearchFlag);
