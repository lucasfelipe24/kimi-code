import { createDecorator, type ServiceIdentifier, type ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { ToolAccesses, type ExecutableToolResult, type ToolExecution } from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { z } from 'zod';

import { ITelegramGatewayService } from '../gateway';
import TELEGRAM_SEND_DESCRIPTION from './telegram-send.md?raw';

const TELEGRAM_SEND_MAX_BYTES = 50 * 1024 * 1024;
const TELEGRAM_SEND_MAX_MIB = TELEGRAM_SEND_MAX_BYTES / (1024 * 1024);

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

export const TelegramSendInputSchema = z.object({
  path: z.string().describe('absolute or workspace-relative path of the file to send'),
  caption: z.string().optional().describe('optional caption'),
});

export type TelegramSendInput = z.infer<typeof TelegramSendInputSchema>;

export interface ITelegramSendTool {
  readonly _serviceBrand: undefined;
  readonly name: 'TelegramSend';
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  resolveExecution(args: TelegramSendInput): ToolExecution;
}

export const ITelegramSendTool: ServiceIdentifier<ITelegramSendTool> =
  createDecorator<ITelegramSendTool>('telegramSendTool');

export function telegramConfigured(accessor: ServicesAccessor): boolean {
  return accessor.get(ITelegramGatewayService).gatewayState.configured;
}

export class TelegramSendTool implements ITelegramSendTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'TelegramSend' as const;
  readonly description = TELEGRAM_SEND_DESCRIPTION;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(TelegramSendInputSchema);

  constructor(
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ITelegramGatewayService private readonly gateway: ITelegramGatewayService,
  ) {}

  resolveExecution(args: TelegramSendInput): ToolExecution {
    const inspected = inspectAgentRuntime(this.runtime);
    const path = this.workspaceCtx.resolve(args.path);
    return {
      accesses: ToolAccesses.readFile(path),
      description: `Sending ${args.path} to Telegram`,
      display: { kind: 'file_io', operation: 'read', path },
      approvalRule: this.name,
      execute: async () => {
        const lease = this.runtime.acquire(['fs']);
        try {
          if (lease.runtime.identity.generation !== inspected.identity.generation) {
            return { isError: true, output: 'Runtime changed before execution. Retry the tool call.' };
          }
          return await this.execution(lease.runtime.fs!, args, path);
        } finally {
          lease.dispose();
        }
      },
    };
  }

  private async execution(
    fs: import('#/os/interface/hostFileSystem').IHostFileSystem,
    args: TelegramSendInput,
    requestedPath: string,
  ): Promise<ExecutableToolResult> {
    let realPath: string;
    try {
      realPath = await fs.realpath(requestedPath);
    } catch {
      return { isError: true, output: `telegram_send: file not found: ${args.path}` };
    }

    if (!this.workspaceCtx.isWithin(realPath)) {
      return { isError: true, output: 'telegram_send: path escapes the workspace root.' };
    }

    let stat: import('#/os/interface/hostFileSystem').HostFileStat;
    try {
      stat = await fs.stat(realPath);
    } catch {
      return { isError: true, output: `telegram_send: file not found: ${args.path}` };
    }
    if (!stat.isFile) {
      return { isError: true, output: 'telegram_send: not a regular file.' };
    }
    if (stat.size > TELEGRAM_SEND_MAX_BYTES) {
      return {
        isError: true,
        output: `telegram_send: file exceeds ${String(TELEGRAM_SEND_MAX_MIB)} MiB limit.`,
      };
    }

    const bytes = await fs.readBytes(realPath);
    const filename = realPath.split('/').pop() ?? 'file';
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.gif' ? 'image/gif' : ext === '.webp' ? 'image/webp' : 'application/octet-stream';
    const blob = new Blob([bytes], { type: mime });

    try {
      const messageId = IMAGE_EXTENSIONS.has(ext)
        ? await this.gateway.sendPhoto({ file: blob, filename, caption: args.caption })
        : await this.gateway.sendDocument({ file: blob, filename, caption: args.caption });
      if (messageId === 0) {
        return { isError: true, output: 'telegram_send: Telegram gateway is not available.' };
      }
      return { output: `Sent ${filename} to Telegram.` };
    } catch (error) {
      return {
        isError: true,
        output: `telegram_send failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}


