/**
 * `visual` domain — visual-model config-section schema, env binding, and
 * model resolution.
 *
 * Owns the `[visual_model]` section — a recipe-style single-pin companion
 * model for vision-only work: `model` names a configured `[models]` entry
 * (typically a vision-capable model), and the remaining fields are a
 * model patch applied only to visual tasks (thinking effort reaches the
 * requester; the size / capability fields inform consumers such as the
 * media-tools registrar). Unlike the subagent pool, there is no `models`
 * table and no `force` — the section is a binding, not a choice. The
 * `KIMI_VISUAL_MODEL` / `KIMI_VISUAL_EFFORT` env vars override `model` /
 * `default_effort` (precedence: env > config.toml), and while set,
 * `stripEnvBoundFields` restores the env-free raw value before persistence
 * so the override never leaks into `config.toml`.
 *
 * The section is always live: when set, bindings use the visual model, the
 * tools expose the `model` parameter (visual / primary choice), and
 * validation runs. Resolution goes through {@link resolveVisualModel} (the
 * configured recipe, `undefined` when unset) and {@link resolveVisualBinding}
 * (which model handles a visual task): the visual model when configured —
 * unless an explicit `"primary"` (`PRIMARY_VISUAL_MODEL_CHOICE`) request
 * forces the caller's own model and thinking level — and the caller's model
 * otherwise. Binding the visual model carries `default_effort` as the
 * explicit visual-task thinking effort; without it the visual task resolves
 * thinking naturally (global `[thinking]` config → the bound model's default
 * effort) rather than inheriting the caller's level. The `"visual"` choice is
 * accepted by visual-model-aware tools to force the visual model when
 * configured (it falls back to the caller's model when unset, so the symbolic
 * choice never fails). Tools advertise the pair via
 * {@link buildVisualModelDescriptions} (each line suffixed with the entry's
 * resolved capability flags, so the parent can route multimodal or
 * thinking-heavy visual tasks instead of guessing from the model id), and
 * spawn failures are wrapped with {@link wrapVisualModelError} so a missing
 * visual-model alias points back at `[visual_model].model` /
 * `KIMI_VISUAL_MODEL`. Display-facing alias resolution goes through
 * {@link visualDisplayModel}. Cross-field validation is NOT part of the
 * schema — it is enforced as `Error2(CONFIG_INVALID)` by
 * {@link assertValidVisualModelConfig} (run before session materialization by
 * the session lifecycle, with the Session-scope validation service in
 * `visualModelsValidationService.ts` as backstop): when `model` is set it
 * must resolve through the model catalog — a dangling pointer fails session
 * creation, exactly like the subagent pool. Self-registered at module load
 * via `registerConfigSection`.
 */

import { z } from 'zod';

import { Error2, ErrorCodes, isError2 } from '#/errors';
import { isPlainObject } from '#/app/config/toml';
import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { IModelCatalog } from '#/kosong/model/catalog';

export const VISUAL_MODEL_SECTION = 'visualModel';

export const VISUAL_MODEL_ENV = 'KIMI_VISUAL_MODEL';
export const VISUAL_MODEL_EFFORT_ENV = 'KIMI_VISUAL_EFFORT';

export const VisualModelConfigSchema = z.object({
  model: z.string().min(1).optional(),
  maxContextSize: z.number().int().min(1).optional(),
  maxInputSize: z.number().int().min(1).optional(),
  maxOutputSize: z.number().int().min(1).optional(),
  capabilities: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  reasoningKey: z.string().optional(),
  adaptiveThinking: z.boolean().optional(),
  supportEfforts: z.array(z.string()).optional(),
  defaultEffort: z.string().optional(),
  offEffort: z.string().optional(),
});

export type VisualModelConfig = z.infer<typeof VisualModelConfigSchema>;

