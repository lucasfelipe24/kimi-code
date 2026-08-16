import type { KimiConfig, KimiConfigPatch } from '@moonshot-ai/kimi-code-sdk';

/**
 * Structural access to the v2-only `[visual_model]` config section. The SDK's
 * `KimiConfig` / `KimiConfigPatch` types predate the visual-model domain (the
 * v1 schema does not declare the field), so reads and writes go through this
 * local shape — the v2 engine resolves the section under the same camelCase
 * domain name at runtime, and this app never writes the section on the v1
 * engine (the `/visual-model` command is v2-only).
 */
export function configuredVisualModel(config: KimiConfig): string | undefined {
  return (config as { visualModel?: { model?: string } }).visualModel?.model;
}

/**
 * A `[visual_model]` single-pin patch (`model = <alias>`) shaped for the
 * harness config facade. The v2 `setConfig` fans the patch out per domain, so
 * the runtime accepts the unregistered-to-v1 domain; the cast bridges the v1
 * patch type only.
 */
export function visualModelConfigPatch(model: string): KimiConfigPatch {
  return { visualModel: { model } } as unknown as KimiConfigPatch;
}
