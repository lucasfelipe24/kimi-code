/**
 * `visual` domain — `ISessionVisualModelsValidationService` contract:
 * startup validation of the configured visual model.
 *
 * The visual model is primarily validated before session materialization by
 * the session lifecycle; this service repeats the same check at Session-scope
 * activation as a backstop, so a `[visual_model].model` that does not resolve
 * through the model catalog fails the session with `Error2(CONFIG_INVALID)`
 * instead of degrading into a mid-conversation tool failure handed back to
 * the parent model. Session-scoped — one instance per session; the contract
 * carries no methods because the validation is the construction side effect.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export interface ISessionVisualModelsValidationService {
  readonly _serviceBrand: undefined;
}

export const ISessionVisualModelsValidationService: ServiceIdentifier<ISessionVisualModelsValidationService> =
  createDecorator<ISessionVisualModelsValidationService>(
    'sessionVisualModelsValidationService',
  );
