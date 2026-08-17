import type { KimiConfig, KimiHarness } from '@moonshot-ai/kimi-code-sdk';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import {
  handleSearchClear,
  handleSearchSetBrave,
  handleSearchSetLangSearch,
  handleSearchStatus,
  handleSearchUse,
  registerSearchCommand,
  type SearchDeps,
} from '#/cli/sub/search';

interface TestContext {
  readonly deps: SearchDeps;
  readonly ensureConfigFile: ReturnType<typeof vi.fn>;
  readonly getConfig: ReturnType<typeof vi.fn>;
  readonly supportsAtomicSectionReplace: ReturnType<typeof vi.fn>;
  readonly replaceConfigSections: ReturnType<typeof vi.fn>;
  readonly replaceService: ReturnType<typeof vi.fn>;
  readonly setConfig: ReturnType<typeof vi.fn>;
  readonly removeService: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly stdout: () => string;
  readonly stderr: () => string;
}

function makeContext(config?: KimiConfig): TestContext {
  let stdout = '';
  let stderr = '';
  const resolvedConfig = config ?? { providers: {} };
  const ensureConfigFile = vi.fn(async () => {});
  const getConfig = vi.fn(async () => resolvedConfig);
  const supportsAtomicSectionReplace = vi.fn(() => true);
  const replaceConfigSections = vi.fn(async () => {});
  const replaceService = vi.fn(async () => resolvedConfig);
  const setConfig = vi.fn(async () => resolvedConfig);
  const removeService = vi.fn(async () => resolvedConfig);
  const close = vi.fn(async () => {});
  const harness = {
    ensureConfigFile,
    getConfig,
    supportsAtomicSectionReplace,
    replaceConfigSections,
    replaceService,
    setConfig,
    removeService,
    close,
  } as unknown as KimiHarness;

  return {
    deps: {
      getHarness: () => harness,
      stdout: {
        write: (chunk: string) => {
          stdout += chunk;
          return true;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
          return true;
        },
      },
      exit: (code: number): never => {
        throw new Error(`exit:${String(code)}`);
      },
      close,
    },
    ensureConfigFile,
    getConfig,
    supportsAtomicSectionReplace,
    replaceConfigSections,
    replaceService,
    setConfig,
    removeService,
    close,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe('kimi search', () => {
  it('parses the nested set langsearch command and writes its config', async () => {
    const context = makeContext();
    const program = new Command();
    program.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    registerSearchCommand(program, context.deps);

    await program.parseAsync([
      'node',
      'kimi',
      'search',
      'set',
      'langsearch',
      '--api-key',
      'sk-test',
      '--tier',
      'tier2',
      '--count',
      '10',
    ]);

    expect(context.replaceConfigSections).toHaveBeenCalledWith({
      services: {
        langsearch: { apiKey: 'sk-test', tier: 'tier2', count: 10 },
        activeSearchProvider: 'langsearch',
      },
    });
    expect(context.stdout()).toContain('LangSearch configured and selected: tier=tier2  count=10');
    expect(context.close).toHaveBeenCalledTimes(1);
  });

  it('rejects result counts above the Web Search API maximum', async () => {
    const context = makeContext();

    await expect(
      handleSearchSetLangSearch(context.deps, {
        apiKey: 'sk-test',
        count: '11',
      }),
    ).rejects.toThrow('exit:1');

    expect(context.stderr()).toContain('Expected an integer between 1 and 10');
    expect(context.setConfig).not.toHaveBeenCalled();
  });

  it('clears LangSearch through the explicit removal API', async () => {
    const context = makeContext({
      providers: {},
      services: {
        langsearch: { apiKey: 'sk-test' },
        rerank: { enabled: true, provider: 'langsearch', apiKey: 'sk-rerank-test' },
      },
    });

    await handleSearchClear(context.deps, 'langsearch');

    expect(context.removeService).toHaveBeenCalledWith('langsearch');
    expect(context.stdout()).toContain('LangSearch web search cleared.');
  });

  it('configures and selects Brave without touching inactive providers', async () => {
    const context = makeContext({
      providers: {},
      services: {
        activeSearchProvider: 'moonshot',
        moonshotSearch: { baseUrl: 'https://search.example.test', apiKey: 'sk-moonshot' },
        langsearch: { apiKey: 'sk-langsearch' },
        rerank: { enabled: true, provider: 'langsearch' },
      },
    });

    await handleSearchSetBrave(context.deps, { apiKey: 'brave-test' });

    expect(context.replaceConfigSections).toHaveBeenCalledWith({
      services: {
        activeSearchProvider: 'brave',
        moonshotSearch: { baseUrl: 'https://search.example.test', apiKey: 'sk-moonshot' },
        langsearch: { apiKey: 'sk-langsearch' },
        brave: { apiKey: 'brave-test', baseUrl: undefined },
        rerank: { enabled: true, provider: 'langsearch' },
      },
    });
    expect(context.replaceService).not.toHaveBeenCalled();
  });

  it('switches providers without deleting inactive credentials', async () => {
    const context = makeContext({
      providers: {},
      services: {
        activeSearchProvider: 'brave',
        brave: { apiKey: 'brave-test' },
        langsearch: { apiKey: 'sk-langsearch' },
      },
    });

    await handleSearchUse(context.deps, 'langsearch');

    expect(context.replaceConfigSections).toHaveBeenCalledWith({
      services: {
        activeSearchProvider: 'langsearch',
        brave: { apiKey: 'brave-test' },
        langsearch: { apiKey: 'sk-langsearch' },
      },
    });
  });

  it('refuses Brave on v1 before changing configuration', async () => {
    const context = makeContext();
    context.supportsAtomicSectionReplace.mockReturnValue(false);

    await expect(
      handleSearchSetBrave(context.deps, { apiKey: 'brave-test' }),
    ).rejects.toThrow('exit:1');

    expect(context.stderr()).toContain('require engine v2');
    expect(context.replaceConfigSections).not.toHaveBeenCalled();
    expect(context.replaceService).not.toHaveBeenCalled();
  });

  it('reports Brave and LangSearch as configured', async () => {
    const context = makeContext({
      providers: {},
      services: {
        activeSearchProvider: 'brave',
        brave: { apiKey: 'brave-test' },
        langsearch: { apiKey: 'sk-langsearch', tier: 'tier2' },
      },
    });

    await handleSearchStatus(context.deps);

    expect(context.stdout()).toContain('Selected web search provider: brave');
    expect(context.stdout()).toContain('Active web search provider: Brave');
    expect(context.stdout()).toContain('Brave: configured, selected');
    expect(context.stdout()).toContain('LangSearch: tier=tier2  count=10  status=configured');
  });

  it('uses legacy LangSearch precedence when no provider is selected', async () => {
    const context = makeContext({
      providers: {},
      services: {
        langsearch: { apiKey: 'sk-langsearch' },
        moonshotSearch: { baseUrl: 'https://search.example.test' },
      },
    });

    await handleSearchStatus(context.deps);

    expect(context.stdout()).toContain('Selected web search provider: not selected');
    expect(context.stdout()).toContain('Active web search provider: LangSearch (legacy fallback)');
  });

  it('reports anonymous Moonshot endpoints as the legacy fallback and configured', async () => {
    const context = makeContext({
      providers: {},
      services: { moonshotSearch: { baseUrl: 'https://search.example.test' } },
    });

    await handleSearchStatus(context.deps);

    expect(context.stdout()).toContain('Selected web search provider: not selected');
    expect(context.stdout()).toContain('Active web search provider: Moonshot (legacy fallback)');
    expect(context.stdout()).toContain('Moonshot: configured');
  });

  it('reports an actionable status when no backend is configured', async () => {
    const context = makeContext();

    await handleSearchStatus(context.deps);

    expect(context.stdout()).toBe(
      'Selected web search provider: not selected\nActive web search provider: not configured\nRerank: not configured\n',
    );
  });
});