function parseNonEmptyEnv(raw: string): string | undefined {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export const visualModelEnvBindings: EnvBindings<VisualModelConfig> = envBindings(
  VisualModelConfigSchema,
  {
    model: { env: VISUAL_MODEL_ENV, parse: parseNonEmptyEnv },
    defaultEffort: { env: VISUAL_MODEL_EFFORT_ENV, parse: parseNonEmptyEnv },
  },
);

registerConfigSection(VISUAL_MODEL_SECTION, VisualModelConfigSchema, {
  env: visualModelEnvBindings,
  stripEnv: stripEnvBoundFields(visualModelEnvBindings),
});

export const VISUAL_MODEL_CHOICE_SCHEMA = z.enum(['primary', 'visual']);

export type VisualModelChoice = z.infer<typeof VISUAL_MODEL_CHOICE_SCHEMA>;

export const PRIMARY_VISUAL_MODEL_CHOICE = VISUAL_MODEL_CHOICE_SCHEMA.enum.primary;

export function resolveVisualModel(config: IConfigService): VisualModelConfig | undefined {
  return config.get<VisualModelConfig | undefined>(VISUAL_MODEL_SECTION);
}

/**
 * Resolve which model handles a visual (image / screenshot / video)
 * inspection task. `own` is the caller's current model state, used when
 * inheriting (visual model unset or explicit `primary` request).
 *
 * `requested` mirrors the subagent `model` parameter: `undefined` follows the
 * default (visual model when set, caller's model otherwise); `'primary'`
 * forces the caller's model even when a visual model is configured; a
 * visual-model-aware tool can also accept `'visual'` to force the visual
 * model when configured (falls back to the caller's model when no visual
 * model is configured, so the symbolic choice never fails).
 */
export function resolveVisualBinding(
  config: IConfigService,
  own: { modelAlias: string; thinkingLevel: string },
  requested?: VisualModelChoice,
): { model: string; thinking?: string; displayModel: string } {
  const visual = resolveVisualModel(config);
  if (requested !== PRIMARY_VISUAL_MODEL_CHOICE && visual?.model !== undefined) {
    return {
      model: visual.model,
      thinking: visual.defaultEffort,
      displayModel: visualDisplayModel(config, visual.model),
    };
  }
  return {
    model: own.modelAlias,
    thinking: own.thinkingLevel,
    displayModel: visualDisplayModel(config, own.modelAlias),
  };
}

/**
 * Display-facing alias for a visual-task binding. The fork has no derived
 * entry for the visual model (patch fields ride the binding itself), so
 * every bound alias is a real `[models]` alias and passes through unchanged.
 */
export function visualDisplayModel(_config: IConfigService, boundAlias: string): string {
  return boundAlias;
}

/**
 * The "Available models" block appended to visual-task tool descriptions so
 * the parent model knows it can pick. `undefined` when the visual model is
 * not configured or the caller's model is not bound yet.
 */
export function buildVisualModelDescriptions(
  config: IConfigService,
  callerModelAlias: string | undefined,
  modelCatalog: IModelCatalog,
): string | undefined {
  const visual = resolveVisualModel(config);
  const visualModel = visual?.model;
  if (visualModel === undefined || callerModelAlias === undefined) return undefined;
  return [
    'Available models for visual inspection (pass via model):',
    `- visual: ${visualModel} (default) — the configured visual model; prefer it for image / screenshot / video inspection${capabilitiesSuffix(resolvedCapabilities(modelCatalog, visualModel))}`,
    `- primary: ${callerModelAlias} — the main model you are running on; use it when the caller is itself vision-capable and you want to keep the work in-process${capabilitiesSuffix(resolvedCapabilities(modelCatalog, callerModelAlias))}`,
  ].join('\n');
}

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const satisfies readonly (keyof ModelCapability)[];

function capabilitiesSuffix(capability: ModelCapability | undefined): string {
  if (capability === undefined) return '';
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capability[flag] === true);
  return `; capabilities: ${names.length === 0 ? 'none' : names.join(', ')}`;
}

function resolvedCapabilities(
  modelCatalog: IModelCatalog,
  model: string,
): ModelCapability | undefined {
  try {
    return modelCatalog.get(model).capabilities;
  } catch {
    return undefined;
  }
}

/**
 * Strip the `model` property from a visual-task tool's advertised JSON schema.
 * Returns the input unchanged when there is no `model` property; otherwise a
 * shallow copy — the input is never mutated, so callers can keep both
 * variants as shared constants.
 */
export function stripVisualModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (!isPlainObject(properties) || !('model' in properties)) return parameters;
  const nextProperties = { ...properties };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

/**
 * Point a visual-task model resolution failure at the visual-model
 * configuration when the bound model is not the caller's own — otherwise the
 * parent model sees a bare "model not configured" error with no hint that it
 * comes from `[visual_model]`.
 */
export function wrapVisualModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!isError2(error) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  if (error.details?.['model'] !== boundModel) return error;
  return new Error2(
    error.code,
    `${error.message} (visual model "${boundModel}" comes from [visual_model].model / ${VISUAL_MODEL_ENV} — check that it names a valid [models] entry)`,
    {
      cause: error,
      name: error.name,
      details: {
        ...error.details,
        visualModel: boundModel,
        visualModelConfig: {
          section: 'visualModel.model',
          environment: VISUAL_MODEL_ENV,
        },
      },
    },
  );
}

/**
 * Fail-loud startup validation of the `[visual_model]` section: when `model`
 * is set, it must name a configured `[models]` entry. A dangling pointer
 * would otherwise silently disable the visual binding at use time, so it
 * fails session creation with `Error2(CONFIG_INVALID)` instead — mirroring
 * the subagent pool's validation convention. A session without
 * `[visual_model]` is a no-op.
 */
export function assertValidVisualModelConfig(
  config: IConfigService,
  modelCatalog: IModelCatalog,
): void {
  const section = config.get<VisualModelConfig | undefined>(VISUAL_MODEL_SECTION);
  const model = section?.model;
  if (model === undefined) return;
  try {
    modelCatalog.get(model);
  } catch (error) {
    throw new Error2(
      ErrorCodes.CONFIG_INVALID,
      `[visual_model].model "${model}" could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error, details: { section: VISUAL_MODEL_SECTION, field: 'model', model } },
    );
  }
}
