/**
 * `brave-search` domain — Brave Search API capability assembled as one Feature.
 *
 * Contributes the App-scoped client provider and ten on-demand Agent tools
 * gated by the Brave experimental flag, explicit provider selection, and a
 * nonblank current API key. Registered into the feature table at import.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { SERVICES_SECTION, type ServicesConfig } from '#/app/auth/configSection';
import { BRAVE_SEARCH_FLAG_ID } from '#/app/auth/webSearch/flag';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { BraveAnswersTool } from './answersTool';
import { IBraveSearchService } from './braveSearch';
import { BraveSearchService } from './braveSearchService';
import {
  IBraveAnswersTool,
  IBraveImageSearchTool,
  IBraveLLMContextTool,
  IBraveLocalSearchTool,
  IBraveNewsSearchTool,
  IBraveRichResultsTool,
  IBraveSpellcheckTool,
  IBraveSuggestTool,
  IBraveVideoSearchTool,
  IBraveWebSearchTool,
} from './contracts';
import { BraveLLMContextTool } from './contextTool';
import { BraveLocalSearchTool, BraveRichResultsTool } from './localRichTools';
import {
  BraveImageSearchTool,
  BraveNewsSearchTool,
  BraveSpellcheckTool,
  BraveSuggestTool,
  BraveVideoSearchTool,
  BraveWebSearchTool,
} from './searchTools';

export class BraveSearchFeature extends Feature {
  static override readonly name = 'brave-search';

  constructor() {
    super();
    this.contributeService(LifecycleScope.App, IBraveSearchService, BraveSearchService);
    const options = (name: string) => ({
      name,
      domain: 'brave-search',
      when: braveSearchEnabled,
    });
    this.contributeTool(
      IBraveWebSearchTool,
      BraveWebSearchTool,
      options('BraveWebSearch'),
    );
    this.contributeTool(
      IBraveNewsSearchTool,
      BraveNewsSearchTool,
      options('BraveNewsSearch'),
    );
    this.contributeTool(
      IBraveImageSearchTool,
      BraveImageSearchTool,
      options('BraveImageSearch'),
    );
    this.contributeTool(
      IBraveVideoSearchTool,
      BraveVideoSearchTool,
      options('BraveVideoSearch'),
    );
    this.contributeTool(
      IBraveLLMContextTool,
      BraveLLMContextTool,
      options('BraveLLMContext'),
    );
    this.contributeTool(IBraveAnswersTool, BraveAnswersTool, options('BraveAnswers'));
    this.contributeTool(IBraveSuggestTool, BraveSuggestTool, options('BraveSuggest'));
    this.contributeTool(
      IBraveSpellcheckTool,
      BraveSpellcheckTool,
      options('BraveSpellcheck'),
    );
    this.contributeTool(
      IBraveLocalSearchTool,
      BraveLocalSearchTool,
      options('BraveLocalSearch'),
    );
    this.contributeTool(
      IBraveRichResultsTool,
      BraveRichResultsTool,
      options('BraveRichResults'),
    );
  }
}

export function braveSearchEnabled(accessor: ServicesAccessor): boolean {
  if (!accessor.get(IFlagService).enabled(BRAVE_SEARCH_FLAG_ID)) return false;
  const services = accessor.get(IConfigService).get<ServicesConfig | undefined>(SERVICES_SECTION);
  return (
    services?.activeSearchProvider === 'brave' &&
    (services.brave?.apiKey?.trim().length ?? 0) > 0
  );
}

registerFeature(BraveSearchFeature);
