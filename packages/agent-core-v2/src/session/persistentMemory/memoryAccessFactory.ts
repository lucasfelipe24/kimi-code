/**
 * `persistentMemory` domain — session-local actor access factory.
 *
 * Carries closures already authorized by the Workspace catalog into Session and
 * Agent scopes. It is a seeded internal contract, not a scoped reflected
 * service. Session-scoped data only.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { ScopeSeed } from '#/_base/di/scope';
import type { MemoryMutationActor } from '#/workspace/persistentMemory/memoryCatalogMutation';

import type { ISessionMemoryAccess } from './memorySeed';

export interface ISessionMemoryAccessFactory {
  readonly _serviceBrand: undefined;
  forActor(actor: MemoryMutationActor): ISessionMemoryAccess;
}

export const ISessionMemoryAccessFactory: ServiceIdentifier<ISessionMemoryAccessFactory> =
  createDecorator<ISessionMemoryAccessFactory>('sessionMemoryAccessFactory');

export function sessionMemoryAccessFactorySeed(
  factory: ISessionMemoryAccessFactory,
): ScopeSeed {
  return [[ISessionMemoryAccessFactory as ServiceIdentifier<unknown>, factory]];
}
