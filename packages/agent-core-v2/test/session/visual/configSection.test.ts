/**
 * `session/visual` resolver tests — covers the `[visual_model]` config-section
 * resolver family: `resolveVisualModel`, `resolveVisualBinding` (unset
 * fallback, configured recipe, explicit `primary` override), the parameter
 * strip, and error wrapping. Mirrors the shape of the subagent resolver tests.
 */

import { describe, expect, it } from 'vitest';

import { Error2, ErrorCodes } from '#/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import {
  buildVisualModelDescriptions,
  resolveVisualBinding,
  resolveVisualModel,
  stripVisualModelParameter,
  VISUAL_MODEL_SECTION,
  visualDisplayModel,
  wrapVisualModelError,
} from '#/session/visual/configSection';

import { StubConfigService } from '../../kosong/stubs';

function makeServices(configValues: Record<string, unknown>) {
  const config = new StubConfigService(configValues);
  return { config };
}

const own = { modelAlias: 'caller/kimi-coder', thinkingLevel: 'medium' };

describe('resolveVisualModel', () => {
  it('returns undefined when [visual_model] is unset (no behavior change)', () => {
    const { config } = makeServices({});
    expect(resolveVisualModel(config)).toBeUndefined();
  });

  it('returns the configured recipe when set', () => {
    const { config } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision', defaultEffort: 'low' },
    });
    expect(resolveVisualModel(config)).toEqual({
      model: 'kimi/vision',
      defaultEffort: 'low',
    });
  });
});

describe('resolveVisualBinding', () => {
  it('inherits the caller model when the visual model is unset (no behavior change)', () => {
    const { config } = makeServices({});
    expect(resolveVisualBinding(config, own)).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });

  it('binds the visual model when set (pointer-only recipe, no derived entry)', () => {
    const { config } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' },
    });
    expect(resolveVisualBinding(config, own)).toEqual({
      model: 'kimi/vision',
      thinking: undefined,
      displayModel: 'kimi/vision',
    });
  });

  it('binds the visual model with default_effort as the thinking level', () => {
    const { config } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision', defaultEffort: 'low', maxOutputSize: 4096 },
    });
    expect(resolveVisualBinding(config, own)).toEqual({
      model: 'kimi/vision',
      thinking: 'low',
      displayModel: 'kimi/vision',
    });
  });

  it('forces the caller model on explicit "primary" even when a visual model is configured', () => {
    const { config } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' },
    });
    expect(resolveVisualBinding(config, own, 'primary')).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });

  it('accepts explicit "visual" and binds the visual model when configured', () => {
    const { config } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' },
    });
    expect(resolveVisualBinding(config, own, 'visual')).toEqual({
      model: 'kimi/vision',
      thinking: undefined,
      displayModel: 'kimi/vision',
    });
  });

  it('falls back to the caller model for explicit "visual" when no visual model is configured', () => {
    const { config } = makeServices({});
    expect(resolveVisualBinding(config, own, 'visual')).toEqual({
      model: own.modelAlias,
      thinking: own.thinkingLevel,
      displayModel: own.modelAlias,
    });
  });
});

describe('visualDisplayModel', () => {
  it('passes through any bound alias (no derived entry in this fork)', () => {
    const { config } = makeServices({});
    expect(visualDisplayModel(config, 'kimi/vision')).toBe('kimi/vision');
    expect(visualDisplayModel(config, own.modelAlias)).toBe(own.modelAlias);
  });
});

