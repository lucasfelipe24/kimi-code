/**
 * `persistentMemory` domain — canonical persistent-memory feature gate.
 *
 * Registers the experimental flag used by every persistent-memory read and
 * mutation surface. Off by default and resolved by the App-scoped `flag`
 * service.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const PERSISTENT_MEMORY_FLAG_ID = 'persistent-memory';
export const PERSISTENT_MEMORY_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_PERSISTENT_MEMORY';

export const persistentMemoryFlag: FlagDefinitionInput = {
  id: PERSISTENT_MEMORY_FLAG_ID,
  title: 'Persistent memory',
  description:
    'Durable cross-session memory: explicit remember/forget and selective recall.',
  env: PERSISTENT_MEMORY_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(persistentMemoryFlag);
