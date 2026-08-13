/**
 * `brave-search` domain — current Brave API client provider.
 *
 * Exposes an authenticated client only while the selected search provider and
 * current API key permit Brave requests. Bound at App scope through
 * `BraveSearchFeature`.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { BraveClient } from '#/app/auth/brave/braveClient';

export interface IBraveSearchService {
  readonly _serviceBrand: undefined;

  getClient(): BraveClient | undefined;
}

export const IBraveSearchService: ServiceIdentifier<IBraveSearchService> =
  createDecorator<IBraveSearchService>('braveSearchService');
