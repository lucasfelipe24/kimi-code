/**
 * `auth` domain (cross-cutting) — `IWebSearchProviderService` implementation.
 *
 * Resolves an explicitly selected Brave, LangSearch, or Moonshot backend from
 * the `services` config without fallback when that selection is unavailable.
 * Without a selector it preserves the legacy LangSearch → configured Moonshot
 * → managed OAuth precedence. LangSearch availability is gated through `flag`;
 * Brave availability is determined by its configuration, and optional reranking
 * remains independent of provider choice.
 * Moonshot OAuth references are resolved through `auth`, managed provider data
 * through `provider`, config through `config`, host headers through `bootstrap`
 * and `agentIdentity`, and rerank providers through `auth/webSearch`. Bound at
 * App scope.
 */

import {
  KIMI_CODE_PROVIDER_NAME,
  kimiCodeBaseUrl,
  type BearerTokenProvider,
} from '@moonshot-ai/kimi-code-oauth';

import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';
import { IAgentIdentity } from '#/app/agentIdentity/agentIdentity';
import { IOAuthService } from '#/app/auth/auth';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IProviderService, type ProviderConfig } from '#/kosong/provider/provider';
import { isOAuthCatalogVendor } from '#/kosong/provider/providerDefinition';

import { SERVICES_SECTION, type ServicesConfig } from '../configSection';
import { LANGSEARCH_WEB_SEARCH_FLAG_ID } from './flag';
import { BraveWebSearchProvider } from './providers/brave-web-search';
import { LangSearchWebSearchProvider } from './providers/langsearch-web-search';
import { MoonshotWebSearchProvider } from './providers/moonshot-web-search';
import { RateLimiter, TIER_LIMITS, type LangSearchTier } from './providers/rateLimiter';
import { RerankingWebSearchProvider } from './providers/reranking-web-search';
import { IRerankService } from './rerank';
import { IWebSearchProviderService } from './webSearch';

export class WebSearchProviderService implements IWebSearchProviderService {
  declare readonly _serviceBrand: undefined;
  private langSearchLimiter: { readonly tier: LangSearchTier; readonly value: RateLimiter } | undefined;

  constructor(
    @IProviderService private readonly providers: IProviderService,
    @IOAuthService private readonly oauth: IOAuthService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IRerankService private readonly rerankService: IRerankService,
    @IAgentIdentity private readonly identity: IAgentIdentity,
  ) {}

  getWebSearchProvider(): WebSearchProvider | undefined {
    const services = this.config.get<ServicesConfig>(SERVICES_SECTION);
    const limiter = this.resolveLangSearchLimiter(services);
    const search = this.resolveSearchProvider(services, limiter);
    if (search === undefined) return undefined;
    const reranker = this.rerankService.getRerankProvider(limiter);
    return reranker !== undefined ? new RerankingWebSearchProvider(search, reranker) : search;
  }

  hasWebSearchProvider(): boolean {
    const services = this.config.get<ServicesConfig>(SERVICES_SECTION);
    switch (services?.activeSearchProvider) {
      case 'brave':
        return this.hasBraveConfig(services);
      case 'langsearch':
        return this.hasLangSearchConfig(services);
      case 'moonshot':
        return this.hasMoonshotConfig(services);
      case undefined:
        return (
          this.hasLangSearchConfig(services) ||
          this.hasMoonshotConfig(services) ||
          this.hasManagedOAuth()
        );
    }
  }

  private resolveSearchProvider(
    services: ServicesConfig | undefined,
    limiter: RateLimiter | undefined,
  ): WebSearchProvider | undefined {
    switch (services?.activeSearchProvider) {
      case 'brave':
        return this.fromBraveConfig(services);
      case 'langsearch':
        return this.fromLangSearchConfig(services, limiter);
      case 'moonshot':
        return this.fromMoonshotConfig(services);
      case undefined:
        return (
          this.fromLangSearchConfig(services, limiter) ??
          this.fromMoonshotConfig(services) ??
          this.fromManagedOAuth()
        );
    }
  }

  private hasBraveConfig(services: ServicesConfig | undefined): boolean {
    return this.braveApiKey(services) !== undefined;
  }

  private braveApiKey(services: ServicesConfig | undefined): string | undefined {
    return nonEmptyString(services?.brave?.apiKey);
  }

  private fromBraveConfig(services: ServicesConfig | undefined): WebSearchProvider | undefined {
    const apiKey = this.braveApiKey(services);
    if (apiKey === undefined) return undefined;
    return new BraveWebSearchProvider({
      apiKey,
      baseUrl: services?.brave?.baseUrl,
      customHeaders: services?.brave?.customHeaders,
    });
  }

