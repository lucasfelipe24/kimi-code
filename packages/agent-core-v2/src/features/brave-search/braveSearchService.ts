/**
 * `brave-search` domain — `IBraveSearchService` implementation.
 *
 * Reads the current Brave provider and credentials through `config` for every
 * client request. Bound at App scope through `BraveSearchFeature`.
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { BraveClient } from '#/app/auth/brave/braveClient';
import { SERVICES_SECTION, type ServicesConfig } from '#/app/auth/configSection';
import { IConfigService } from '#/app/config/config';

import { IBraveSearchService } from './braveSearch';

export class BraveSearchService implements IBraveSearchService {
  declare readonly _serviceBrand: undefined;

  constructor(@IInstantiationService private readonly instantiation: IInstantiationService) {}

  getClient(): BraveClient | undefined {
    return this.instantiation.invokeFunction((accessor) => {
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
