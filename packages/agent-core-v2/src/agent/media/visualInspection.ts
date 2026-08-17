/**
 * `media` domain — visual-model inspection helper (requester-direct route).
 *
 * Lets a text-only caller model still "see" image / video files when a
 * `[visual_model]` is configured: the caller's `ReadMediaFile` tool hands the
 * built media parts to a `VisualMediaInspector`, which sends them straight to
 * the visual model's `ModelRequester` and returns the model's TEXT analysis —
 * the caller never receives raw `ImageContent`. No subagent, no transcript, no
 * history: the inspection is a single bounded `requester.request` whose output
 * is the tool result.
 *
 * `createVisualInspector` is the registrar-facing factory: it resolves the
 * binding through `resolveVisualBinding` (visual model + its `default_effort`
 * thinking when configured, caller's own model otherwise), resolves the
 * requester through `modelCatalog`, and falls back to the caller's requester
 * when the configured visual alias dangles at call time — a stale pointer is
 * degraded, never thrown into the caller's turn. `inspectMediaWithRequester`
 * is the transport: it builds a single user message carrying the description
 * plus the media parts, streams the request, and concatenates the streamed
 * text/think parts (falling back to the finish message's content when the
 * stream carried none). Failures propagate to the caller, which surfaces them
 * as a visible tool error — nothing partial is written anywhere.
 */

import type { IConfigService } from '#/app/config/config';
import { Error2, ErrorCodes } from '#/errors';
import type { ContentPart, Message } from '#/kosong/contract/message';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import type { IModelCatalog } from '#/kosong/model/catalog';
import type {
  ModelRequestInput,
  ModelRequestParams,
  ModelRequester,
} from '#/kosong/model/modelRequester';

import { resolveVisualBinding } from '#/session/visual/configSection';

export interface VisualMediaInspectionInput {
  /** Text prefix describing what is being inspected (path, file kind). */
  readonly description: string;
  /** The media parts (image_url / video_url) built for the file. */
  readonly parts: readonly ContentPart[];
}

export type VisualMediaInspector = (
  inspection: VisualMediaInspectionInput,
  signal?: AbortSignal,
) => Promise<string>;

export interface VisualInspectorContext {
  readonly config: IConfigService;
  readonly modelCatalog: IModelCatalog;
  readonly callerModelAlias: string;
  readonly callerThinkingLevel: string;
  readonly systemPrompt?: string;
}

export interface VisualInspectionCall {
  readonly description: string;
  readonly parts: readonly ContentPart[];
  readonly thinkingEffort?: ThinkingEffort;
  readonly signal?: AbortSignal;
  readonly systemPrompt?: string;
}

const DEFAULT_VISUAL_INSPECTION_SYSTEM_PROMPT =
  'You are a visual inspection assistant. Examine the image(s) / video(s) in the user ' +
  'message and report exactly what is present, with concrete values instead of ' +
  'approximate prose. You have no tools and no history — answer only from the attached ' +
  'media. Report colors as exact RGB and hex (#RRGGBB) values; reproduce any visible ' +
  'text verbatim (exact wording, case, and punctuation); give coordinates relative to ' +
  'the stated original image dimensions; describe layout with positions, sizes, and ' +
  'alignment. Treat pixel statistics included in the prompt as ground truth for the ' +
  'original file. Never invent details that are not visible: if text is illegible, an ' +
  'area is blurry or cut off, or a value cannot be determined, state that explicitly ' +
  'instead of approximating.';

export function createVisualInspector(context: VisualInspectorContext): VisualMediaInspector {
  return async (inspection, signal) => {
    const binding = resolveVisualBinding(context.config, {
      modelAlias: context.callerModelAlias,
      thinkingLevel: context.callerThinkingLevel,
    });
    let requester: ModelRequester;
    try {
      requester = context.modelCatalog.getRequester(binding.model);
    } catch (error) {
      if (binding.model === context.callerModelAlias) throw error;
      requester = context.modelCatalog.getRequester(context.callerModelAlias);
    }
    return inspectMediaWithRequester(requester, {
      description: inspection.description,
      parts: inspection.parts,
      thinkingEffort: binding.thinking,
      signal,
      systemPrompt: context.systemPrompt,
    });
  };
}

export async function inspectMediaWithRequester(
  requester: ModelRequester,
  call: VisualInspectionCall,
): Promise<string> {
  const input: ModelRequestInput = {
    systemPrompt: call.systemPrompt ?? DEFAULT_VISUAL_INSPECTION_SYSTEM_PROMPT,
    tools: [],
    messages: [
      {
        role: 'user',
        toolCalls: [],
        content: [{ type: 'text', text: call.description }, ...call.parts],
      },
    ],
  };
  const params: ModelRequestParams =
    call.thinkingEffort === undefined ? {} : { thinkingEffort: call.thinkingEffort };
  const streamedText: string[] = [];
  let finishedMessage: Message | undefined;
  for await (const event of requester.request(input, call.signal, params)) {
    if (event.type === 'part') {
      const part = event.part;
      if (part.type === 'text') streamedText.push(part.text);
      else if (part.type === 'think') streamedText.push(part.think);
    } else if (event.type === 'finish') {
      finishedMessage = event.message;
    }
  }
  const streamed = streamedText.join('');
  if (streamed.length > 0) return streamed;
  const finished = finishedMessage?.content
    .map((part) => {
      if (part.type === 'text') return part.text;
      if (part.type === 'think') return part.think;
      return '';
    })
    .join('');
  if (finished !== undefined && finished.length > 0) return finished;
  throw new Error2(
    ErrorCodes.PROVIDER_API_ERROR,
    'Visual inspection completed without any text output.',
  );
}
