import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';
import { handleMemoryCommand } from '#/tui/commands/memory';
import { memoryToDoc, parseMemoryDoc, serializeMemoryDoc } from '#/tui/commands/memory-doc';
import type { MemorySelectorOptions } from '#/tui/components/dialogs/memory-selector';
import type { MemorySummary } from '@moonshot-ai/kimi-code-sdk';

const editInExternalEditor = vi.hoisted(() => vi.fn());
const resolveEditorCommand = vi.hoisted(() => vi.fn());

vi.mock('#/utils/process/external-editor', () => ({
  editInExternalEditor,
  resolveEditorCommand,
}));

function makeMemory(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    name: 'build command',
    description: 'how to build',
    type: 'project',
    scope: 'workspace',
    origin: 'workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    body: 'run pnpm build',
    ...overrides,
  };
}

function makeHost(memories: MemorySummary[] = []) {
  const harness = {
    listMemories: vi.fn(async () => memories),
    createMemory: vi.fn(async (_workDir: string, input: unknown) => ({
      ...makeMemory(),
      ...(input as object),
    })),
    updateMemory: vi.fn(async () => makeMemory()),
    forgetMemory: vi.fn(async () => undefined),
  };
  const host = {
    harness,
    state: {
      appState: { workDir: '/work', editorCommand: null },
      externalEditorRunning: false,
      ui: { stop: vi.fn(), start: vi.fn(), requestRender: vi.fn() },
    },
    showNotice: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: typeof harness;
    showNotice: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };
  return host;
}

/** The most recent MemorySelectorOptions handed to `mountEditorReplacement`. */
function lastSelectorOptions(
  host: ReturnType<typeof makeHost>,
): MemorySelectorOptions {
  const calls = host.mountEditorReplacement.mock.calls;
  const component = calls.at(-1)?.[0] as { opts: MemorySelectorOptions };
  return component.opts;
}

describe('handleMemoryCommand', () => {
  afterEach(() => {
    editInExternalEditor.mockReset();
    resolveEditorCommand.mockReset();
  });

  it('mounts the manager even when empty so the user can create', async () => {
    const host = makeHost([]);

    handleMemoryCommand(host, '');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalled();
    });

    expect(host.showError).not.toHaveBeenCalled();
    expect(lastSelectorOptions(host).memories).toHaveLength(0);
  });

  it('mounts the memory manager when memories exist', async () => {
    const host = makeHost([makeMemory()]);

    handleMemoryCommand(host, '');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalled();
    });

    expect(host.showError).not.toHaveBeenCalled();
    expect(host.harness.listMemories).toHaveBeenCalledWith('/work');
  });

});

