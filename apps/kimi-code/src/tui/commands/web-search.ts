import {
  KIMI_CODE_PROVIDER_NAME,
  OPEN_PLATFORMS,
} from '@moonshot-ai/kimi-code-oauth';
import type {
  KimiConfig,
  MoonshotServiceConfig,
  RerankServiceConfig,
  SearchProvider,
  ServicesConfig,
} from '@moonshot-ai/kimi-code-sdk';

import {
  ChoicePickerComponent,
  type ChoiceOption,
} from '../components/dialogs/choice-picker';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';
import { isExperimentalFlagEnabled } from './experimental-flags';
import { promptApiKey, promptBaseUrl } from './prompts';

// ---------------------------------------------------------------------------
// /settings → Web Search — search and rerank provider configuration
// ---------------------------------------------------------------------------

const LANGSEARCH_EXPERIMENTAL_FLAG = 'langsearch-web-search';
const BRAVE_EXPERIMENTAL_FLAG = 'brave-search';
const ROOT_SEARCH_PROVIDER = 'search-provider';
const ROOT_ACTIVE_PROVIDER = 'active-provider';
const ROOT_RERANK_PROVIDER = 'rerank-provider';

// Provider selection now writes `services.activeSearchProvider` and persists the
// whole `[services]` section in one atomic write, so switching provider never
// deletes another provider's credentials. That write shape only exists on the
// v2 engine; v1 is reported as unsupported before anything is changed.
const V2_SELECTION_MESSAGE =
  'Brave Search and explicit provider selection require engine v2. No configuration was changed.';

const SEARCH_PROVIDER_VALUES = ['moonshot', 'langsearch', 'brave'] as const;
type SearchProviderChoice = (typeof SEARCH_PROVIDER_VALUES)[number];

const TIER_VALUES = ['free', 'tier1', 'tier2', 'tier3'] as const;
type LangSearchTier = (typeof TIER_VALUES)[number];

const RERANK_PROVIDER_VALUES = ['langsearch'] as const;
type RerankProviderChoice = (typeof RERANK_PROVIDER_VALUES)[number];

const RERANK_TOGGLE_VALUES = ['enabled', 'disabled'] as const;
type RerankToggle = (typeof RERANK_TOGGLE_VALUES)[number];

interface PickerOptions {
  readonly title: string;
  readonly options: readonly ChoiceOption[];
  readonly currentValue?: string;
  readonly notice?: string;
  readonly noticeTone?: 'success' | 'warning';
}

interface MoonshotOAuthSource {
  readonly baseUrl: string;
  readonly oauth: NonNullable<MoonshotServiceConfig['oauth']>;
}

/** Settings → Web Search entry with current provider state shown at the top. */
export async function showWebSearchConfig(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const services = config.services ?? {};
  const summary = currentProviderSummary(services);
  const action = await pickChoice(host, {
    title: 'Web Search',
    notice: `${summary.search}\n${summary.rerank}`,
    noticeTone: summary.hasWarning ? 'warning' : 'success',
    options: [
      {
        value: ROOT_SEARCH_PROVIDER,
        label: 'Web search provider',
        description: 'Configure Moonshot, LangSearch, or Brave for web search.',
      },
      {
        value: ROOT_ACTIVE_PROVIDER,
        label: 'Active web search provider',
        description: 'Select Brave, LangSearch, or Moonshot without changing credentials.',
      },
      {
        value: ROOT_RERANK_PROVIDER,
        label: 'Rerank provider',
        description: 'Configure and manage semantic reranking.',
      },
    ],
  });
  if (action === ROOT_SEARCH_PROVIDER) {
    await showSearchProviderMenu(host);
  } else if (action === ROOT_ACTIVE_PROVIDER) {
    await showActiveProviderMenu(host);
  } else if (action === ROOT_RERANK_PROVIDER) {
    await showRerankProviderMenu(host);
  }
}

