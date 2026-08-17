/**
 * `kimi search` sub-command — non-interactive web search backend management.
 *
 * Mirrors the TUI `/settings` → Web Search flow
 * (apps/kimi-code/src/tui/commands/web-search.ts) for users who want to
 * inspect or change web search and rerank configuration without launching the
 * TUI.
 *
 * Provider writes preserve inactive provider credentials and atomically replace
 * the complete `[services]` section when explicit selection is required.
 */

import {
  createKimiHarness,
  createKimiHarnessV2,
  type KimiConfig,
  type KimiHarness,
} from '@moonshot-ai/kimi-code-sdk';
import type { Command } from 'commander';

import { isKimiV2Enabled } from '#/cli/experimental-v2';
import { createKimiCodeHostIdentity } from '#/cli/version';

interface WritableLike {
  write(chunk: string): boolean;
}

export interface SearchDeps {
  readonly getHarness: () => KimiHarness;
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly close?: () => Promise<void>;
}

interface SetLangSearchOptions {
  readonly apiKey?: string;
  readonly tier?: string;
  readonly count?: string;
}

interface SetBraveOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
}

interface SetRerankOptions {
  readonly provider?: string;
  readonly apiKey?: string;
  readonly enabled?: string;
}

const LANGSEARCH_TIERS = ['free', 'tier1', 'tier2', 'tier3'] as const;
type LangSearchTier = (typeof LANGSEARCH_TIERS)[number];

const RERANK_PROVIDERS = ['langsearch'] as const;
type RerankProvider = (typeof RERANK_PROVIDERS)[number];

const V2_SELECTION_MESSAGE =
  'Brave Search and explicit provider selection require engine v2. No configuration was changed.\n';

interface TierLimit {
  readonly qps: number;
  readonly qpm: number;
  readonly qpd: number;
}

// Rate limits reflect LangSearch's published per-tier quotas.
const TIER_LIMITS: Record<LangSearchTier, TierLimit> = {
  free: { qps: 1, qpm: 60, qpd: 1_000 },
  tier1: { qps: 5, qpm: 200, qpd: 2_000 },
  tier2: { qps: 10, qpm: 500, qpd: 10_000 },
  tier3: { qps: 30, qpm: 2_000, qpd: 100_000 },
};

function isLangSearchTier(value: string): value is LangSearchTier {
  return (LANGSEARCH_TIERS as readonly string[]).includes(value);
}

function isRerankProvider(value: string): value is RerankProvider {
  return (RERANK_PROVIDERS as readonly string[]).includes(value);
}

export async function handleSearchStatus(deps: SearchDeps): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const services = config.services ?? {};
  const selected = services.activeSearchProvider;
  deps.stdout.write(`Selected web search provider: ${selected ?? 'not selected'}\n`);
  deps.stdout.write(`Active web search provider: ${activeBackend(services)}\n`);

  if (services.brave !== undefined) {
    deps.stdout.write(
      `Brave: ${providerStatus(hasValue(services.brave.apiKey), selected === 'brave')}\n`,
    );
  }
  const langsearch = services.langsearch;
  if (langsearch !== undefined) {
    deps.stdout.write(
      `LangSearch: tier=${langsearch.tier ?? 'free'}  count=${String(langsearch.count ?? 10)}  status=${providerStatus(hasValue(langsearch.apiKey), selected === 'langsearch')}\n`,
    );
  }
  if (services.moonshotSearch !== undefined) {
    deps.stdout.write(
      `Moonshot: ${providerStatus(hasMoonshotConfig(services), selected === 'moonshot')}\n`,
    );
  }

  const rerank = services.rerank;
  if (rerank?.provider !== undefined) {
    const hasApiKey = hasValue(rerank.apiKey) || hasValue(services.langsearch?.apiKey);
    const status = rerank.enabled === false
      ? 'disabled'
      : hasApiKey
        ? 'enabled'
        : 'missing API key';
    deps.stdout.write(`Rerank: ${status} (provider: ${rerank.provider})\n`);
  } else {
    deps.stdout.write('Rerank: not configured\n');
  }
}

