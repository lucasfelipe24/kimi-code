/**
 * Scenario: the visual-model inspection helper routes a text-only caller's
 * media to the configured visual model and returns the model's TEXT analysis.
 *
 * Responsibilities: requester-direct transport (streamed parts + finish-message
 * fallback, empty-output failure), binding resolution through
 * `resolveVisualBinding`, and dangling-pointer fallback to the caller's
 * requester. Wiring: real `inspectMediaWithRequester` / `createVisualInspector`
 * with stubbed config, flags, and model catalog. Run:
 * pnpm test -- test/agent/media/visualInspection.test.ts
 */

import { describe, expect, it, vi } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import type { ModelCapability } from '#/kosong/contract/capability';
import type { Message } from '#/kosong/contract/message';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type {
  ModelRequestInput,
  ModelRequestParams,
  ModelRequester,
} from '#/kosong/model/modelRequester';
import {
  createVisualInspector,
  inspectMediaWithRequester,
} from '#/agent/media/visualInspection';
import { stubFlag } from '../../app/flag/stubs';

const textOnlyCapabilities: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: false,
  tool_use: true,
  max_context_tokens: 1000,
};

interface CapturedVisualCall {
  input: ModelRequestInput;
  params: ModelRequestParams | undefined;
}

function requesterWith(
  textParts: readonly string[],
  finishText?: string,
): ModelRequester & { captured: CapturedVisualCall[] } {
  const captured: CapturedVisualCall[] = [];
  return {
    model: {
      id: 'visual',
      name: 'visual',
      aliases: [],
      protocol: 'openai',
      headers: {},
      capabilities: { ...textOnlyCapabilities, image_in: true },
      maxContextSize: 1000,
      alwaysThinking: false,
      providerName: 'p',
      authProvider: { getAuth: async () => undefined },
    },
    request: async function* (
      input: ModelRequestInput,
      _signal?: AbortSignal,
      params?: ModelRequestParams,
    ) {
      captured.push({ input, params });
      for (const text of textParts) {
        yield { type: 'part', part: { type: 'text', text } } as const;
      }
      yield {
        type: 'finish',
        message: {
          role: 'assistant',
          content:
            finishText === undefined ? [] : [{ type: 'text', text: finishText }],
          toolCalls: [],
        },
        providerFinishReason: 'completed',
        rawFinishReason: 'stop',
      } as const;
    },
    captured,
  };
}

function configWith(visualModel: string | undefined): IConfigService {
  return {
    get: (domain: string) =>
      domain === 'visualModel' && visualModel !== undefined
        ? { model: visualModel }
        : undefined,
  } as unknown as IConfigService;
}

describe('inspectMediaWithRequester', () => {
  const mediaPart = { type: 'image_url', imageUrl: { url: 'data:image/png;base64,xxx' } } as const;

  it('concatenates the streamed text parts of the visual model reply', async () => {
    const requester = requesterWith(['The image shows ', 'a red circle.']);
    const text = await inspectMediaWithRequester(requester, {
      description: '<image path="/workspace/sample.png">',
      parts: [mediaPart],
      thinkingEffort: 'high',
    });

    expect(text).toBe('The image shows a red circle.');
    const call = requester.captured[0]!;
    expect(call.params?.thinkingEffort).toBe('high');
    expect(call.input.systemPrompt).toContain('visual inspection assistant');
    expect(call.input.tools).toEqual([]);
    const user = call.input.messages.at(-1) as Message;
    expect(user.role).toBe('user');
    expect(user.content).toContainEqual(mediaPart);
  });

  it('falls back to the finish message content when nothing streamed', async () => {
    const requester = requesterWith([], 'finish-only answer');
    const text = await inspectMediaWithRequester(requester, {
      description: 'inspect',
      parts: [],
    });
    expect(text).toBe('finish-only answer');
  });

  it('throws a coded error when the model produces no text at all', async () => {
    const requester = requesterWith([], '');
    await expect(
      inspectMediaWithRequester(requester, { description: 'inspect', parts: [] }),
    ).rejects.toThrow('Visual inspection completed without any text output.');
  });
});

describe('createVisualInspector', () => {
  const callerModelAlias = 'text-caller';

  function catalogWith(
    visualAlias: string | undefined,
    visualRequester: ModelRequester | undefined,
  ): IModelCatalog {
    return {
      getRequester: (id: string) => {
        if (id === visualAlias) {
          if (visualRequester === undefined) throw new Error(`unknown model: ${id}`);
          return visualRequester;
        }
        if (id === callerModelAlias) return requesterWith(['caller-model answer']);
        throw new Error(`unknown model: ${id}`);
      },
    } as unknown as IModelCatalog;
  }

  it('routes the inspection to the configured visual model', async () => {
    const visualRequester = requesterWith(['visual-model answer']);
    const inspector = createVisualInspector({
      config: configWith('visual-model'),
      flags: stubFlag(true),
      modelCatalog: catalogWith('visual-model', visualRequester),
      callerModelAlias,
      callerThinkingLevel: 'off',
    });

    const text = await inspector({ description: 'inspect', parts: [] });
    expect(text).toBe('visual-model answer');
  });

  it('uses the caller model when no visual model is configured', async () => {
    const inspector = createVisualInspector({
      config: configWith(undefined),
      flags: stubFlag(true),
      modelCatalog: catalogWith(undefined, undefined),
      callerModelAlias,
      callerThinkingLevel: 'off',
    });

    const text = await inspector({ description: 'inspect', parts: [] });
    expect(text).toBe('caller-model answer');
  });

  it('falls back to the caller requester when the configured visual alias dangles', async () => {
    const inspector = createVisualInspector({
      config: configWith('ghost-model'),
      flags: stubFlag(true),
      modelCatalog: catalogWith('ghost-model', undefined),
      callerModelAlias,
      callerThinkingLevel: 'off',
    });

    const text = await inspector({ description: 'inspect', parts: [] });
    expect(text).toBe('caller-model answer');
  });

  it('propagates the error when the bound caller requester itself dangles', async () => {
    const inspector = createVisualInspector({
      config: configWith(undefined),
      flags: stubFlag(true),
      modelCatalog: {
        getRequester: () => {
          throw new Error('no requester at all');
        },
      } as unknown as IModelCatalog,
      callerModelAlias,
      callerThinkingLevel: 'off',
    });

    await expect(inspector({ description: 'inspect', parts: [] })).rejects.toThrow(
      'no requester at all',
    );
  });

  it('surfaces a visual request failure to the caller', async () => {
    const failingRequester: ModelRequester = {
      model: {
        id: 'visual',
        name: 'visual',
        aliases: [],
        protocol: 'openai',
        headers: {},
        capabilities: { ...textOnlyCapabilities, image_in: true },
        maxContextSize: 1000,
        alwaysThinking: false,
        providerName: 'p',
        authProvider: { getAuth: async () => undefined },
      },
      request: async function* () {
        yield { type: 'part', part: { type: 'text', text: 'partial' } } as const;
        throw new Error('provider 500');
      },
    };
    const inspector = createVisualInspector({
      config: configWith('visual-model'),
      flags: stubFlag(true),
      modelCatalog: catalogWith('visual-model', failingRequester),
      callerModelAlias,
      callerThinkingLevel: 'off',
    });

    await expect(
      inspector({ description: 'inspect', parts: [] }, new AbortController().signal),
    ).rejects.toThrow('provider 500');
  });
});
