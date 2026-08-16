/**
 * `visual` domain — registers the `visual-model` flag into `flag`.
 *
 * Gates visual-model selection for image / screenshot / video inspection
 * tasks. On by default (native): `[visual_model]` takes effect with zero env
 * vars set, per the "release by flipping default to true" convention; roll
 * back to caller-model behavior via `KIMI_CODE_EXPERIMENTAL_VISUAL_MODEL=false`,
 * the `[experimental]` config section, or the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG` (which forces every flag on). Visual-model
 * mirror of `secondaryModelFlag`.
 *
 * Many coding models are text-only and cannot consume image content. When
 * `[visual_model]` is configured, visual inspection tasks (the `ReadMediaFile`
 * tool and any future visual subagent spawn) consult {@link resolveVisualModel}
 * to pick a vision-capable model instead of falling back to the caller's
 * text-only model. When unset, behavior is unchanged (visual tasks inherit the
 * caller's model).
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const VISUAL_MODEL_FLAG_ID = 'visual-model';
export const VISUAL_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_VISUAL_MODEL';

export const visualModelFlag: FlagDefinitionInput = {
  id: VISUAL_MODEL_FLAG_ID,
  title: 'Visual model for image/screenshot inspection',
  description:
    'Let image / screenshot / video inspection tasks use a separately configured visual model by default, so a text-only coding model can still drive visual work via a vision-capable companion model.',
  env: VISUAL_MODEL_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(visualModelFlag);