export async function handleSearchSetLangSearch(
  deps: SearchDeps,
  opts: SetLangSearchOptions,
): Promise<void> {
  const apiKey = opts.apiKey;
  if (!hasValue(apiKey)) {
    deps.stderr.write('Missing API key. Pass --api-key <key>.\n');
    deps.exit(1);
  }

  const tier = opts.tier ?? 'free';
  if (!isLangSearchTier(tier)) {
    deps.stderr.write(
      `Invalid tier "${opts.tier}". Expected one of: ${LANGSEARCH_TIERS.join(', ')}.\n`,
    );
    deps.exit(1);
  }

  const count = opts.count === undefined ? 10 : parseCount(opts.count, deps);
  if (count === undefined) return;

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await requireAtomicSelection(harness, deps);
  await replaceServices(harness, config, {
    langsearch: { apiKey, tier, count },
    activeSearchProvider: 'langsearch',
  });

  deps.stdout.write(
    `LangSearch configured and selected: tier=${tier}  count=${String(count)}\n`,
  );
}

export async function handleSearchSetBrave(
  deps: SearchDeps,
  opts: SetBraveOptions,
): Promise<void> {
  if (!hasValue(opts.apiKey)) {
    deps.stderr.write('Missing API key. Pass --api-key <key>.\n');
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await requireAtomicSelection(harness, deps);
  await replaceServices(harness, config, {
    brave: { apiKey: opts.apiKey, baseUrl: hasValue(opts.baseUrl) ? opts.baseUrl : undefined },
    activeSearchProvider: 'brave',
  });
  deps.stdout.write('Brave Search configured and selected.\n');
}

export async function handleSearchUse(deps: SearchDeps, provider: string): Promise<void> {
  if (!isSearchProvider(provider)) {
    deps.stderr.write(`Unknown provider "${provider}". Use "brave", "langsearch", or "moonshot".\n`);
    deps.exit(1);
  }

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await requireAtomicSelection(harness, deps);
  if (!isProviderComplete(config.services ?? {}, provider)) {
    deps.stderr.write(`${searchProviderLabel(provider)} is not completely configured.\n`);
    deps.exit(1);
  }
  await replaceServices(harness, config, { activeSearchProvider: provider });
  deps.stdout.write(`${searchProviderLabel(provider)} selected for web search.\n`);
}

export async function handleSearchSetRerank(
  deps: SearchDeps,
  opts: SetRerankOptions,
): Promise<void> {
  const provider = opts.provider ?? 'langsearch';
  if (!isRerankProvider(provider)) {
    deps.stderr.write(
      `Unknown rerank provider "${opts.provider}". Only "langsearch" is supported.\n`,
    );
    deps.exit(1);
  }

  const enabled = opts.enabled === undefined ? true : parseBool(opts.enabled, deps, '--enabled');
  if (enabled === undefined) return;

  const apiKey = opts.apiKey;

  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  if (enabled && !hasValue(apiKey) && !hasValue(config.services?.langsearch?.apiKey)) {
    deps.stderr.write(
      'Missing API key. Pass --api-key <key> or configure LangSearch web search first.\n',
    );
    deps.exit(1);
  }

  await harness.replaceService('rerank', {
    enabled,
    provider,
    apiKey: hasValue(apiKey) ? apiKey : undefined,
  });

  deps.stdout.write(
    `Rerank configured: provider=${provider}  enabled=${String(enabled)}${apiKey && apiKey.length > 0 ? '  api_key=set' : '  api_key=reuse-langsearch'}\n`,
  );
}

export async function handleSearchClear(
  deps: SearchDeps,
  provider: string,
): Promise<void> {
  const harness = deps.getHarness();
  await harness.ensureConfigFile();
  const config = await harness.getConfig();
  const services = config.services ?? {};

  if (provider === 'brave' || provider === 'langsearch') {
    const key = provider === 'brave' ? 'brave' : 'langsearch';
    const label = searchProviderLabel(provider);
    if (services[key] === undefined) {
      deps.stdout.write(`${label} is not configured.\n`);
      return;
    }
    if (services.activeSearchProvider === provider) {
      const atomicConfig = await requireAtomicSelection(harness, deps, config);
      await replaceServices(harness, atomicConfig, {
        [key]: undefined,
        activeSearchProvider: undefined,
      });
    } else {
      await harness.removeService(key);
    }
    deps.stdout.write(`${label} web search cleared.\n`);
    return;
  }

  if (provider === 'rerank') {
    if (services.rerank === undefined) {
      deps.stdout.write('Rerank is not configured.\n');
      return;
    }
    await harness.removeService('rerank');
    deps.stdout.write('Rerank configuration cleared.\n');
    return;
  }

  deps.stderr.write(
    `Unknown provider "${provider}". Use "brave", "langsearch", or "rerank".\n`,
  );
  deps.exit(1);
}

export function handleSearchLimits(deps: SearchDeps): void {
  deps.stdout.write('LangSearch tier rate limits:\n\n');
  deps.stdout.write('  tier    qps   qpm     qpd\n');
  for (const tier of LANGSEARCH_TIERS) {
    const limit = TIER_LIMITS[tier];
    deps.stdout.write(
      `  ${tier.padEnd(7)} ${String(limit.qps).padStart(3)}   ${String(limit.qpm).padStart(5)}   ${String(limit.qpd).padStart(6)}\n`,
    );
  }
}

function activeBackend(services: NonNullable<KimiConfig['services']>): string {
  const selected = services.activeSearchProvider;
  if (selected === undefined) {
    if (hasValue(services.langsearch?.apiKey)) return 'LangSearch (legacy fallback)';
    if (hasMoonshotConfig(services)) return 'Moonshot (legacy fallback)';
    return 'not configured';
  }
  return isProviderComplete(services, selected)
    ? searchProviderLabel(selected)
    : 'unavailable (incomplete configuration)';
}

function providerStatus(configured: boolean, selected: boolean): string {
  const state = !configured ? 'incomplete configuration' : 'configured';
  return `${state}${selected ? ', selected' : ''}`;
}

async function requireAtomicSelection(
  harness: KimiHarness,
  deps: SearchDeps,
  config?: KimiConfig,
): Promise<KimiConfig> {
  if (!harness.supportsAtomicSectionReplace()) {
    deps.stderr.write(V2_SELECTION_MESSAGE);
    deps.exit(1);
  }
  return config ?? harness.getConfig();
}

async function replaceServices(
  harness: KimiHarness,
  config: KimiConfig,
  patch: Partial<NonNullable<KimiConfig['services']>>,
): Promise<void> {
  const services = { ...config.services, ...patch };
  for (const [key, value] of Object.entries(services)) {
    if (value === undefined) delete services[key as keyof typeof services];
  }
  await harness.replaceConfigSections({ services });
}

function isSearchProvider(value: string): value is NonNullable<
  NonNullable<KimiConfig['services']>['activeSearchProvider']
> {
  return value === 'brave' || value === 'langsearch' || value === 'moonshot';
}

function isProviderComplete(
  services: NonNullable<KimiConfig['services']>,
  provider: NonNullable<NonNullable<KimiConfig['services']>['activeSearchProvider']>,
): boolean {
  if (provider === 'brave') return hasValue(services.brave?.apiKey);
  if (provider === 'langsearch') return hasValue(services.langsearch?.apiKey);
  return hasMoonshotConfig(services);
}

function hasMoonshotConfig(services: NonNullable<KimiConfig['services']>): boolean {
  return hasValue(services.moonshotSearch?.baseUrl);
}

function searchProviderLabel(
  provider: NonNullable<NonNullable<KimiConfig['services']>['activeSearchProvider']>,
): string {
  if (provider === 'brave') return 'Brave';
  if (provider === 'langsearch') return 'LangSearch';
  return 'Moonshot';
}

function hasValue(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}

function parseCount(value: string, deps: SearchDeps): number | undefined {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    deps.stderr.write(`Invalid --count "${value}". Expected an integer between 1 and 10.\n`);
    deps.exit(1);
  }
  return n;
}

