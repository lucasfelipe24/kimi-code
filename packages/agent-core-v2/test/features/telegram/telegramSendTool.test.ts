import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { TelegramSendTool, ITelegramSendTool } from '#/features/telegram/tools/telegramSend';
import { ITelegramGatewayService } from '#/features/telegram/gateway';
import type { RuntimeWorkspaceRoots } from '#/runtime/runtime';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import type { ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const TEST_WORK_DIR = '/workspace';

async function run(execution: ToolExecution): Promise<ExecutableToolResult> {
  if ('execute' in execution) {
    return execution.execute({ turnId: 1, toolCallId: 'call_1', signal: new AbortController().signal });
  }
  return execution;
}

describe('TelegramSendTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let sendPhoto: ReturnType<typeof vi.fn>;
  let sendDocument: ReturnType<typeof vi.fn>;
  let fs: IHostFileSystem;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    sendPhoto = vi.fn().mockResolvedValue(7);
    sendDocument = vi.fn().mockResolvedValue(8);

    fs = {
      _serviceBrand: undefined,
      readText: vi.fn(),
      writeText: vi.fn(),
      appendText: vi.fn(),
      readBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
      writeBytes: vi.fn(),
      readLines: vi.fn(),
      createExclusive: vi.fn(),
      stat: vi.fn().mockResolvedValue({ isFile: true, isDirectory: false, size: 3 }),
      lstat: vi.fn(),
      readdir: vi.fn(),
      mkdir: vi.fn(),
      remove: vi.fn(),
      realpath: vi.fn().mockImplementation((p: string) => Promise.resolve(p)),
    } as unknown as IHostFileSystem;

    ix.stub(IAgentRuntimeService, {
      _serviceBrand: undefined,
      onDidChange: () => ({ dispose: () => {} }),
      inspect: () => ({
        identity: { runtimeId: 'r1', workspaceId: 'w1', generation: 'g1' },
        capabilities: new Set(['fs']),
        environment: {},
        path: { separator: '/', delimiter: ':', isAbsolute: (p: string) => p.startsWith('/'), join: (...ps: string[]) => ps.join('/'), relative: () => '', resolve: () => '', basename: () => '', dirname: () => '' },
        workspace: { mapRoots: (roots: RuntimeWorkspaceRoots) => roots },
        fs,
        status: 'ready',
        onDidChangeStatus: () => ({ dispose: () => {} }),
        dispose: () => {},
      }),
      isAvailable: vi.fn().mockReturnValue(true),
      acquire: vi.fn().mockReturnValue({
        runtime: {
          identity: { runtimeId: 'r1', workspaceId: 'w1', generation: 'g1' },
          fs,
        },
        track: vi.fn(),
        dispose: vi.fn(),
      }),
    } as unknown as IAgentRuntimeService);

    ix.stub(ISessionWorkspaceContext, {
      _serviceBrand: undefined,
      workDir: TEST_WORK_DIR,
      additionalDirs: [],
      resolve: vi.fn((rel: string) => (rel.startsWith('/') ? rel : `${TEST_WORK_DIR}/${rel}`)),
      isWithin: vi.fn((abs: string) => abs === TEST_WORK_DIR || abs.startsWith(`${TEST_WORK_DIR}/`)),
      assertAllowed: vi.fn((abs: string) => abs),
    } as unknown as ISessionWorkspaceContext);

    ix.stub(ITelegramGatewayService, {
      _serviceBrand: undefined,
      gatewayState: { configured: true, maskedToken: '***', chatId: '1' },
      onUpdate: () => ({ dispose: () => {} }),
      registerInbound: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(1),
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendPhoto,
      sendDocument,
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      setMessageReaction: vi.fn().mockResolvedValue(undefined),
    } as unknown as ITelegramGatewayService);

    ix.set(ITelegramSendTool, new SyncDescriptor(TelegramSendTool));
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('sends a photo for image files', async () => {
    const tool = ix.get(ITelegramSendTool);
    const execution = tool.resolveExecution({ path: 'screenshot.png' });
    const result = await run(execution);

    expect(sendPhoto).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
  });

  it('sends a document for non-image files', async () => {
    const tool = ix.get(ITelegramSendTool);
    const execution = tool.resolveExecution({ path: 'report.pdf' });
    const result = await run(execution);

    expect(sendDocument).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
  });

  it('rejects paths outside the workspace', async () => {
    const tool = ix.get(ITelegramSendTool);
    const execution = tool.resolveExecution({ path: '/etc/passwd' });
    const result = await run(execution);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('escapes the workspace');
  });

  it('rejects oversized files', async () => {
    (fs.stat as ReturnType<typeof vi.fn>).mockResolvedValue({ isFile: true, isDirectory: false, size: 60 * 1024 * 1024 });
    const tool = ix.get(ITelegramSendTool);
    const execution = tool.resolveExecution({ path: 'big.bin' });
    const result = await run(execution);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('exceeds');
  });
});