async function showSearchProviderMenu(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const services = config.services ?? {};
  const selected = await pickChoice(host, {
    title: 'Web search provider',
    currentValue: services.activeSearchProvider,
    options: [
      {
        value: 'moonshot',
        label: 'Moonshot',
        description: 'Configure a Moonshot API key.',
      },
      {
        value: 'langsearch',
        label: 'LangSearch',
        description: isExperimentalFlagEnabled(LANGSEARCH_EXPERIMENTAL_FLAG)
          ? 'Use the LangSearch Web Search API.'
          : 'Enable LangSearch web search under Settings → Experiments first.',
      },
      {
        value: 'brave',
        label: 'Brave',
        description: isExperimentalFlagEnabled(BRAVE_EXPERIMENTAL_FLAG)
          ? 'Use the Brave Search API.'
          : 'Enable Brave Search under Settings → Experiments first.',
      },
    ],
  });
  if (!isSearchProviderChoice(selected)) return;
  if (!isExperimentalFlagEnabled(searchProviderFlag(selected))) {
    showSearchExperimentalNotice(host, selected);
    return;
  }
  if (!requireAtomicSelection(host)) return;

  if (isProviderComplete(services, selected)) {
    await manageSearchProvider(host, selected);
  } else {
    await configureSearchProvider(host, selected);
  }
}

async function showActiveProviderMenu(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const services = config.services ?? {};
  const provider = await pickChoice(host, {
    title: 'Active web search provider',
    currentValue: services.activeSearchProvider,
    options: SEARCH_PROVIDER_VALUES.map((value) => ({
      value,
      label: searchProviderLabel(value),
      description: providerAvailabilityDescription(services, value),
    })),
  });
  if (!isSearchProviderChoice(provider) || provider === services.activeSearchProvider) return;
  if (!isExperimentalFlagEnabled(searchProviderFlag(provider))) {
    showSearchExperimentalNotice(host, provider);
    return;
  }
  if (!isProviderComplete(services, provider)) {
    host.showError(`${searchProviderLabel(provider)} is not completely configured.`);
    return;
  }
  if (!requireAtomicSelection(host)) return;
  await useSearchProvider(host, provider);
}

async function manageSearchProvider(
  host: SlashCommandHost,
  provider: SearchProviderChoice,
): Promise<void> {
  const label = searchProviderLabel(provider);
  const action = await pickChoice(host, {
    title: `${label} web search`,
    options: [
      {
        value: 'edit',
        label: 'Edit configuration',
        description: `Replace the current ${label} search settings.`,
      },
      {
        value: 'remove',
        label: 'Remove provider',
        description: 'Remove this web search provider configuration.',
        tone: 'danger',
      },
    ],
  });
  if (action === 'edit') {
    await configureSearchProvider(host, provider);
  } else if (action === 'remove') {
    await removeSearchProvider(host, provider);
  }
}

/** Switch the active provider only — inactive providers keep their credentials. */
async function useSearchProvider(
  host: SlashCommandHost,
  provider: SearchProviderChoice,
): Promise<void> {
  await persistServices(
    host,
    { activeSearchProvider: provider },
    `${searchProviderLabel(provider)} selected for web search.`,
  );
}

async function configureSearchProvider(
  host: SlashCommandHost,
  provider: SearchProviderChoice,
): Promise<void> {
  if (provider === 'langsearch') {
    await configureLangSearch(host);
  } else if (provider === 'brave') {
    await configureBrave(host);
  } else {
    await configureMoonshot(host);
  }
}

async function configureLangSearch(host: SlashCommandHost): Promise<void> {
  const apiKey = await promptApiKey(host, 'LangSearch', [
    'Your key will be saved to ~/.kimi-code/config.toml under [services.langsearch].',
  ]);
  if (apiKey === undefined) return;

  const tier = await pickTier(host);
  if (tier === undefined) return;

  await persistServices(
    host,
    { langsearch: { apiKey, tier } },
    'LangSearch web search configured. Select it under Active web search provider to use it.',
  );
}

