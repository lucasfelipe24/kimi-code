import { beforeEach, describe, expect, it, vi } from 'vitest';

import { showWebSearchConfig } from '#/tui/commands/web-search';
import type { SlashCommandHost } from '#/tui/commands/dispatch';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';

type MountedPanel = {
  render: (width: number) => string[];
  handleInput: (data: string) => void;
};

interface TestConfig {
  readonly providers?: Record<string, unknown>;
  readonly services?: Record<string, unknown>;
}

interface HostExtras {
  harness: {
    getConfig: ReturnType<typeof vi.fn>;
    setConfig: ReturnType<typeof vi.fn>;
    replaceService: ReturnType<typeof vi.fn>;
    removeService: ReturnType<typeof vi.fn>;
    supportsAtomicSectionReplace: ReturnType<typeof vi.fn>;
    replaceConfigSections: ReturnType<typeof vi.fn>;
  };
  showStatus: ReturnType<typeof vi.fn>;
  showNotice: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  mountEditorReplacement: ReturnType<typeof vi.fn>;
  restoreEditor: ReturnType<typeof vi.fn>;
  reloadCurrentSessionView: ReturnType<typeof vi.fn>;
}

const ENTER = '\r';
const ESC = '\u001B';
const UP = '\u001B[A';
const DOWN = '\u001B[B';

function makeHost(
  config: TestConfig = {},
  session?: { reloadSession: ReturnType<typeof vi.fn> },
  options: { supportsAtomic?: boolean } = {},
): { host: SlashCommandHost & HostExtras; getMounted: () => MountedPanel | null } {
  let mounted: MountedPanel | null = null;
  const normalized = {
    providers: config.providers ?? {},
    services: config.services,
  };
  const host = {
    harness: {
      getConfig: vi.fn(async () => normalized),
      setConfig: vi.fn(async () => normalized),
      replaceService: vi.fn(async () => normalized),
      removeService: vi.fn(async () => normalized),
      supportsAtomicSectionReplace: vi.fn(() => options.supportsAtomic ?? true),
      replaceConfigSections: vi.fn(async () => {}),
    },
    session,
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    showError: vi.fn(),
    mountEditorReplacement: vi.fn((panel: MountedPanel) => {
      mounted = panel;
    }),
    restoreEditor: vi.fn(),
    reloadCurrentSessionView: vi.fn(async () => {}),
  } as unknown as SlashCommandHost & HostExtras;
  return { host, getMounted: () => mounted };
}

