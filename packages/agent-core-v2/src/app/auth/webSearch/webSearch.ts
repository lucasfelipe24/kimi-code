/**
 * `auth` domain (cross-cutting) — configurable web-search provider seam.
 *
 * `IWebSearchProviderService` exposes the selected generic `WebSearchProvider`
 * (or `undefined` when search is unavailable), and `hasWebSearchProvider`
 * answers presence without constructing a provider or freezing identity.
 * Tests and hosts that need a custom backend bind the interface directly.
 * Bound at App scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

import type { WebSearchProvider } from '#/agent/tools/web-search/web-search';

export type { WebSearchProvider, WebSearchResult } from '#/agent/tools/web-search/web-search';

export interface IWebSearchProviderService {
  readonly _serviceBrand: undefined;

  getWebSearchProvider(): WebSearchProvider | undefined;
  hasWebSearchProvider(): boolean;
}

export const IWebSearchProviderService: ServiceIdentifier<IWebSearchProviderService> =
  createDecorator<IWebSearchProviderService>('webSearchProviderService');