async function configureBrave(host: SlashCommandHost): Promise<void> {
  const apiKey = await promptApiKey(host, 'Brave', [
    'Your key will be saved to ~/.kimi-code/config.toml under [services.brave].',
  ]);
  if (apiKey === undefined) return;

  const baseUrlChoice = await pickChoice(host, {
    title: 'Brave Search API endpoint',
    options: [
      {
        value: 'default',
        label: 'Default endpoint',
        description: 'https://api.search.brave.com/res/v1',
      },
      {
        value: 'custom',
        label: 'Custom base URL',
        description: 'Use a compatible Brave Search API endpoint.',
      },
    ],
  });
  if (baseUrlChoice === undefined) return;
  const baseUrl =
    baseUrlChoice === 'custom' ? await promptBaseUrl(host, 'Brave Search') : undefined;
  if (baseUrlChoice === 'custom' && baseUrl === undefined) return;

  await persistServices(
    host,
    { brave: { apiKey, baseUrl } },
    'Brave web search configured. Select it under Active web search provider to use it.',
  );
}

async function configureMoonshot(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  const oauthSource = findMoonshotOAuthSource(config);
  const options: ChoiceOption[] = [];
  if (oauthSource !== undefined) {
    options.push({
      value: 'oauth',
      label: 'Kimi Code OAuth',
      description: 'Reuse the credentials from your existing Kimi Code login.',
    });
  }
  options.push({
    value: 'api-key',
    label: 'Moonshot API key',
    description: 'Configure Moonshot Search using an API key.',
  });

  const authMethod = await pickChoice(host, {
    title: 'Moonshot authentication',
    currentValue:
      config.services?.moonshotSearch?.oauth !== undefined ? 'oauth' : undefined,
    options,
  });
  if (authMethod === 'oauth' && oauthSource !== undefined) {
    await saveMoonshotConfig(host, {
      baseUrl: oauthSource.baseUrl,
      apiKey: '',
      oauth: oauthSource.oauth,
    });
  } else if (authMethod === 'api-key') {
    await configureMoonshotApiKey(host);
  }
}

async function configureMoonshotApiKey(host: SlashCommandHost): Promise<void> {
  const platformId = await pickChoice(host, {
    title: 'Moonshot API region',
    options: OPEN_PLATFORMS.map((platform) => ({
      value: platform.id,
      label: platform.name,
      description: platform.baseUrl,
    })),
  });
  const platform = OPEN_PLATFORMS.find((candidate) => candidate.id === platformId);
  if (platform === undefined) return;

  const apiKey = await promptApiKey(host, platform.name, [
    `${'search URL'.padEnd(12)}${searchUrlFromBaseUrl(platform.baseUrl)}`,
    `${'saved to'.padEnd(12)}~/.kimi-code/config.toml`,
  ]);
  if (apiKey === undefined) return;

  await saveMoonshotConfig(host, {
    baseUrl: searchUrlFromBaseUrl(platform.baseUrl),
    apiKey,
  });
}

async function saveMoonshotConfig(
  host: SlashCommandHost,
  service: MoonshotServiceConfig,
): Promise<void> {
  await persistServices(
    host,
    { moonshotSearch: service },
    'Moonshot web search configured. Select it under Active web search provider to use it.',
  );
}

async function removeSearchProvider(
  host: SlashCommandHost,
  provider: SearchProviderChoice,
): Promise<void> {
  const config = await host.harness.getConfig();
  const patch: Record<string, unknown> = { [serviceKey(provider)]: undefined };
  if (config.services?.activeSearchProvider === provider) {
    patch['activeSearchProvider'] = undefined;
  }
  await persistServices(host, patch, `${searchProviderLabel(provider)} web search removed.`);
}

async function showRerankProviderMenu(host: SlashCommandHost): Promise<void> {
  if (!isExperimentalFlagEnabled(LANGSEARCH_EXPERIMENTAL_FLAG)) {
    showSearchExperimentalNotice(host, 'langsearch');
    return;
  }
  const config = await host.harness.getConfig();
  const rerank = config.services?.rerank;
  const selected = await pickChoice(host, {
    title: 'Rerank provider',
    currentValue: rerank?.provider,
    options: [
      {
        value: 'langsearch',
        label: 'LangSearch',
        description: 'Reorder web search results using semantic relevance.',
      },
    ],
  });
  if (!isRerankProviderChoice(selected)) return;

  if (rerank?.provider === selected) {
    await editRerankProvider(host, rerank);
  } else {
    await setupRerankProvider(host, selected);
  }
}