  private hasLangSearchConfig(services: ServicesConfig | undefined): boolean {
    return this.langSearchApiKey(services) !== undefined;
  }

  private langSearchApiKey(services: ServicesConfig | undefined): string | undefined {
    if (!this.flags.enabled(LANGSEARCH_WEB_SEARCH_FLAG_ID)) return undefined;
    return nonEmptyString(services?.langsearch?.apiKey);
  }

  private fromLangSearchConfig(
    services: ServicesConfig | undefined,
    limiter: RateLimiter | undefined,
  ): WebSearchProvider | undefined {
    const apiKey = this.langSearchApiKey(services);
    if (apiKey === undefined) return undefined;
    const cfg = services?.langsearch;
    return new LangSearchWebSearchProvider({
      apiKey,
      baseUrl: cfg?.baseUrl,
      tier: cfg?.tier,
      freshness: cfg?.freshness,
      summary: cfg?.summary,
      count: cfg?.count,
      customHeaders: cfg?.customHeaders,
      limiter,
    });
  }

  private resolveLangSearchLimiter(services: ServicesConfig | undefined): RateLimiter | undefined {
    if (!this.flags.enabled(LANGSEARCH_WEB_SEARCH_FLAG_ID)) return undefined;
    const searchConfigured =
      (services?.activeSearchProvider === undefined ||
        services.activeSearchProvider === 'langsearch') &&
      this.hasLangSearchConfig(services);
    const rerankConfigured =
      services?.rerank?.enabled !== false &&
      services?.rerank?.provider === 'langsearch' &&
      (nonEmptyString(services.rerank.apiKey) ?? nonEmptyString(services.langsearch?.apiKey)) !==
        undefined;
    if (!searchConfigured && !rerankConfigured) return undefined;

    const tier = services?.langsearch?.tier ?? 'free';
    if (this.langSearchLimiter?.tier !== tier) {
      this.langSearchLimiter = {
        tier,
        value: new RateLimiter(TIER_LIMITS[tier], tier),
      };
    }
    return this.langSearchLimiter.value;
  }

  private hasMoonshotConfig(services: ServicesConfig | undefined): boolean {
    return nonEmptyString(services?.moonshotSearch?.baseUrl) !== undefined;
  }

  private configuredMoonshotSearch(
    services: ServicesConfig | undefined,
  ): (ServicesConfig['moonshotSearch'] & { baseUrl: string }) | undefined {
    const search = services?.moonshotSearch;
    const baseUrl = nonEmptyString(search?.baseUrl);
    if (search === undefined || baseUrl === undefined) return undefined;
    return { ...search, baseUrl };
  }

  private fromMoonshotConfig(services: ServicesConfig | undefined): WebSearchProvider | undefined {
    const search = this.configuredMoonshotSearch(services);
    if (search === undefined) return undefined;
    const tokenProvider =
      search.oauth === undefined
        ? undefined
        : this.oauth.resolveTokenProvider(KIMI_CODE_PROVIDER_NAME, search.oauth);
    return new MoonshotWebSearchProvider({
      baseUrl: search.baseUrl,
      tokenProvider,
      apiKey: nonEmptyString(search.apiKey),
      defaultHeaders: { ...this.identity.current().requestHeaders },
      customHeaders: search.customHeaders,
    });
  }

  private hasManagedOAuth(): boolean {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    return (
      provider !== undefined && isOAuthCatalogVendor(provider.type) && provider.oauth !== undefined
    );
  }

  private managedTokenProvider():
    | { provider: ProviderConfig; tokenProvider: BearerTokenProvider }
    | undefined {
    const provider = this.providers.get(KIMI_CODE_PROVIDER_NAME);
    if (provider === undefined || !isOAuthCatalogVendor(provider.type) || provider.oauth === undefined) {
      return undefined;
    }
    const tokenProvider = this.oauth.resolveTokenProvider(
      KIMI_CODE_PROVIDER_NAME,
      provider.oauth,
    );
    if (tokenProvider === undefined) return undefined;
    return { provider, tokenProvider };
  }

  private fromManagedOAuth(): WebSearchProvider | undefined {
    const managed = this.managedTokenProvider();
    if (managed === undefined) return undefined;
    const { provider, tokenProvider } = managed;
    const baseUrl = `${(provider.baseUrl ?? kimiCodeBaseUrl()).replace(/\/+$/, '')}/search`;
    return new MoonshotWebSearchProvider({
      baseUrl,
      tokenProvider,
      defaultHeaders: { ...this.bootstrap.args.requestHeaders },
      customHeaders: provider.customHeaders,
    });
  }
}

function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

registerScopedService(
  LifecycleScope.App,
  IWebSearchProviderService,
  WebSearchProviderService,
  ScopeActivation.OnScopeCreated,
  'auth',
);