function renderedText(panel: MountedPanel): string {
  return panel.render(100).join('\n');
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

async function input(panel: MountedPanel, value: string): Promise<void> {
  panel.handleInput(value);
  await settle();
}

async function type(panel: MountedPanel, value: string): Promise<void> {
  for (const character of value) panel.handleInput(character);
  await settle();
}

describe('showWebSearchConfig', () => {
  beforeEach(() => {
    setExperimentalFeatures([
      { id: 'langsearch-web-search', enabled: true },
      { id: 'brave-search', enabled: true },
    ]);
  });

  it('shows current provider state and configuration, activation, and rerank menus', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'langsearch',
        langsearch: { apiKey: 'sk-test', tier: 'tier2' },
        rerank: { provider: 'langsearch', enabled: true },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    const panel = getMounted();
    expect(panel).not.toBeNull();
    const text = renderedText(panel!);
    expect(text).toContain('Current web search: LangSearch (tier: tier2)');
    expect(text).toContain('Current rerank: LangSearch enabled');
    expect(text).toContain('Web search provider');
    expect(text).toContain('Active web search provider');
    expect(text).toContain('Rerank provider');
    expect(text).not.toContain('Show current backend');
    expect(text).not.toContain('Activate LangSearch');

    await input(panel!, ESC);
    await pending;
  });

  it('shows a missing-key warning when rerank depends on an unconfigured LangSearch key', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'moonshot',
        moonshotSearch: {
          baseUrl: 'https://api.example.test/v1/search',
          apiKey: 'sk-search',
        },
        rerank: { provider: 'langsearch', enabled: true },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    expect(renderedText(getMounted()!)).toContain(
      'Current rerank: LangSearch missing API key',
    );
    await input(getMounted()!, ESC);
    await pending;
  });

  it('treats a Moonshot base URL without credentials as configured', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'moonshot',
        moonshotSearch: { baseUrl: 'https://search.example.test' },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    expect(renderedText(getMounted()!)).toContain(
      'Current web search: Moonshot (configured endpoint)',
    );
    await input(getMounted()!, DOWN); // Active web search provider
    await input(getMounted()!, ENTER);
    expect(renderedText(getMounted()!)).toContain('Moonshot ← current');
    expect(renderedText(getMounted()!)).toContain('Configured and available.');

    await input(getMounted()!, ESC);
    await pending;
  });

  it('marks the active search provider as current', async () => {
    const { host, getMounted } = makeHost({
      services: { activeSearchProvider: 'langsearch', langsearch: { apiKey: 'sk-test' } },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    const text = renderedText(getMounted()!);
    expect(text).toContain('Brave'); // Brave now offered in the menu
    expect(text).toContain('LangSearch ← current');
    expect(text).not.toContain('Moonshot ← current');

    await input(getMounted()!, ESC);
    await pending;
  });

  it('gates Brave behind its experimental flag without changing config', async () => {
    setExperimentalFeatures([
      { id: 'langsearch-web-search', enabled: true },
      { id: 'brave-search', enabled: false },
    ]);
    const { host, getMounted } = makeHost();
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, DOWN); // LangSearch
    await input(getMounted()!, DOWN); // Brave
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.showNotice).toHaveBeenCalledWith(
      'Enable “Brave Search” under Settings → Experiments before configuring Brave.',
    );
    expect(host.harness.replaceConfigSections).not.toHaveBeenCalled();
  });

  it('configures Brave and atomically preserves the inactive providers', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'moonshot',
        moonshotSearch: {
          baseUrl: 'https://api.example.test/v1/search',
          apiKey: 'sk-search',
        },
        langsearch: { apiKey: 'sk-langsearch' },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, DOWN); // LangSearch
    await input(getMounted()!, DOWN); // Brave
    await input(getMounted()!, ENTER);
    await type(getMounted()!, 'brave-test');
    await input(getMounted()!, ENTER);
    expect(renderedText(getMounted()!)).toContain('Default endpoint');
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.replaceConfigSections).toHaveBeenCalledWith({
      services: {
        activeSearchProvider: 'moonshot',
        moonshotSearch: {
          baseUrl: 'https://api.example.test/v1/search',
          apiKey: 'sk-search',
        },
        langsearch: { apiKey: 'sk-langsearch' },
        brave: { apiKey: 'brave-test', baseUrl: undefined },
      },
    });
    // Only the [services] section is rewritten — experimental flags are untouched.
    expect(Object.keys(host.harness.replaceConfigSections.mock.calls[0]![0])).toEqual([
      'services',
    ]);
    expect(host.harness.removeService).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith(
      'Brave web search configured. Select it under Active web search provider to use it.',
    );
  });

  it('configures a custom Brave base URL', async () => {
    const { host, getMounted } = makeHost();
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, DOWN);
    await input(getMounted()!, DOWN); // Brave
    await input(getMounted()!, ENTER);
    await type(getMounted()!, 'brave-test');
    await input(getMounted()!, ENTER);
    await input(getMounted()!, DOWN); // Custom base URL
    await input(getMounted()!, ENTER);
    await type(getMounted()!, 'https://brave.example.test/res/v1');
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.replaceConfigSections).toHaveBeenCalledWith({
      services: {
        brave: {
          apiKey: 'brave-test',
          baseUrl: 'https://brave.example.test/res/v1',
        },
      },
    });
  });

  it('switches the active provider without deleting inactive credentials', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'brave',
        brave: { apiKey: 'brave-test' },
        langsearch: { apiKey: 'sk-langsearch' },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN); // Active web search provider
    await input(getMounted()!, ENTER);
    expect(renderedText(getMounted()!)).toContain('Brave ← current');
    await input(getMounted()!, UP); // LangSearch
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.replaceConfigSections).toHaveBeenCalledWith({
      services: {
        activeSearchProvider: 'langsearch',
        brave: { apiKey: 'brave-test' },
        langsearch: { apiKey: 'sk-langsearch' },
      },
    });
    expect(host.harness.removeService).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('LangSearch selected for web search.');
  });

  it('atomically writes Moonshot OAuth and reloads the session once', async () => {
    const session = { reloadSession: vi.fn(async () => {}) };
    const { host, getMounted } = makeHost(
      {
        providers: {
          'managed:kimi-code': {
            type: 'kimi',
            baseUrl: 'https://api.kimi.com/coding/v1',
            oauth: { storage: 'file', key: 'oauth/kimi-code' },
          },
        },
        services: {
          activeSearchProvider: 'langsearch',
          langsearch: { apiKey: 'sk-langsearch' },
        },
      },
      session,
    );
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, UP); // Moonshot (LangSearch starts selected as active)
    await input(getMounted()!, ENTER); // Moonshot (not yet configured)
    expect(renderedText(getMounted()!)).toContain('Kimi Code OAuth');
    await input(getMounted()!, ENTER); // Kimi Code OAuth
    await pending;

    expect(host.harness.replaceConfigSections).toHaveBeenCalledWith({
      services: {
        activeSearchProvider: 'langsearch',
        langsearch: { apiKey: 'sk-langsearch' },
        moonshotSearch: {
          baseUrl: 'https://api.kimi.com/coding/v1/search',
          apiKey: '',
          oauth: { storage: 'file', key: 'oauth/kimi-code' },
        },
      },
    });
    expect(session.reloadSession).toHaveBeenCalledTimes(1);
    expect(host.reloadCurrentSessionView).toHaveBeenCalledWith(
      session,
      'Moonshot web search configured. Select it under Active web search provider to use it. Session reloaded.',
    );
  });

  it('configures Moonshot manually with an automatically derived search URL', async () => {
    const { host, getMounted } = makeHost();
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, ENTER); // Moonshot
    await input(getMounted()!, ENTER); // Moonshot API key (only auth option)
    expect(renderedText(getMounted()!)).toContain('Moonshot API region');
    await input(getMounted()!, ENTER); // China
    expect(renderedText(getMounted()!)).toContain(
      'https://api.moonshot.cn/v1/search',
    );
    await type(getMounted()!, 'sk-test');
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.replaceConfigSections).toHaveBeenCalledWith({
      services: {
        moonshotSearch: {
          baseUrl: 'https://api.moonshot.cn/v1/search',
          apiKey: 'sk-test',
        },
      },
    });
    expect(host.showStatus).toHaveBeenCalledWith(
      'Moonshot web search configured. Select it under Active web search provider to use it.',
    );
  });

  it('reports that provider selection needs engine v2 without corrupting config', async () => {
    const { host, getMounted } = makeHost(
      { services: { moonshotSearch: { baseUrl: 'https://x/search', apiKey: 'k' } } },
      undefined,
      { supportsAtomic: false },
    );
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN); // Active web search provider
    await input(getMounted()!, ENTER);
    await input(getMounted()!, ENTER); // Moonshot
    await pending;

    expect(host.showError).toHaveBeenCalledWith(
      'Brave Search and explicit provider selection require engine v2. No configuration was changed.',
    );
    expect(host.harness.replaceConfigSections).not.toHaveBeenCalled();
    expect(host.harness.replaceService).not.toHaveBeenCalled();
    expect(host.harness.removeService).not.toHaveBeenCalled();
  });

  it('removes the active search provider and clears the selection', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'langsearch',
        langsearch: { apiKey: 'sk-test' },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, ENTER); // Web search provider
    await input(getMounted()!, ENTER); // LangSearch (active + current, cursor starts here)
    expect(renderedText(getMounted()!)).toContain('Edit configuration');
    expect(renderedText(getMounted()!)).not.toContain('Select for web search');
    await input(getMounted()!, DOWN); // Remove provider
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.replaceConfigSections).toHaveBeenCalledWith({ services: {} });
    expect(host.showStatus).toHaveBeenCalledWith('LangSearch web search removed.');
  });

  it('configures rerank independently while Moonshot is the search provider', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'moonshot',
        moonshotSearch: {
          baseUrl: 'https://api.example.test/v1/search',
          apiKey: 'sk-search',
        },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN);
    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER); // Rerank provider
    await input(getMounted()!, ENTER); // LangSearch
    await type(getMounted()!, 'sk-rerank');
    await input(getMounted()!, ENTER);
    await input(getMounted()!, ENTER); // Enabled
    await pending;

    expect(host.harness.replaceService).toHaveBeenCalledWith('rerank', {
      provider: 'langsearch',
      enabled: true,
      apiKey: 'sk-rerank',
    });
    expect(host.harness.replaceConfigSections).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Rerank configured.');
  });

  it('edits the current rerank provider status', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'langsearch',
        langsearch: { apiKey: 'sk-search' },
        rerank: { provider: 'langsearch', enabled: true },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN);
    await input(getMounted()!, DOWN); // Rerank provider
    await input(getMounted()!, ENTER);
    expect(renderedText(getMounted()!)).toContain('LangSearch ← current');
    await input(getMounted()!, ENTER);
    expect(renderedText(getMounted()!)).toContain('Current status: enabled');
    await input(getMounted()!, ENTER); // Status
    expect(renderedText(getMounted()!)).toContain('Enabled ← current');
    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER); // Disabled
    await pending;

    expect(host.harness.replaceService).toHaveBeenCalledWith('rerank', {
      provider: 'langsearch',
      enabled: false,
    });
    expect(host.showStatus).toHaveBeenCalledWith('Rerank disabled.');
  });

  it('clears the dedicated rerank key so it reuses the search key', async () => {
    const { host, getMounted } = makeHost({
      services: {
        activeSearchProvider: 'langsearch',
        langsearch: { apiKey: 'sk-search' },
        rerank: {
          provider: 'langsearch',
          enabled: true,
          apiKey: 'sk-rerank',
        },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN);
    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER); // Rerank provider
    await input(getMounted()!, ENTER); // Current LangSearch
    await input(getMounted()!, DOWN); // API key
    await input(getMounted()!, ENTER);
    await input(getMounted()!, ENTER); // Empty means reuse search key
    await pending;

    expect(host.harness.removeService).not.toHaveBeenCalledWith('rerank');
    expect(host.harness.replaceService).toHaveBeenCalledWith('rerank', {
      provider: 'langsearch',
      enabled: true,
      apiKey: undefined,
    });
    expect(host.showStatus).toHaveBeenCalledWith('Rerank API key updated.');
  });

  it('removes the current rerank provider from its editor', async () => {
    const { host, getMounted } = makeHost({
      services: {
        rerank: {
          provider: 'langsearch',
          enabled: false,
          apiKey: 'sk-rerank',
        },
      },
    });
    const pending = showWebSearchConfig(host);
    await settle();

    await input(getMounted()!, DOWN);
    await input(getMounted()!, DOWN);
    await input(getMounted()!, ENTER); // Rerank provider
    await input(getMounted()!, ENTER); // Current LangSearch
    await input(getMounted()!, DOWN);
    await input(getMounted()!, DOWN); // Remove provider
    await input(getMounted()!, ENTER);
    await pending;

    expect(host.harness.removeService).toHaveBeenCalledWith('rerank');
    expect(host.showStatus).toHaveBeenCalledWith('Rerank provider removed.');
  });
});