async function setupRerankProvider(
  host: SlashCommandHost,
  provider: RerankProviderChoice,
): Promise<void> {
  const apiKey = await promptRerankApiKey(host);
  if (apiKey === undefined) return;
  const config = await host.harness.getConfig();
  if (!isNonEmpty(apiKey) && !isNonEmpty(config.services?.langsearch?.apiKey)) {
    host.showError(
      'A LangSearch API key is required when the search provider is not LangSearch.',
    );
    return;
  }

  const toggle = await pickRerankToggle(host);
  if (toggle === undefined) return;

  try {
    await host.harness.replaceService('rerank', {
      enabled: toggle === 'enabled',
      provider,
      apiKey: isNonEmpty(apiKey) ? apiKey : undefined,
    });
    await reloadSessionAfterWebSearchChange(host, 'Rerank configured.');
  } catch (error) {
    host.showError(`Failed to save rerank config: ${formatErrorMessage(error)}`);
  }
}

async function editRerankProvider(
  host: SlashCommandHost,
  rerank: RerankServiceConfig,
): Promise<void> {
  const action = await pickChoice(host, {
    title: 'LangSearch rerank',
    notice: `Current status: ${rerank.enabled === false ? 'disabled' : 'enabled'}`,
    options: [
      {
        value: 'status',
        label: 'Status',
        description: rerank.enabled === false ? 'Disabled' : 'Enabled',
      },
      {
        value: 'api-key',
        label: 'API key',
        description:
          isNonEmpty(rerank.apiKey)
            ? 'A dedicated rerank API key is configured.'
            : 'Reuses the LangSearch web search API key.',
      },
      {
        value: 'remove',
        label: 'Remove provider',
        description: 'Delete the rerank provider configuration.',
        tone: 'danger',
      },
    ],
  });

  if (action === 'status') {
    await editRerankStatus(host, rerank);
  } else if (action === 'api-key') {
    await editRerankApiKey(host, rerank);
  } else if (action === 'remove') {
    await removeRerankProvider(host);
  }
}

async function editRerankStatus(
  host: SlashCommandHost,
  rerank: RerankServiceConfig,
): Promise<void> {
  const current: RerankToggle = rerank.enabled === false ? 'disabled' : 'enabled';
  const toggle = await pickRerankToggle(host, current);
  if (toggle === undefined || toggle === current) return;

  try {
    await host.harness.replaceService('rerank', {
      ...rerank,
      enabled: toggle === 'enabled',
    });
    await reloadSessionAfterWebSearchChange(host, `Rerank ${toggle}.`);
  } catch (error) {
    host.showError(`Failed to update rerank status: ${formatErrorMessage(error)}`);
  }
}

async function editRerankApiKey(
  host: SlashCommandHost,
  rerank: RerankServiceConfig,
): Promise<void> {
  const apiKey = await promptRerankApiKey(host);
  if (apiKey === undefined) return;
  const config = await host.harness.getConfig();
  if (!isNonEmpty(apiKey) && !isNonEmpty(config.services?.langsearch?.apiKey)) {
    host.showError(
      'A LangSearch API key is required when the search provider is not LangSearch.',
    );
    return;
  }

  try {
    await host.harness.replaceService('rerank', {
      ...rerank,
      apiKey: isNonEmpty(apiKey) ? apiKey : undefined,
    });
    await reloadSessionAfterWebSearchChange(host, 'Rerank API key updated.');
  } catch (error) {
    host.showError(`Failed to update rerank API key: ${formatErrorMessage(error)}`);
  }
}

async function removeRerankProvider(host: SlashCommandHost): Promise<void> {
  try {
    await host.harness.removeService('rerank');
    await reloadSessionAfterWebSearchChange(host, 'Rerank provider removed.');
  } catch (error) {
    host.showError(`Failed to remove rerank provider: ${formatErrorMessage(error)}`);
  }
}

function promptRerankApiKey(host: SlashCommandHost): Promise<string | undefined> {
  return promptApiKey(
    host,
    'LangSearch Rerank',
    ['API key for rerank. Leave empty to reuse the LangSearch search key.'],
    { allowEmpty: true },
  );
}

