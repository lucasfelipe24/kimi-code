import { afterEach, describe, expect, it, vi } from 'vitest';

import { dispatchInput, type SlashCommandHost } from '#/tui/commands/dispatch';
import { setExperimentalFeatures } from '#/tui/commands/experimental-flags';
import { handleMemoryCommand } from '#/tui/commands/memory';

function makeHost() {
  const host = {
    showNotice: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost & {
    showNotice: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
  };
  return host;
}

describe('handleMemoryCommand', () => {
  afterEach(() => {
    setExperimentalFeatures([]);
  });
  it('shows an informative persistent-memory notice', () => {
    const host = makeHost();

    handleMemoryCommand(host, '');

    expect(host.showError).not.toHaveBeenCalled();
    expect(host.showNotice).toHaveBeenCalledTimes(1);
    const [title, detail] = host.showNotice.mock.calls[0] as [string, string];
    expect(title).toBe('Persistent memory');
    expect(detail).toBe(
      [
        'The persistent-memory core is enabled for this session.',
        '',
        'The agent may use memory automatically or through its Memory tool,',
        'according to the active persistent-memory flags.',
        '',
        'Interactive memory management (CRUD) is not available in this version.',
      ].join('\n'),
    );
  });

  it('returns an explicit unsupported notice for arguments', () => {
    const host = makeHost();

    handleMemoryCommand(host, 'list');

    expect(host.showNotice).toHaveBeenCalledWith(
      'Persistent memory',
      'Memory subcommands and arguments are not supported in this version. Use /memory without arguments for status.',
    );
  });
});

describe('dispatchInput /memory integration', () => {
  function makeDispatchHost(engineV2: boolean) {
    const host = makeHost();
    return {
      ...host,
      engineV2,
      state: { appState: { streamingPhase: 'idle', isCompacting: false } },
      skillCommandMap: new Map<string, string>(),
      pluginCommandMap: new Map<string, string>(),
      sendNormalUserInput: vi.fn(),
      sendSkillActivation: vi.fn(),
      track: vi.fn(),
    } as unknown as SlashCommandHost & {
      sendNormalUserInput: ReturnType<typeof vi.fn>;
      sendSkillActivation: ReturnType<typeof vi.fn>;
      track: ReturnType<typeof vi.fn>;
    };
  }

  it.each([
    { engineV2: false, flagEnabled: false },
    { engineV2: false, flagEnabled: true },
    { engineV2: true, flagEnabled: false },
  ])('fails closed with a generic local error (%o)', ({ engineV2, flagEnabled }) => {
    setExperimentalFeatures(
      flagEnabled ? [{ id: 'persistent-memory', enabled: true }] : [],
    );
    const host = makeDispatchHost(engineV2);

    dispatchInput(host, '/memory list secret-content');

    expect(host.showNotice).not.toHaveBeenCalled();
    expect(host.sendNormalUserInput).not.toHaveBeenCalled();
    expect(host.sendSkillActivation).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('/memory is not available in this version.');
    expect(host.track).toHaveBeenCalledWith('input_command_invalid', {
      reason: 'unavailable',
      command: 'memory',
    });
    expect(host.track).not.toHaveBeenCalledWith('input_command', expect.anything());
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

  it('dispatches the supported gate without tracking argument content', async () => {
    setExperimentalFeatures([{ id: 'persistent-memory', enabled: true }]);
    const host = makeDispatchHost(true);

    dispatchInput(host, '/memory list secret-content');
    await vi.waitFor(() => {
      expect(host.showNotice).toHaveBeenCalled();
    });

    expect(host.showNotice).toHaveBeenCalledWith(
      'Persistent memory',
      'Memory subcommands and arguments are not supported in this version. Use /memory without arguments for status.',
    );
    expect(host.track).toHaveBeenCalledWith('input_command', { command: 'memory' });
    expect(host.track.mock.calls[0]?.[1]).not.toHaveProperty('args');
    expect(host.track.mock.calls[0]?.[1]).not.toHaveProperty('content');
  });

  it('treats whitespace-only input as the bare status command', async () => {
    setExperimentalFeatures([{ id: 'persistent-memory', enabled: true }]);
    const host = makeDispatchHost(true);

    dispatchInput(host, '/memory   ');
    await vi.waitFor(() => {
      expect(host.showNotice).toHaveBeenCalled();
    });

    expect(host.showNotice).toHaveBeenCalledWith(
      'Persistent memory',
      expect.stringContaining('The persistent-memory core is enabled for this session.'),
    );
  });

  it('shows status and tracks only the command name without arguments', async () => {
    setExperimentalFeatures([{ id: 'persistent-memory', enabled: true }]);
    const host = makeDispatchHost(true);

    dispatchInput(host, '/memory');
    await vi.waitFor(() => {
      expect(host.showNotice).toHaveBeenCalled();
    });

    expect(host.showNotice).toHaveBeenCalledWith(
      'Persistent memory',
      expect.stringContaining(
        'Interactive memory management (CRUD) is not available in this version.',
      ),
    );
    expect(host.track).toHaveBeenCalledTimes(1);
    expect(host.track).toHaveBeenCalledWith('input_command', { command: 'memory' });
  });
});