describe('buildVisualModelDescriptions', () => {
  function modelCatalogWith(aliases: Record<string, { capabilities?: unknown }>): IModelCatalog {
    return {
      _serviceBrand: undefined,
      get: (id: string) => {
        const entry = aliases[id];
        if (entry === undefined) {
          throw new Error2(ErrorCodes.CONFIG_INVALID, `Model "${id}" is not configured.`, {
            details: { model: id },
          });
        }
        return {
          id,
          capabilities:
            entry.capabilities ??
            {
              image_in: false,
              video_in: false,
              audio_in: false,
              thinking: false,
              tool_use: true,
              max_context_tokens: 128000,
            },
        } as Model;
      },
      getRequester: () => {
        throw new Error('unused');
      },
    } as unknown as IModelCatalog;
  }

  it('returns undefined when no visual model is configured', () => {
    const { config } = makeServices({});
    expect(buildVisualModelDescriptions(config, own.modelAlias, modelCatalogWith({}))).toBeUndefined();
  });

  it('returns undefined when the caller model alias is not bound yet', () => {
    const { config } = makeServices({ [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' } });
    expect(buildVisualModelDescriptions(config, undefined, modelCatalogWith({}))).toBeUndefined();
  });

  it('lists the visual model (default) and the caller model with capability suffixes', () => {
    const { config } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' },
    });
    const catalog = modelCatalogWith({
      'kimi/vision': {
        capabilities: {
          image_in: true,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 128000,
        },
      },
      [own.modelAlias]: {
        capabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: false,
          tool_use: true,
          max_context_tokens: 128000,
        },
      },
    });
    const description = buildVisualModelDescriptions(config, own.modelAlias, catalog);
    expect(description).toContain('- visual: kimi/vision (default)');
    expect(description).toContain('capabilities: image_in, thinking, tool_use');
    expect(description).toContain(`- primary: ${own.modelAlias}`);
    expect(description).toContain('capabilities: tool_use');
  });

  it('omits the capability suffix for an unresolvable model', () => {
    const { config } = makeServices({
      [VISUAL_MODEL_SECTION]: { model: 'kimi/vision' },
    });
    const description = buildVisualModelDescriptions(
      config,
      own.modelAlias,
      modelCatalogWith({}),
    );
    expect(description).toContain('- visual: kimi/vision (default)');
    expect(description).not.toContain('capabilities:');
  });
});

describe('stripVisualModelParameter', () => {
  it('returns the input unchanged when there is no model property', () => {
    const schema = { properties: { prompt: { type: 'string' } }, required: ['prompt'] };
    expect(stripVisualModelParameter(schema)).toBe(schema);
  });

  it('removes the model property and its required entry', () => {
    const schema = {
      properties: { prompt: { type: 'string' }, model: { type: 'string' } },
      required: ['prompt', 'model'],
    };
    const next = stripVisualModelParameter(schema);
    expect(next['properties']).toEqual({ prompt: { type: 'string' } });
    expect(next['required']).toEqual(['prompt']);
  });

  it('does not mutate the input', () => {
    const schema = {
      properties: { model: { type: 'string' } },
      required: ['model'],
    };
    const next = stripVisualModelParameter(schema);
    expect(next).not.toBe(schema);
    expect(schema['properties']).toEqual({ model: { type: 'string' } });
  });
});

describe('wrapVisualModelError', () => {
  const callerModelAlias = 'caller/kimi-coder';

  it('returns the error unchanged when the bound model is the caller own', () => {
    const error = new Error2(ErrorCodes.CONFIG_INVALID, 'boom', {
      details: { model: callerModelAlias },
    });
    expect(wrapVisualModelError(error, callerModelAlias, callerModelAlias)).toBe(error);
  });

  it('returns the error unchanged for non-CONFIG_INVALID errors', () => {
    const error = new Error('boom');
    expect(wrapVisualModelError(error, 'kimi/vision', callerModelAlias)).toBe(error);
  });

  it('returns the error unchanged when the error details model does not match the bound model', () => {
    const error = new Error2(ErrorCodes.CONFIG_INVALID, 'boom', {
      details: { model: 'some/other' },
    });
    expect(wrapVisualModelError(error, 'kimi/vision', callerModelAlias)).toBe(error);
  });

  it('wraps a missing-alias failure with a hint pointing at [visual_model]', () => {
    const error = new Error2(ErrorCodes.CONFIG_INVALID, 'Model "kimi/vision" is not configured.', {
      details: { model: 'kimi/vision' },
    });
    const wrapped = wrapVisualModelError(error, 'kimi/vision', callerModelAlias) as Error2;
    expect(wrapped).toBeInstanceOf(Error2);
    expect(wrapped.message).toContain('[visual_model]');
    expect(wrapped.message).toContain('KIMI_VISUAL_MODEL');
    expect(wrapped.details).toMatchObject({
      model: 'kimi/vision',
      visualModel: 'kimi/vision',
      visualModelConfig: { section: 'visualModel.model', environment: 'KIMI_VISUAL_MODEL' },
    });
  });
});