function pickTier(host: SlashCommandHost): Promise<LangSearchTier | undefined> {
  return pickChoice(host, {
    title: 'LangSearch tier',
    options: TIER_VALUES.map((value) => ({
      value,
      label: value,
      description:
        value === 'free'
          ? 'Free tier — lowest rate limits.'
          : `${value} — higher rate limits.`,
    })),
  }).then((value) => (isLangSearchTier(value) ? value : undefined));
}

function pickRerankToggle(
  host: SlashCommandHost,
  currentValue?: RerankToggle,
): Promise<RerankToggle | undefined> {
  return pickChoice(host, {
    title: 'Rerank status',
    currentValue,
    options: [
      {
        value: 'enabled',
        label: 'Enabled',
        description: 'Rerank search results by relevance.',
      },
      {
        value: 'disabled',
        label: 'Disabled',
        description: 'Keep rerank configured but turned off.',
      },
    ],
  }).then((value) => (isRerankToggle(value) ? value : undefined));
}

function pickChoice(
  host: SlashCommandHost,
  options: PickerOptions,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: options.title,
      options: options.options,
      currentValue: options.currentValue,
      notice: options.notice,
      noticeTone: options.noticeTone,
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

/**
 * Persist search-provider changes as ONE atomic `[services]` write: merge the
 * patch over the current section, drop keys mapped to `undefined`, then reload
 * the session once. Callers must have passed `requireAtomicSelection` first.
 */
async function persistServices(
  host: SlashCommandHost,
  patch: Record<string, unknown>,
  statusMessage: string,
): Promise<void> {
  try {
    const config = await host.harness.getConfig();
    const services: Record<string, unknown> = { ...config.services, ...patch };
    for (const key of Object.keys(services)) {
      if (services[key] === undefined) delete services[key];
    }
    await host.harness.replaceConfigSections({ services });
    await reloadSessionAfterWebSearchChange(host, statusMessage);
  } catch (error) {
    host.showError(`Failed to save web search config: ${formatErrorMessage(error)}`);
  }
}

/** Explicit provider selection needs the v2 atomic write; v1 is reported, not corrupted. */
function requireAtomicSelection(host: SlashCommandHost): boolean {
  if (host.harness.supportsAtomicSectionReplace()) return true;
  host.showError(V2_SELECTION_MESSAGE);
  return false;
}

async function reloadSessionAfterWebSearchChange(
  host: SlashCommandHost,
  statusMessage: string,
): Promise<void> {
  if (host.session === undefined) {
    host.showStatus(statusMessage);
    return;
  }
  await host.session.reloadSession();
  await host.reloadCurrentSessionView(host.session, `${statusMessage} Session reloaded.`);
}

function findMoonshotOAuthSource(config: KimiConfig): MoonshotOAuthSource | undefined {
  const managed = config.providers[KIMI_CODE_PROVIDER_NAME];
  if (managed?.oauth !== undefined && isNonEmpty(managed.baseUrl)) {
    return {
      baseUrl: searchUrlFromBaseUrl(managed.baseUrl),
      oauth: managed.oauth,
    };
  }

  const service = config.services?.moonshotSearch;
  if (service?.oauth !== undefined && isNonEmpty(service.baseUrl)) {
    return {
      baseUrl: service.baseUrl,
      oauth: service.oauth,
    };
  }
  return undefined;
}

function currentProviderSummary(services: ServicesConfig): {
  readonly search: string;
  readonly rerank: string;
  readonly hasWarning: boolean;
} {
  const langSearchEnabled = isExperimentalFlagEnabled(LANGSEARCH_EXPERIMENTAL_FLAG);
  const selected = services.activeSearchProvider;
  const searchUnavailable =
    selected === undefined ||
    !isExperimentalFlagEnabled(searchProviderFlag(selected)) ||
    !isProviderComplete(services, selected);
  const search = searchSummaryLine(services, selected);

  const rerank = services.rerank;
  if (rerank?.provider === undefined) {
    return {
      search,
      rerank: 'Current rerank: not configured',
      hasWarning: searchUnavailable,
    };
  }
  const rerankLabel = rerankProviderLabel(rerank.provider);
  if (!langSearchEnabled) {
    return {
      search,
      rerank: `Current rerank: ${rerankLabel} configured, experimental feature disabled`,
      hasWarning: true,
    };
  }
  if (rerank.enabled === false) {
    return {
      search,
      rerank: `Current rerank: ${rerankLabel} disabled`,
      hasWarning: searchUnavailable,
    };
  }

  const hasKey = isNonEmpty(rerank.apiKey) || isNonEmpty(services.langsearch?.apiKey);
  return {
    search,
    rerank: `Current rerank: ${rerankLabel} ${hasKey ? 'enabled' : 'missing API key'}`,
    hasWarning: searchUnavailable || !hasKey,
  };
}

function searchSummaryLine(
  services: ServicesConfig,
  selected: SearchProvider | undefined,
): string {
  if (selected === undefined) return 'Current web search: not configured';
  const label = searchProviderLabel(selected);
  if (!isExperimentalFlagEnabled(searchProviderFlag(selected))) {
    return `Current web search: ${label} selected, experimental feature disabled`;
  }
  if (!isProviderComplete(services, selected)) {
    return `Current web search: ${label} selected, incomplete configuration`;
  }
  if (selected === 'moonshot') {
    const auth = services.moonshotSearch?.oauth !== undefined
      ? 'OAuth'
      : isNonEmpty(services.moonshotSearch?.apiKey)
        ? 'API key'
        : 'configured endpoint';
    return `Current web search: Moonshot (${auth})`;
  }
  if (selected === 'langsearch') {
    return `Current web search: LangSearch (tier: ${services.langsearch?.tier ?? 'free'})`;
  }
  return 'Current web search: Brave';
}

function isProviderComplete(services: ServicesConfig, provider: SearchProvider): boolean {
  if (provider === 'brave') return isNonEmpty(services.brave?.apiKey);
  if (provider === 'langsearch') return isNonEmpty(services.langsearch?.apiKey);
  return isNonEmpty(services.moonshotSearch?.baseUrl);
}

function providerAvailabilityDescription(
  services: ServicesConfig,
  provider: SearchProviderChoice,
): string {
  if (!isExperimentalFlagEnabled(searchProviderFlag(provider))) {
    return 'Experimental feature disabled.';
  }
  if (!isProviderComplete(services, provider)) return 'Not completely configured.';
  return 'Configured and available.';
}

function serviceKey(provider: SearchProviderChoice): 'moonshotSearch' | 'langsearch' | 'brave' {
  return provider === 'moonshot' ? 'moonshotSearch' : provider;
}

function searchProviderFlag(provider: SearchProvider): string | undefined {
  if (provider === 'langsearch') return LANGSEARCH_EXPERIMENTAL_FLAG;
  if (provider === 'brave') return BRAVE_EXPERIMENTAL_FLAG;
  return undefined;
}

function searchProviderLabel(provider: SearchProvider): string {
  if (provider === 'moonshot') return 'Moonshot';
  if (provider === 'langsearch') return 'LangSearch';
  return 'Brave';
}

function rerankProviderLabel(provider: RerankProviderChoice): string {
  return provider === 'langsearch' ? 'LangSearch' : provider;
}

function showSearchExperimentalNotice(
  host: SlashCommandHost,
  provider: SearchProviderChoice,
): void {
  if (provider === 'brave') {
    host.showNotice(
      'Enable “Brave Search” under Settings → Experiments before configuring Brave.',
    );
    return;
  }
  host.showNotice(
    'Enable “LangSearch web search” under Settings → Experiments before configuring LangSearch or rerank.',
  );
}

function searchUrlFromBaseUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/search`;
}

function isSearchProviderChoice(value: string | undefined): value is SearchProviderChoice {
  return value !== undefined && (SEARCH_PROVIDER_VALUES as readonly string[]).includes(value);
}

function isLangSearchTier(value: string | undefined): value is LangSearchTier {
  return value !== undefined && (TIER_VALUES as readonly string[]).includes(value);
}

function isRerankProviderChoice(value: string | undefined): value is RerankProviderChoice {
  return value !== undefined && (RERANK_PROVIDER_VALUES as readonly string[]).includes(value);
}

function isRerankToggle(value: string | undefined): value is RerankToggle {
  return value !== undefined && (RERANK_TOGGLE_VALUES as readonly string[]).includes(value);
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
