/**
 * `persistentMemory` domain — automatic extraction experimental flag.
 *
 * Registers the granular extraction opt-in with `flag`. It is enabled only by
 * its dedicated environment variable and does not inherit the master switch or
 * `[experimental]` overrides. The base persistent-memory flag remains required.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const PERSISTENT_MEMORY_AUTO_EXTRACT_FLAG_ID = 'persistent-memory-auto-extract';
export const PERSISTENT_MEMORY_AUTO_EXTRACT_FLAG_ENV =
  'KIMI_CODE_EXPERIMENTAL_PERSISTENT_MEMORY_AUTO_EXTRACT';

export const persistentMemoryAutoExtractFlag: FlagDefinitionInput = {
  id: PERSISTENT_MEMORY_AUTO_EXTRACT_FLAG_ID,
  title: 'Persistent memory — automatic extraction',
  description:
    'Automatically propose durable memories from the current turn transcript at turn end (main agent only). Requires persistent-memory.',
  env: PERSISTENT_MEMORY_AUTO_EXTRACT_FLAG_ENV,
  default: false,
  surface: 'core',
  activation: 'explicit-env',
};

registerFlagDefinition(persistentMemoryAutoExtractFlag);
