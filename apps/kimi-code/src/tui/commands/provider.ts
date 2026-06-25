import {
  applyCustomRegistryEntries,
  fetchCustomRegistry,
  type CustomRegistrySource,
  type ManagedKimiConfigShape,
} from '@moonshot-ai/kimi-code-oauth';
import {
  applyCatalogProvider,
  AuthCodeOAuthManager,
  catalogBaseUrl,
  catalogProviderModels,
  CatalogFetchError,
  DEFAULT_CATALOG_URL,
  fetchCatalog,
  inferWireType,
  OAUTH_PROVIDERS,
  type Catalog,
} from '@moonshot-ai/kimi-code-sdk';
import { FileTokenStorage } from '@moonshot-ai/kimi-code-oauth';
import { join } from 'node:path';

import { ChoicePickerComponent } from '../components/dialogs/choice-picker';
import {
  CustomRegistryImportDialogComponent,
  type CustomRegistryImportResult,
} from '../components/dialogs/custom-registry-import';
import {
  ProviderManagerComponent,
  type ProviderManagerOptions,
} from '../components/dialogs/provider-manager';
import { TabbedModelSelectorComponent } from '../components/dialogs/tabbed-model-selector';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import {
  promptApiKey,
  promptCatalogProviderSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// /provider command
// ---------------------------------------------------------------------------

export async function handleProviderCommand(host: SlashCommandHost): Promise<void> {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

function buildProviderManagerOptions(host: SlashCommandHost): ProviderManagerOptions {
  const activeProviderId =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  return {
    providers: host.state.appState.availableProviders,
    activeProviderId,
    onAdd: () => {
      void handleProviderAdd(host).catch((error: unknown) => {
        host.showError(`Add provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onDeleteSource: (providerIds) => {
      void handleProviderManagerDeleteSource(host, providerIds).catch((error: unknown) => {
        host.showError(`Remove provider failed: ${formatErrorMessage(error)}`);
      });
    },
    onClose: () => {
      host.restoreEditor();
    },
  };
}

async function handleProviderManagerDeleteSource(
  host: SlashCommandHost,
  providerIds: readonly string[],
): Promise<void> {
  for (const providerId of providerIds) {
    try {
      await handleProviderDelete(host, providerId);
    } catch (error) {
      const msg = formatErrorMessage(error);
      host.showError(`Failed to delete provider ${providerId}: ${msg}`);
    }
  }
  reopenProviderManager(host);
}

async function handleProviderDelete(host: SlashCommandHost, providerId: string): Promise<void> {
  if (providerId === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
    return;
  }

  // Clean up auth-code OAuth token if applicable
  await cleanupAuthCodeToken(host, providerId);

  const activeProvider =
    host.state.appState.availableModels[host.state.appState.model]?.provider;
  const config = await host.harness.removeProvider(providerId);
  if (activeProvider === providerId) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    host.setAppState({
      availableProviders: config.providers ?? {},
      availableModels: config.models ?? {},
    });
  }
}

/** Delete the stored OAuth token for an auth-code provider. */
async function cleanupAuthCodeToken(
  host: SlashCommandHost,
  providerId: string,
): Promise<void> {
  const def = OAUTH_PROVIDERS[providerId] ??
    Object.values(OAUTH_PROVIDERS).find((d) => d.providerName === providerId);
  if (def === undefined) return;

  const storage = new FileTokenStorage(
    join(host.harness.homeDir, 'credentials'),
  );
  const manager = new AuthCodeOAuthManager({
    config: def.flowConfig,
    storage,
    configDir: host.harness.homeDir,
  });
  try {
    await manager.logout();
  } catch {
    // Token file may not exist — ignore
  }
}

async function handleProviderAdd(host: SlashCommandHost): Promise<void> {
  const source = await promptProviderAddSource(host);
  if (source === undefined) {
    reopenProviderManager(host);
    return;
  }

  if (source === 'known') {
    await handleCatalogProviderAdd(host);
    return;
  }
  if (source === 'oauth') {
    await handleOAuthProviderAdd(host);
    return;
  }
  const handled = await handleCustomRegistryAddViaDialog(host);
  if (!handled) {
    reopenProviderManager(host);
  }
}

function reopenProviderManager(host: SlashCommandHost): void {
  const options = buildProviderManagerOptions(host);
  const component = new ProviderManagerComponent(options);
  host.mountEditorReplacement(component);
}

async function handleOAuthProviderAdd(host: SlashCommandHost): Promise<void> {
  const config = await host.harness.getConfig();
  if (config.experimental?.['third_party_oauth'] !== true) {
    host.showError(
      'Third-party OAuth is experimental. Set experimental.third_party_oauth = true in config.toml.',
    );
    return;
  }

  const providers = Object.values(OAUTH_PROVIDERS);
  if (providers.length === 0) {
    host.showError('No OAuth providers available.');
    return;
  }

  const picker = new ChoicePickerComponent({
    title: 'Select OAuth provider',
    options: providers.map((p) => ({
      value: p.id,
      label: p.flowConfig.displayName,
    })),
    onSelect: (providerId) => {
      host.restoreEditor();
      void runOAuthLogin(host, providerId).catch((error: unknown) => {
        host.showError(`OAuth login failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(picker);
}

async function runOAuthLogin(
  host: SlashCommandHost,
  providerId: string,
): Promise<void> {
  const def = OAUTH_PROVIDERS[providerId];
  if (def === undefined) {
    host.showError(`Unknown OAuth provider: ${providerId}`);
    return;
  }

  const spinner = host.showLoginProgressSpinner(`Opening browser for ${providerId} login...`);
  const homeDir = host.harness.homeDir;
  const storage = new FileTokenStorage(join(homeDir, 'credentials'));
  const manager = new AuthCodeOAuthManager({
    config: def.flowConfig,
    storage,
    configDir: homeDir,
  });

  try {
    const result = await manager.login();
    spinner.stop({ ok: true, label: `Logged in to ${providerId}.` });

    // Fetch available models from the Codex API
    let codexModels: Array<{ slug: string; display_name: string; context_window: number; input_modalities: string[] }> = [];
    try {
      if (def.baseUrl) {
        const modelsResp = await fetch(`${def.baseUrl}/models?client_version=1.0.0`, {
          headers: {
            'Authorization': `Bearer ${result.token.accessToken}`,
            'Origin': 'https://chatgpt.com',
            'Referer': 'https://chatgpt.com/codex',
            'User-Agent': 'kimi-code',
          },
        });
        if (modelsResp.ok) {
          const modelsData = await modelsResp.json() as { models: Array<{ slug: string; display_name: string; context_window: number; input_modalities: string[]; visibility: string }> };
          codexModels = (modelsData.models ?? [])
            .filter((m) => m.visibility !== 'hide' && m.slug !== 'codex-auto-review')
            .map((m) => ({
              slug: m.slug,
              display_name: m.display_name,
              context_window: m.context_window,
              input_modalities: m.input_modalities ?? [],
            }));
        }
      }
    } catch {
      // Non-critical
    }

    // Build model entries
    const models: Record<string, { provider: string; model: string; maxContextSize: number; capabilities?: string[]; displayName?: string }> = {};
    for (const m of codexModels) {
      const modelAlias = `${def.providerName}/${m.slug}`;
      const caps: string[] = ['tool_use', 'thinking'];
      if (m.input_modalities.includes('image')) caps.push('image_in');
      models[modelAlias] = {
        provider: def.providerName,
        model: m.slug,
        maxContextSize: m.context_window,
        capabilities: caps,
        displayName: m.display_name,
      };
    }

    // Fallback default model
    const defaultAlias = `${def.providerName}/${def.defaultModel}`;
    if (!models[defaultAlias]) {
      models[defaultAlias] = {
        provider: def.providerName,
        model: def.defaultModel,
        maxContextSize: 272_000,
        capabilities: ['tool_use', 'thinking', 'image_in'],
      };
    }

    const config = await host.harness.getConfig();
    const providerEntry: Record<string, unknown> = {
      type: def.wireType,
      defaultModel: def.defaultModel,
    };
    if (def.baseUrl) providerEntry['baseUrl'] = def.baseUrl;
    providerEntry['customHeaders'] = {
      Origin: 'https://chatgpt.com',
      Referer: 'https://chatgpt.com/codex',
    };

    await host.harness.setConfig({
      providers: { [def.providerName]: providerEntry },
      models,
      ...(config.defaultModel === undefined ? { defaultModel: defaultAlias } : {}),
    });

    await host.authFlow.refreshConfigAfterLogin();
    host.showStatus(`OAuth login successful. Provider: ${providerId} (${Object.keys(models).length} models)`, 'success');
  } catch (error) {
    spinner.stop({ ok: false, label: 'OAuth login failed.' });
    throw error;
  }
}

function promptProviderAddSource(
  host: SlashCommandHost,
): Promise<'known' | 'custom' | 'oauth' | undefined> {
  return new Promise((resolve) => {
    const picker = new ChoicePickerComponent({
      title: 'Add provider',
      options: [
        { value: 'known', label: 'Known third-party provider' },
        { value: 'custom', label: 'Custom registry (api.json)' },
        { value: 'oauth', label: 'OAuth login (OpenAI, etc.)' },
      ],
      onSelect: (value) => {
        host.restoreEditor();
        resolve(value === 'known' || value === 'custom' || value === 'oauth' ? value : undefined);
      },
      onCancel: () => {
        host.restoreEditor();
        resolve(undefined);
      },
    });
    host.mountEditorReplacement(picker);
  });
}

async function handleCatalogProviderAdd(host: SlashCommandHost): Promise<void> {
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancel;

  const spinner = host.showLoginProgressSpinner(`Fetching catalog from ${DEFAULT_CATALOG_URL}`);
  let catalog: Catalog | undefined;
  try {
    catalog = await fetchCatalog(DEFAULT_CATALOG_URL, controller.signal);
    spinner.stop({ ok: true, label: 'Catalog loaded.' });
  } catch (error) {
    if (controller.signal.aborted) {
      spinner.stop({ ok: false, label: 'Aborted.' });
    } else {
      const hint = error instanceof CatalogFetchError ? ` (HTTP ${error.status})` : '';
      spinner.stop({ ok: false, label: 'Failed to load catalog.' });
      host.showError(`Failed to fetch catalog${hint}: ${formatErrorMessage(error)}`);
    }
  } finally {
    if (host.cancelInFlight === cancel) host.cancelInFlight = undefined;
  }

  if (catalog === undefined) return;

  const providerId = await promptCatalogProviderSelection(host, catalog);
  if (providerId === undefined) return;
  const entry = catalog[providerId];
  if (entry === undefined) return;

  const models = catalogProviderModels(entry);
  if (models.length === 0) {
    host.showError(`Provider "${providerId}" has no usable models in this catalog.`);
    return;
  }

  const apiKey = await promptApiKey(host, entry.name ?? providerId);
  if (apiKey === undefined) return;

  const wire = inferWireType(entry);
  if (wire === undefined) {
    host.showError(`Provider "${providerId}" has unsupported wire type.`);
    return;
  }
  const baseUrl = catalogBaseUrl(entry, wire);

  // Persist the provider and all its models immediately after the api key is
  // entered. The model selector that follows is just a convenience to pick the
  // default model; ESC leaves the provider in place without a default selection.
  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[providerId] !== undefined) {
    await host.harness.removeProvider(providerId);
  }

  const config = await host.harness.getConfig();
  applyCatalogProvider(config, {
    providerId,
    wire,
    baseUrl,
    apiKey,
    models,
    selectedModelId: '', // no default yet; user picks in the model selector
    thinking: false,    // will be resolved by the model selector
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('connect', { provider: providerId, method: 'catalog' });
  host.showStatus(`Provider added: ${entry.name ?? providerId}`);

  // Build a merged model dictionary that includes existing models plus the
  // newly-persisted provider's models, so the tabbed selector shows every
  // provider's tab (the new provider's tab starts active via initialTabId).
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const mergedModels = { ...stateModels };

  const selector = new TabbedModelSelectorComponent({
    models: mergedModels,
    currentValue: host.state.appState.model,
    selectedValue: Object.keys(mergedModels).find((a) => a.startsWith(`${providerId}/`)),
    currentThinking: host.state.appState.thinking,
    initialTabId: providerId,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
}

async function setDefaultModel(
  host: SlashCommandHost,
  alias: string,
  thinking: boolean,
): Promise<void> {
  await host.harness.setConfig({
    defaultModel: alias,
    defaultThinking: thinking,
  });
  await host.authFlow.refreshConfigAfterLogin();
  host.track('model_switch', { model: alias });
  host.showStatus(`Default model set to ${alias} with thinking ${thinking ? 'on' : 'off'}.`);
}

async function handleCustomRegistryAddViaDialog(host: SlashCommandHost): Promise<boolean> {
  const value = await promptCustomRegistryImport(host);
  if (value === undefined) return false;

  const source: CustomRegistrySource = {
    kind: 'apiJson',
    url: value.url,
    apiKey: value.apiKey,
  };

  let entries: Awaited<ReturnType<typeof fetchCustomRegistry>>;
  try {
    entries = await fetchCustomRegistry(source);
  } catch (error) {
    host.showError(`Failed to import registry: ${formatErrorMessage(error)}`);
    return false;
  }

  const addedProviderIds = Object.values(entries).map((entry) => entry.id);
  try {
    const config = await host.harness.getConfig();
    applyCustomRegistryEntries(
      config as unknown as ManagedKimiConfigShape,
      entries,
      source,
    );
    await host.harness.setConfig({
      providers: config.providers,
      models: config.models,
    });
    await host.authFlow.refreshConfigAfterLogin();
  } catch (error) {
    host.showError(`Failed to apply registry: ${formatErrorMessage(error)}`);
    return false;
  }

  const count = addedProviderIds.length;
  if (count === 0) {
    host.showStatus('Registry contained no providers.');
    return false;
  }
  host.showStatus(
    count === 1
      ? 'Imported 1 provider from registry.'
      : `Imported ${String(count)} providers from registry.`,
    'success',
  );

  // Offer the model selector so the user can pick a default, just like the
  // catalog (known-provider) flow.
  const stateModels = await host.harness.getConfig().then((c) => c.models ?? {});
  const firstNewAlias = Object.keys(stateModels).find((a) =>
    addedProviderIds.some((pid) => a.startsWith(`${pid}/`)),
  );
  const firstNewProvider = firstNewAlias
    ? stateModels[firstNewAlias]?.provider
    : addedProviderIds[0];
  const selector = new TabbedModelSelectorComponent({
    models: stateModels,
    currentValue: host.state.appState.model,
    selectedValue: firstNewAlias,
    currentThinking: host.state.appState.thinking,
    initialTabId: firstNewProvider,
    onSelect: ({ alias, thinking }) => {
      host.restoreEditor();
      void setDefaultModel(host, alias, thinking).catch((error: unknown) => {
        host.showError(`Set default model failed: ${formatErrorMessage(error)}`);
      });
    },
    onCancel: () => {
      host.restoreEditor();
    },
  });
  host.mountEditorReplacement(selector);
  return true;
}

function promptCustomRegistryImport(
  host: SlashCommandHost,
): Promise<{ readonly url: string; readonly apiKey: string } | undefined> {
  return new Promise((resolve) => {
    const dialog = new CustomRegistryImportDialogComponent(
      (result: CustomRegistryImportResult) => {
        host.restoreEditor();
        resolve(result.kind === 'ok' ? result.value : undefined);
      },
    );
    host.mountEditorReplacement(dialog);
  });
}
