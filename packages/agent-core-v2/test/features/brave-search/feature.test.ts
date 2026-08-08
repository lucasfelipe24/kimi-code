import { beforeEach, describe, expect, it } from 'vitest';

import type { CollectionView } from '#/_base/di/collection';
import { ScopeActivation, type ServicesAccessor } from '#/_base/di/instantiation';
import type { InstantiationService } from '#/_base/di/instantiationService';
import { _clearScopedRegistryForTests, registerScopedService } from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { BRAVE_SEARCH_FLAG_ID } from '#/app/auth/webSearch/flag';
import { IConfigService } from '#/app/config/config';
import { IFeatureManager } from '#/app/feature/featureManager';
import { FeatureManagerService } from '#/app/feature/featureManagerService';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { AgentToolContribution } from '#/agent/toolRegistry/toolContribution';
import { IFeatureAssemblyService } from '#/features/featureAssembly';
import { FeatureAssemblyService } from '#/features/featureAssemblyService';
import { IBraveSearchService } from '#/features/brave-search/braveSearch';
import { BraveSearchFeature, braveSearchEnabled } from '#/features/brave-search/braveSearchFeature';
import { _clearFeatureRecipesForTests, registerFeature } from '#/features/featureRegistry';

function accessor(flag: boolean, services: unknown): ServicesAccessor {
  return {
    get(id) {
      if (id === IFlagService) {
        return { enabled: (flagId: string) => flag && flagId === BRAVE_SEARCH_FLAG_ID } as never;
      }
      if (id === IConfigService) return { get: () => services } as never;
      throw new Error(`Unexpected service: ${String(id)}`);
    },
  };
}

function contributions(scope: { readonly instantiation: unknown }): CollectionView<AgentToolContribution> {
  return (scope.instantiation as InstantiationService).fiberHost.collectionView(
    AgentToolContribution,
  );
}

describe('BraveSearchFeature', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    _clearFeatureRecipesForTests();
    registerFeature(BraveSearchFeature);
    registerScopedService(
      LifecycleScope.App,
      IFeatureManager,
      FeatureManagerService,
      ScopeActivation.OnScopeCreated,
      'feature',
    );
    registerScopedService(
      LifecycleScope.App,
      IFeatureAssemblyService,
      FeatureAssemblyService,
      ScopeActivation.OnScopeCreated,
      'features',
    );
  });
  it('has the stable App unit identity', () => {
    expect(BraveSearchFeature.name).toBe('brave-search');
  });

  it('requires flag, explicit Brave selection, and a nonblank key', () => {
    const configured = { activeSearchProvider: 'brave', brave: { apiKey: ' key ' } };
    expect(braveSearchEnabled(accessor(true, configured))).toBe(true);
    expect(braveSearchEnabled(accessor(false, configured))).toBe(false);
    expect(
      braveSearchEnabled(
        accessor(true, { activeSearchProvider: 'moonshot', brave: { apiKey: 'key' } }),
      ),
    ).toBe(false);
    expect(
      braveSearchEnabled(
        accessor(true, { activeSearchProvider: 'brave', brave: { apiKey: '   ' } }),
      ),
    ).toBe(false);
  });

  it('assembles the App service and ten on-demand Agent tools with the shared gate', () => {
    let services = {
      activeSearchProvider: 'brave',
      brave: { apiKey: 'key', baseUrl: 'https://brave.example/res/v1' },
    };
    let flagEnabled = true;
    const config = {
      get: () => services,
    } as unknown as IConfigService;
    const flag = {
      enabled: (id: string) => flagEnabled && id === BRAVE_SEARCH_FLAG_ID,
    } as unknown as IFlagService;
    const host = createScopedTestHost([
      stubPair(IConfigService, config),
      stubPair(IFlagService, flag),
    ]);
    const agent = host.child(LifecycleScope.Agent, 'main');
    const records = contributions(agent).items;
    const braveSearch = host.app.accessor.get(IBraveSearchService);

    expect(braveSearch.getClient()).toBeDefined();
    flagEnabled = false;
    expect(braveSearch.getClient()).toBeUndefined();
    flagEnabled = true;
    services = { ...services, activeSearchProvider: 'moonshot' };
    expect(braveSearch.getClient()).toBeUndefined();
    services = {
      ...services,
      activeSearchProvider: 'brave',
      brave: { apiKey: '   ', baseUrl: services.brave.baseUrl },
    };
    expect(braveSearch.getClient()).toBeUndefined();
    services = {
      ...services,
      brave: { apiKey: 'new-key', baseUrl: services.brave.baseUrl },
    };
    expect(braveSearch.getClient()).toBeDefined();

    expect(records.map((record) => record.options.name).toSorted()).toEqual(
      [
        'BraveWebSearch',
        'BraveNewsSearch',
        'BraveImageSearch',
        'BraveVideoSearch',
        'BraveLLMContext',
        'BraveAnswers',
        'BraveSuggest',
        'BraveSpellcheck',
        'BraveLocalSearch',
        'BraveRichResults',
      ].toSorted(),
    );
    for (const record of records) {
      expect(record.options.when?.(accessor(true, config.get('services')))).toBe(true);
      expect(agent.accessor.get(record.id).name).toBe(record.options.name);
    }
    host.dispose();
  });
});
