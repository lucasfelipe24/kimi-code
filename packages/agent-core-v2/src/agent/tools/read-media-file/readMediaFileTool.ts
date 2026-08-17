import type { ModelCapability } from '#/kosong/contract/capability';
import type { ContentPart } from '#/kosong/contract/message';
import { VideoUploadUnsupportedError } from '#/kosong/contract/errors';
import { inlineVideoPart, isVideoUploadAuthError } from '#/agent/media/videoUpload';
import type { VisualMediaInspector } from '#/agent/media/visualInspection';
import type { ITelemetryService } from '#/app/telemetry/telemetry';

import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import type { HostEnvironmentInfo } from '#/os/interface/hostEnvironment';
import { inspectAgentRuntime, type IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import {
  ToolAccesses,
  type AgentTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { resolvePathAccessPath, type WorkspaceConfig } from '#/tool/path-access';
import {
  MEDIA_SNIFF_BYTES,
  detectFileType,
  sniffImageDimensions,
} from '#/agent/media/file-type';
import {
  IMAGE_BYTE_BUDGET,
  MAX_IMAGE_DECODE_BYTES,
  MAX_VISUAL_MODEL_EDGE_PX,
  compressImageForModel,
  cropImageForModel,
  formatByteSize,
  resolveMaxImageEdgePx,
  resolveReadImageByteBudget,
  type ImageCompressionTelemetry,
  type ImageCropRegion,
} from '#/agent/media/image-compress';
import { extractPixelStats, type PixelStats } from '#/agent/media/pixel-stats';
import {
  buildImageConversionGuidance,
  isModelAcceptedImageMime,
} from '#/agent/media/image-format-policy';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { renderPrompt } from '#/_base/utils/render-prompt';
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_MEGABYTES,
  ReadMediaFileInputSchema,
  type ReadMediaFileInput,
  type VideoUploader,
} from './read-media-file';
import readMediaDescriptionHead from './read-media.md?raw';

const VISUAL_INSPECTION_INSTRUCTION =
  'Analyze the media above and report concrete facts, not approximations. ' +
  'Treat any pixel statistics given in this description as ground truth for the original ' +
  "file's dimensions and dominant colors. Report: (1) colors with exact values — RGB and hex " +
  '(#RRGGBB); (2) any visible text verbatim, preserving exact wording, case, and punctuation; ' +
  '(3) coordinates relative to the stated original image dimensions; (4) spatial layout — ' +
  'positions, sizes, alignment; (5) anything you cannot determine exactly — say so explicitly ' +
  'instead of guessing. Never invent details that are not visible. The requesting model cannot ' +
  'see the media; your text is its only description, so be complete.';

function buildDescription(capabilities: ModelCapability, delegated?: boolean): string {
  const head = renderPrompt(readMediaDescriptionHead, { MAX_MEDIA_MEGABYTES });
  const lines: string[] = [head];
  const hasImage = capabilities.image_in;
  const hasVideo = capabilities.video_in;
  if (delegated === true) {
    lines.push(
      '- Media files are inspected by the configured visual model and the result is returned as text — the current model never receives raw image/video content.',
    );
    return lines.join('\n');
  }
  if (hasImage && hasVideo) {
    lines.push('- This tool supports image and video files for the current model.');
  } else if (hasImage) {
    lines.push(
      '- This tool supports image files for the current model.',
      '- Video files are not supported by the current model.',
    );
  } else if (hasVideo) {
    lines.push(
      '- This tool supports video files for the current model.',
      '- Image files are not supported by the current model.',
    );
  } else {
    lines.push('- The current model does not support image or video input.');
  }
  return lines.join('\n');
}

interface ImageDelivery {
  readonly kind: 'untouched' | 'downsampled' | 'crop' | 'full';
  readonly width: number;
  readonly height: number;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly region?: ImageCropRegion;
  readonly resized?: boolean;
}

function renderInspectionStats(stats: PixelStats | undefined): string {
  if (stats === undefined) return '';
  const { width, height, sampledPixels, distinctColors, dominantColor, flat, hasAlpha } = stats;
  const dominant =
    dominantColor === undefined
      ? ''
      : ` dominant color ${dominantColor.hex} (rgb(${String(dominantColor.r)},${String(dominantColor.g)},${String(dominantColor.b)}));`;
  const flatText = flat ? ' the image is flat/solid (one color);' : '';
  return (
    `\nPixel statistics (sampled from the original file before compression — treat as ground truth): ` +
    `dimensions ${String(width)}x${String(height)} px; ${String(sampledPixels)} pixels sampled; ` +
    `${String(distinctColors)} distinct color(s);${dominant}${flatText} alpha: ${
      hasAlpha ? 'the image uses transparency' : 'fully opaque'
    }.`
  );
}

function buildMediaNote(input: {
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  readonly byteSize: number;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
  readonly delivery?: ImageDelivery;
  readonly pixelStats?: PixelStats;
}): string {
  const parts: string[] = [
    `Read ${input.kind} file.`,
    `Mime type: ${input.mimeType}.`,
    `Size: ${String(input.byteSize)} bytes.`,
  ];
  if (input.kind === 'image' && input.dimensions) {
    parts.push(
      `Original dimensions: ${String(input.dimensions.width)}x${String(input.dimensions.height)} pixels.`,
    );
  }
  const delivery = input.delivery;
  if (delivery?.kind === 'downsampled') {
    parts.push(
      `The attached image was downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels ` +
        `(${delivery.mimeType}, ${formatByteSize(delivery.byteLength)}) to fit model limits; ` +
        'fine detail may be lost.',
      'To inspect fine detail, call ReadMediaFile again with the region parameter ' +
        '(original-image pixel coordinates) to view a crop at full fidelity.',
    );
  } else if (delivery?.kind === 'crop' && delivery.region) {
    const { x, y, width, height } = delivery.region;
    parts.push(
      `Showing region (x=${String(x)}, y=${String(y)}, width=${String(width)}, height=${String(height)}) ` +
        `of the original image${
          delivery.resized === true
            ? `, downsampled to ${String(delivery.width)}x${String(delivery.height)} pixels`
            : ' at native resolution'
        }.`,
      'To output coordinates in original-image pixels, locate them within this crop and add ' +
        `the region offset (x=${String(x)}, y=${String(y)}).`,
    );
  } else if (delivery?.kind === 'full') {
    parts.push('Shown at native resolution; no downscaling applied.');
  }
  if (input.pixelStats !== undefined) {
    const { width, height, sampledPixels, distinctColors, dominantColor, flat, hasAlpha } =
      input.pixelStats;
    const statsParts = [
      `Pixel stats (sampled from the original): ${String(width)}x${String(height)} px, ` +
        `${String(sampledPixels)} pixels sampled, ${String(distinctColors)} distinct color(s).`,
    ];
    if (dominantColor !== undefined) {
      statsParts.push(
        `Dominant color: ${dominantColor.hex} (rgb(${String(dominantColor.r)},${String(dominantColor.g)},${String(dominantColor.b)})).`,
      );
    }
    if (flat) {
      statsParts.push('The image is flat/solid — all sampled pixels share one color.');
    }
    statsParts.push(
      hasAlpha
        ? 'Alpha: the image uses an alpha channel (non-opaque pixels present).'
        : 'Alpha: none — the image is fully opaque.',
    );
    parts.push(statsParts.join(' '));
  }
  if (input.kind === 'image' && input.dimensions && delivery?.kind !== 'crop') {
    parts.push(
      'If you need to output coordinates, output relative coordinates first ' +
        'and compute absolute coordinates using the original image size.',
    );
  }
  parts.push(
    'If you generate or edit images or videos via commands or scripts, ' +
      'read the result back immediately before continuing.',
  );
  return `<system>${parts.join(' ')}</system>`;
}

function buildImageDeliveryLimitError(input: {
  readonly finalBytes: number;
  readonly readByteBudget: number;
  readonly maxEdge: number;
}): string {
  return (
    `Image is too large to send safely after compression (${String(input.finalBytes)} bytes; ` +
    `limit ${String(input.readByteBudget)} bytes and ${String(input.maxEdge)}px on the longest edge). ` +
    'The original image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy within both limits, ' +
    'then call ReadMediaFile on the smaller copy.'
  );
}

function buildImageDecodeLimitError(finalBytes: number): string {
  return (
    `Image is too large to process safely for region or full_resolution (${String(finalBytes)} bytes; ` +
    `safe decode limit ${String(MAX_IMAGE_DECODE_BYTES)} bytes). ` +
    'The original image was not sent to the model. Do not retry the same file unchanged. ' +
    'Use Bash or an available image-processing tool to create a smaller copy or crop the needed ' +
    'region into a separate image, then call ReadMediaFile on the resulting file.'
  );
}

function buildFullResolutionLimitError(path: string, finalBytes: number): string {
  return (
    `"${path}" is ${String(finalBytes)} bytes (${formatByteSize(finalBytes)}), ` +
    `over the ${String(IMAGE_BYTE_BUDGET)}-byte (${formatByteSize(IMAGE_BYTE_BUDGET)}) ` +
    'per-image limit, so full_resolution cannot be honored. ' +
    'Use region to view a crop at full fidelity instead.'
  );
}

function shouldSurfaceVideoUploadError(error: unknown, inlineVideoSupported: boolean): boolean {
  if (error instanceof VideoUploadUnsupportedError) return !inlineVideoSupported;
  return isVideoUploadAuthError(error);
}

export class ReadMediaFileTool implements AgentTool<ReadMediaFileInput> {
  declare readonly _serviceBrand: undefined;
  readonly name = 'ReadMediaFile' as const;
  readonly description: string;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(ReadMediaFileInputSchema);
  private readonly compressTelemetry: ImageCompressionTelemetry | undefined;
  private readonly inlineVideoSupported: boolean;
  constructor(
    private readonly runtime: IAgentRuntimeService,
    private readonly workspace: WorkspaceConfig,
    private readonly capabilities: ModelCapability,
    private readonly videoUploader?: VideoUploader,
    telemetry?: ITelemetryService,
    inlineVideoSupported?: boolean,
    private readonly visualInspector?: VisualMediaInspector,
  ) {
    this.description = buildDescription(capabilities, visualInspector !== undefined);
    this.compressTelemetry =
      telemetry === undefined ? undefined : { client: telemetry, source: 'read_media' };
    this.inlineVideoSupported = inlineVideoSupported ?? false;
  }

  private async videoContentPart(
    data: Buffer,
    mimeType: string,
    safePath: string,
  ): Promise<ContentPart> {
    if (this.videoUploader !== undefined) {
      try {
        return await this.videoUploader({
          data,
          mimeType,
          filename: safePath.split(/[\\/]/).at(-1),
        });
      } catch (error) {
        if (shouldSurfaceVideoUploadError(error, this.inlineVideoSupported)) throw error;
      }
    }
    return inlineVideoPart(data, mimeType);
  }

  resolveExecution(args: ReadMediaFileInput): ToolExecution {
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }
    const inspected = inspectAgentRuntime(this.runtime);
    const env = inspected.environment;
    const view = new RuntimeWorkspaceView(inspected, {
      workDir: this.workspace.workspaceDir,
      additionalDirs: this.workspace.additionalDirs,
    });
    const workspace = { workspaceDir: view.workDir, additionalDirs: view.additionalDirs };
    const path = resolvePathAccessPath(args.path, {
      env,
      workspace,
      operation: 'read',
    });
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Reading media: ${args.path}`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspace.workspaceDir,
          pathClass: env.pathClass,
          homeDir: env.homeDir,
        }),
      execute: async (ctx) => {
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          return await this.execution(args, path, lease.runtime.fs!, env, ctx.signal);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    args: ReadMediaFileInput,
    safePath: string,
    fs: IHostFileSystem,
    env: HostEnvironmentInfo,
    signal?: AbortSignal,
  ): Promise<ExecutableToolResult> {
    if (!args.path) {
      return { isError: true, output: 'File path cannot be empty.' };
    }

    try {
      const header = await fs.readBytes(safePath, MEDIA_SNIFF_BYTES);
      const fileType = detectFileType(safePath, header, 'media');

      if (fileType.kind === 'text') {
        return {
          isError: true,
          output: `"${args.path}" is a text file. Use Read to read text files.`,
        };
      }
      if (fileType.kind === 'unknown') {
        return {
          isError: true,
          output:
            `"${args.path}" is not a supported image or video file. ` +
            'Use Read for text files, or Bash or an MCP tool for other binary formats.',
        };
      }

      if (fileType.kind === 'image' && !this.capabilities.image_in) {
        return {
          isError: true,
          output:
            'The current model does not support image input. ' +
            'Tell the user to use a model with image input capability.',
        };
      }
      if (fileType.kind === 'image' && !isModelAcceptedImageMime(fileType.mimeType)) {
        return {
          isError: true,
          output: buildImageConversionGuidance(args.path, fileType.mimeType, env.osKind),
        };
      }
      if (fileType.kind === 'video' && !this.capabilities.video_in) {
        return {
          isError: true,
          output:
            'The current model does not support video input. ' +
            'Tell the user to use a model with video input capability.',
        };
      }

      const stat = await fs.stat(safePath);
      if (stat.size === 0) {
        return { isError: true, output: `"${args.path}" is empty.` };
      }
      if (stat.size > MAX_MEDIA_BYTES) {
        return {
          isError: true,
          output:
            `"${args.path}" is ${String(stat.size)} bytes, which exceeds the ` +
            `maximum ${String(MAX_MEDIA_MEGABYTES)}MB for media files.`,
        };
      }

      if (fileType.kind === 'video' && (args.region !== undefined || args.full_resolution === true)) {
        return {
          isError: true,
          output: 'region and full_resolution apply only to image files.',
        };
      }

      if (
        fileType.kind === 'image' &&
        stat.size > MAX_IMAGE_DECODE_BYTES &&
        (args.region !== undefined || args.full_resolution === true)
      ) {
        return {
          isError: true,
          output: buildImageDecodeLimitError(stat.size),
        };
      }

      if (
        fileType.kind === 'image' &&
        args.region === undefined &&
        args.full_resolution === true &&
        stat.size > IMAGE_BYTE_BUDGET
      ) {
        return {
          isError: true,
          output: buildFullResolutionLimitError(args.path, stat.size),
        };
      }

      const delegatedRead = this.visualInspector !== undefined;
      const imageDeliveryLimits = delegatedRead
        ? { readByteBudget: IMAGE_BYTE_BUDGET, maxEdge: MAX_VISUAL_MODEL_EDGE_PX }
        : { readByteBudget: resolveReadImageByteBudget(), maxEdge: resolveMaxImageEdgePx() };
      if (
        fileType.kind === 'image' &&
        args.region === undefined &&
        args.full_resolution !== true &&
        stat.size > MAX_IMAGE_DECODE_BYTES &&
        stat.size > imageDeliveryLimits.readByteBudget
      ) {
        return {
          isError: true,
          output: buildImageDeliveryLimitError({
            finalBytes: stat.size,
            ...imageDeliveryLimits,
          }),
        };
      }

      const data = Buffer.from(await fs.readBytes(safePath));
      let dimensions = fileType.kind === 'image' ? sniffImageDimensions(data) : null;
      let mediaPart: ContentPart;
      let delivery: ImageDelivery | undefined;
      if (fileType.kind === 'image') {
        if (args.region !== undefined) {
          const outcome = await cropImageForModel(data, fileType.mimeType, args.region, {
            skipResize: args.full_resolution === true,
            telemetry: this.compressTelemetry,
          });
          if (!outcome.ok) {
            return { isError: true, output: `Cannot read region from "${args.path}": ${outcome.error}` };
          }
          const base64 = Buffer.from(outcome.data).toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${outcome.mimeType};base64,${base64}` },
          };
          delivery = {
            kind: 'crop',
            width: outcome.width,
            height: outcome.height,
            byteLength: outcome.finalByteLength,
            mimeType: outcome.mimeType,
            region: outcome.region,
            resized: outcome.resized,
          };
          dimensions = { width: outcome.originalWidth, height: outcome.originalHeight };
        } else if (args.full_resolution === true) {
          if (data.length > IMAGE_BYTE_BUDGET) {
            return {
              isError: true,
              output: buildFullResolutionLimitError(args.path, data.length),
            };
          }
          const base64 = data.toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${fileType.mimeType};base64,${base64}` },
          };
          delivery = {
            kind: 'full',
            width: dimensions?.width ?? 0,
            height: dimensions?.height ?? 0,
            byteLength: data.length,
            mimeType: fileType.mimeType,
          };
        } else {
          const { readByteBudget, maxEdge } = imageDeliveryLimits;
          const compressed = await compressImageForModel(data, fileType.mimeType, {
            byteBudget: readByteBudget,
            maxEdge,
            telemetry: this.compressTelemetry,
          });
          if (
            compressed.finalByteLength > readByteBudget ||
            Math.max(compressed.width, compressed.height) > maxEdge
          ) {
            return {
              isError: true,
              output: buildImageDeliveryLimitError({
                finalBytes: compressed.finalByteLength,
                readByteBudget,
                maxEdge,
              }),
            };
          }
          const base64 = Buffer.from(compressed.data).toString('base64');
          mediaPart = {
            type: 'image_url',
            imageUrl: { url: `data:${compressed.mimeType};base64,${base64}` },
          };
          delivery = {
            kind: compressed.changed ? 'downsampled' : 'untouched',
            width: compressed.width,
            height: compressed.height,
            byteLength: compressed.finalByteLength,
            mimeType: compressed.mimeType,
          };
          if (compressed.changed) {
            dimensions = { width: compressed.originalWidth, height: compressed.originalHeight };
          }
        }
      } else {
        mediaPart = await this.videoContentPart(data, fileType.mimeType, safePath);
      }

      const tag = fileType.kind === 'image' ? 'image' : 'video';
      const openText = `<${tag} path="${safePath}">`;
      const closeText = `</${tag}>`;

      let pixelStats: PixelStats | undefined;
      if (this.visualInspector !== undefined && fileType.kind === 'image') {
        pixelStats = (await extractPixelStats(data, fileType.mimeType)) ?? undefined;
      }

      const note = buildMediaNote({
        kind: fileType.kind,
        mimeType: fileType.mimeType,
        byteSize: stat.size,
        dimensions,
        delivery,
        pixelStats,
      });

      if (this.visualInspector !== undefined) {
        const inspectionText = await this.visualInspector(
          {
            description:
              `${openText}\n${VISUAL_INSPECTION_INSTRUCTION}${renderInspectionStats(pixelStats)}\n` +
              closeText,
            parts: [mediaPart],
          },
          signal,
        );
        return { output: [{ type: 'text', text: inspectionText }], note, isError: false };
      }

      const output: ContentPart[] = [
        { type: 'text', text: openText },
        mediaPart,
        { type: 'text', text: closeText },
      ];

      return { output, note, isError: false };
    } catch (error) {
      return {
        isError: true,
        output: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
