/**
 * `visual` domain — `ISessionVisualModelsValidationService` implementation.
 *
 * Backstop for the session lifecycle's pre-materialization check: validates
 * the configured visual-model section (`[visual_model].model`) once per
 * session at scope construction (`ScopeActivation.OnScopeCreated`), so a
 * broken visual-model pointer fails session creation with
 * `Error2(CONFIG_INVALID)` even on paths that bypass the lifecycle service.
 * Reads the section through `config` and resolves the alias through the model
 * catalog; a session without `[visual_model]` is a no-op. The check itself
 * lives in `assertValidVisualModelConfig` (configSection). Bound at Session
 * scope.
 */

import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/kosong/model/catalog';

import { assertValidVisualModelConfig } from './configSection';
import { ISessionVisualModelsValidationService } from './visualModelsValidation';

export class SessionVisualModelsValidationService
  implements ISessionVisualModelsValidationService
{
  declare readonly _serviceBrand: undefined;

  constructor(
    @IConfigService config: IConfigService,
    @IModelCatalog modelCatalog: IModelCatalog,
  ) {
    assertValidVisualModelConfig(config, modelCatalog);
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionVisualModelsValidationService,
  SessionVisualModelsValidationService,
  ScopeActivation.OnScopeCreated,
  'visual',
);
