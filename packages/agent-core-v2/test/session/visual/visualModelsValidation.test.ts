import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ErrorCodes, Error2, isError2 } from '#/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { VISUAL_MODEL_SECTION } from '#/session/visual/configSection';
import { VISUAL_MODEL_FLAG_ID } from '#/session/visual/flag';
import { ISessionVisualModelsValidationService } from '#/session/visual/visualModelsValidation';
import { SessionVisualModelsValidationService } from '#/session/visual/visualModelsValidationService';

import { StubConfigService } from '../../kosong/stubs';
import { stubFlag } from '../../app/flag/stubs';

describe('SessionVisualModelsValidationService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let modelIds: Set<string>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    modelIds = new Set();
  });
  afterEach(() => {
    disposables.dispose();
  });

  function setup(configValues: Record<string, unknown>, flagEnabled = true): void {
    ix.stub(IConfigService, new StubConfigService(configValues));
    ix.stub(IFlagService, stubFlag((id) => flagEnabled && id === VISUAL_MODEL_FLAG_ID));
    ix.stub(IModelCatalog, {
      _serviceBrand: undefined,
      get: (id: string) => {
        if (!modelIds.has(id)) {
          throw new Error2(
            ErrorCodes.CONFIG_INVALID,
            `Model "${id}" is not configured in config.toml.`,
            { details: { model: id } },
          );
        }
        return { id } as Model;
      },
      getRequester: () => {
        throw new Error('unused');
      },
    } as unknown as IModelCatalog);
    ix.set(
      ISessionVisualModelsValidationService,
      new SyncDescriptor(SessionVisualModelsValidationService),
    );
  }

  function resolve(): unknown {
    try {
      ix.get(ISessionVisualModelsValidationService);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  it('is a no-op when no visual_model section is configured', () => {
    setup({});
    expect(resolve()).toBeUndefined();
  });

  it('is a no-op for a broken pointer while the visual-model flag is off', () => {
    setup({ [VISUAL_MODEL_SECTION]: { model: 'provider/typo' } }, false);
    expect(resolve()).toBeUndefined();
  });

  it('constructs fine when the visual model pointer resolves', () => {
    modelIds.add('provider/vision');
    setup({ [VISUAL_MODEL_SECTION]: { model: 'provider/vision' } });
    expect(resolve()).toBeUndefined();
  });

  it('constructs fine when [visual_model] carries only patch fields and no model', () => {
    setup({ [VISUAL_MODEL_SECTION]: { defaultEffort: 'low', maxOutputSize: 4096 } });
    expect(resolve()).toBeUndefined();
  });

  it('fails session creation when the visual model pointer does not resolve', () => {
    setup({ [VISUAL_MODEL_SECTION]: { model: 'provider/typo' } });
    const error = resolve();
    expect(isError2(error)).toBe(true);
    expect((error as Error2).code).toBe(ErrorCodes.CONFIG_INVALID);
    expect((error as Error2).message).toContain(
      '[visual_model].model "provider/typo" could not be resolved',
    );
    expect((error as Error2).message).toContain('"provider/typo" is not configured');
    expect(isError2((error as Error2).cause)).toBe(true);
  });
});