function parseBool(
  value: string,
  deps: SearchDeps,
  flag: string,
): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  deps.stderr.write(`Invalid ${flag} "${value}". Expected "true" or "false".\n`);
  deps.exit(1);
}

export function registerSearchCommand(parent: Command, deps?: Partial<SearchDeps>): void {
  const search = parent
    .command('search')
    .description('Manage the web search backend and rerank (LangSearch) non-interactively.');

  const runAction = async (
    resolved: ResolvedSearchDeps,
    run: () => Promise<void>,
  ): Promise<void> => {
    try {
      await run();
    } catch (error) {
      resolved.stderr.write(`${errorMessage(error)}\n`);
      resolved.exit(1);
    } finally {
      await resolved.close();
    }
  };

  search
    .command('status')
    .description('Show the active web search backend and rerank status.')
    .action(async () => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchStatus(resolved));
    });

  const setCmd = search
    .command('set')
    .description('Configure a web search provider or rerank.');

  setCmd
    .command('langsearch')
    .description('Configure the LangSearch web search backend.')
    .requiredOption('--api-key <key>', 'API key for the provider.')
    .option('--tier <tier>', 'LangSearch tier: free | tier1 | tier2 | tier3.', 'free')
    .option('--count <n>', 'Number of results to request (1–10).', '10')
    .action(async (options: SetLangSearchOptions) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchSetLangSearch(resolved, options));
    });

  setCmd
    .command('brave')
    .description('Configure the Brave Search backend.')
    .requiredOption('--api-key <key>', 'API key for the provider.')
    .option('--base-url <url>', 'Override the Brave Search API base URL.')
    .action(async (options: SetBraveOptions) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchSetBrave(resolved, options));
    });

  setCmd
    .command('rerank')
    .description('Configure the rerank provider.')
    .option('--provider <name>', 'Rerank provider: langsearch.', 'langsearch')
    .option('--api-key <key>', 'API key for rerank. Omit to reuse the LangSearch search key.')
    .option('--enabled <bool>', 'Enable rerank: true | false.', 'true')
    .action(async (options: SetRerankOptions) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchSetRerank(resolved, options));
    });

  search
    .command('use <provider>')
    .description('Select the active provider: brave | langsearch | moonshot.')
    .action(async (provider: string) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchUse(resolved, provider));
    });

  search
    .command('clear <provider>')
    .description('Remove a web search provider or rerank config. Use "brave", "langsearch", or "rerank".')
    .action(async (provider: string) => {
      const resolved = resolveDeps(deps);
      await runAction(resolved, () => handleSearchClear(resolved, provider));
    });

  search
    .command('limits')
    .description('Show the LangSearch tier rate-limit table.')
    .action(async () => {
      const resolved = resolveDeps(deps);
      try {
        handleSearchLimits(resolved);
      } finally {
        await resolved.close();
      }
    });
}

type ResolvedSearchDeps = SearchDeps & { readonly close: () => Promise<void> };

function resolveDeps(overrides: Partial<SearchDeps> = {}): ResolvedSearchDeps {
  let harness: KimiHarness | undefined;
  const identity = createKimiCodeHostIdentity();
  return {
    getHarness:
      overrides.getHarness ??
      (() => {
        harness ??= (isKimiV2Enabled() ? createKimiHarnessV2 : createKimiHarness)({ identity });
        return harness;
      }),
    stdout: overrides.stdout ?? process.stdout,
    stderr: overrides.stderr ?? process.stderr,
    exit: overrides.exit ?? ((code: number) => process.exit(code)),
    close:
      overrides.close ??
      (async () => {
        await harness?.close();
      }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}