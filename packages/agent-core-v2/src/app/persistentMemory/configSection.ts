/**
 * `persistentMemory` domain — bounded recall and extraction configuration.
 *
 * Owns the `[memory]` caps consumed by persistent-memory recall and extraction.
 * Feature availability is owned exclusively by the `flag` domain. Registered at
 * App scope through the config-section contribution registry.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const MEMORY_SECTION = 'memory';

export const MemoryConfigSchema = z.object({
  recallMaxEntries: z.number().int().min(1).max(20).optional(),
  recallMaxBytesPerEntry: z.number().int().min(256).optional(),
  recallMaxSessionBytes: z.number().int().min(1024).optional(),
  extractionMaxTurns: z.number().int().min(1).max(10).optional(),
  extractionEnabled: z.boolean().optional(),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const DEFAULT_MEMORY_CONFIG: Required<MemoryConfig> = {
  recallMaxEntries: 5,
  recallMaxBytesPerEntry: 4096,
  recallMaxSessionBytes: 60 * 1024,
  extractionMaxTurns: 5,
  extractionEnabled: true,
};

registerConfigSection(MEMORY_SECTION, MemoryConfigSchema, {
  defaultValue: DEFAULT_MEMORY_CONFIG,
});
