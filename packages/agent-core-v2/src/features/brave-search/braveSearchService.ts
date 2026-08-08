/**
 * `brave-search` domain — `IBraveSearchService` implementation.
 *
 * Reads the Brave feature flag through `flag` and the current provider and
 * credentials through `config` for every client request. Bound at App scope
 * through `BraveSearchFeature`.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { BraveClient } from '#/app/auth/brave/braveClient';
import { SERVICES_SECTION, type ServicesConfig } from '#/app/auth/configSection';
import { BRAVE_SEARCH_FLAG_ID } from '#/app/auth/webSearch/flag';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';

import { IBraveSearchService } from './braveSearch';

export class BraveSearchService implements IBraveSearchService {
  declare readonly _serviceBrand: undefined;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  getClient(): BraveClient | undefined {
    return this.instantiation.invokeFunction((accessor) => {
      if (!accessor.get(IFlagService).enabled(BRAVE_SEARCH_FLAG_ID)) return undefined;
      const services = accessor
        .get(IConfigService)
        .get<ServicesConfig | undefined>(SERVICES_SECTION);
      const brave = services?.brave;
      const apiKey = brave?.apiKey?.trim();
      if (
        services?.activeSearchProvider !== 'brave' ||
        apiKey === undefined ||
        apiKey.length === 0
      ) {
        return undefined;
      }
      return new BraveClient({
        apiKey,
        baseUrl: brave?.baseUrl,
        customHeaders: brave?.customHeaders,
      });
    });
  }
}