describe('memory manager create/edit flows', () => {
  afterEach(() => {
    editInExternalEditor.mockReset();
    resolveEditorCommand.mockReset();
  });

  async function openManager(host: ReturnType<typeof makeHost>): Promise<MemorySelectorOptions> {
    handleMemoryCommand(host, '');
    await vi.waitFor(() => {
      expect(host.mountEditorReplacement).toHaveBeenCalled();
    });
    return lastSelectorOptions(host);
  }

  it('creates a memory from a valid edited document', async () => {
    const host = makeHost([]);
    resolveEditorCommand.mockReturnValue('vim');
    editInExternalEditor.mockResolvedValue(
      serializeMemoryDoc({
        scope: 'workspace',
        type: 'reference',
        name: 'deploy',
        description: 'how to deploy',
        body: 'run make deploy',
      }),
    );

    const opts = await openManager(host);
    opts.onCreate();

    await vi.waitFor(() => {
      expect(host.harness.createMemory).toHaveBeenCalled();
    });
    expect(host.harness.createMemory).toHaveBeenCalledWith('/work', {
      scope: 'workspace',
      type: 'reference',
      name: 'deploy',
      description: 'how to deploy',
      body: 'run make deploy',
    });
    expect(host.track).toHaveBeenCalledWith('memory_write', { scope: 'workspace' });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('rejects an invalid document without calling createMemory', async () => {
    const host = makeHost([]);
    resolveEditorCommand.mockReturnValue('vim');
    editInExternalEditor.mockResolvedValue(
      ['---', 'scope: nope', 'type: reference', 'name: x', 'description: y', '---', '', 'body'].join(
        '\n',
      ),
    );

    const opts = await openManager(host);
    opts.onCreate();

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(host.harness.createMemory).not.toHaveBeenCalled();
    expect(String(host.showError.mock.calls[0]?.[0])).toContain('Invalid scope');
  });

  it('treats a cancelled editor as a no-op', async () => {
    const host = makeHost([]);
    resolveEditorCommand.mockReturnValue('vim');
    editInExternalEditor.mockResolvedValue(undefined);

    const opts = await openManager(host);
    opts.onCreate();

    await vi.waitFor(() => {
      expect(host.state.ui.start).toHaveBeenCalled();
    });
    expect(host.harness.createMemory).not.toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('errors when no editor is configured', async () => {
    const host = makeHost([]);
    resolveEditorCommand.mockReturnValue(undefined);

    const opts = await openManager(host);
    opts.onCreate();

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(editInExternalEditor).not.toHaveBeenCalled();
    expect(String(host.showError.mock.calls[0]?.[0])).toContain('$VISUAL / $EDITOR');
  });

  it('updates an existing memory through the edit flow', async () => {
    const memory = makeMemory({ version: 3 });
    const host = makeHost([memory]);
    resolveEditorCommand.mockReturnValue('vim');
    editInExternalEditor.mockResolvedValue(
      serializeMemoryDoc({
        scope: memory.scope,
        type: 'feedback',
        name: 'build command',
        description: 'how to build the app',
        body: 'run pnpm build --force',
      }),
    );

    const opts = await openManager(host);
    opts.onEdit(memory);

    await vi.waitFor(() => {
      expect(host.harness.updateMemory).toHaveBeenCalled();
    });
    expect(host.harness.updateMemory).toHaveBeenCalledWith('/work', memory.id, {
      scope: 'workspace',
      type: 'feedback',
      name: 'build command',
      description: 'how to build the app',
      body: 'run pnpm build --force',
    });
  });

  it('maps a version conflict to a clear message', async () => {
    const memory = makeMemory();
    const host = makeHost([memory]);
    resolveEditorCommand.mockReturnValue('vim');
    editInExternalEditor.mockResolvedValue(memoryToDoc(memory));
    host.harness.updateMemory.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'memory.version_conflict' }),
    );

    const opts = await openManager(host);
    opts.onEdit(memory);

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(String(host.showError.mock.calls[0]?.[0])).toContain('changed since you opened it');
  });
});

describe('memory-doc serialize/parse', () => {
  it('round-trips a memory document', () => {
    const fields = {
      scope: 'project' as const,
      type: 'user' as const,
      name: 'name with: colon',
      description: 'one line',
      body: 'multi\nline\nbody',
    };
    const parsed = parseMemoryDoc(serializeMemoryDoc(fields));
    expect(parsed).toEqual({ ok: true, value: fields });
  });

  it('tolerates comments and unknown keys, rejects a bad enum', () => {
    const text = [
      '---',
      '# a comment',
      'scope: workspace',
      'type: banana',
      'unknown: ignored',
      'name: n',
      'description: d',
      '---',
      '',
      'body',
    ].join('\n');
    const parsed = parseMemoryDoc(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain('Invalid type');
  });

  it('rejects an empty body', () => {
    const parsed = parseMemoryDoc(
      ['---', 'scope: user', 'type: user', 'name: n', 'description: d', '---', '', '   '].join('\n'),
    );
    expect(parsed.ok).toBe(false);
  });
});

describe('dispatchInput /memory integration', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });

  function makeDispatchHost(engineV2: boolean) {
    const harness = {
      listMemories: vi.fn(async () => []),
      forgetMemory: vi.fn(async () => undefined),
    };
    return {
      harness,
      engineV2,
      state: { appState: { streamingPhase: 'idle', isCompacting: false, workDir: '/work' } },
      skillCommandMap: new Map<string, string>(),
      pluginCommandMap: new Map<string, string>(),
      sendNormalUserInput: vi.fn(),
      sendSkillActivation: vi.fn(),
      showNotice: vi.fn(),
      showError: vi.fn(),
      mountEditorReplacement: vi.fn(),
      track: vi.fn(),
    } as unknown as SlashCommandHost & {
      harness: typeof harness;
      sendNormalUserInput: ReturnType<typeof vi.fn>;
      sendSkillActivation: ReturnType<typeof vi.fn>;
      showError: ReturnType<typeof vi.fn>;
      track: ReturnType<typeof vi.fn>;
    };
  }

  it('fails closed with a generic local error on engine v1', () => {
    const host = makeDispatchHost(false);

    dispatchInput(host, '/memory list secret-content');

    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('/memory is not available in this version.');
    expect(host.track).toHaveBeenCalledWith('input_command_invalid', {
      reason: 'unavailable',
      command: 'memory',
    });
    for (const call of host.track.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('secret-content');
    }
  });

  it('does not let a same-named skill capture the closed gate', () => {
    const host = makeDispatchHost(false);
    host.skillCommandMap.set('memory', 'memory');

    dispatchInput(host, '/memory list');

    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('/memory is not available in this version.');
  });

  it('dispatches to the manager without tracking argument content', async () => {
    const host = makeDispatchHost(true);

    dispatchInput(host, '/memory list secret-content');
    await vi.waitFor(() => {
      expect(host.harness.listMemories).toHaveBeenCalled();
    });

    expect(host.track).toHaveBeenCalledWith('input_command', { command: 'memory' });
    expect(host.track.mock.calls[0]?.[1]).not.toHaveProperty('args');
    expect(host.track.mock.calls[0]?.[1]).not.toHaveProperty('content');
  });
});
