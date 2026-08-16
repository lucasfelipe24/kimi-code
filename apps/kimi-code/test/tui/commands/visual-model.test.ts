/**
 * Scenario: /visual-model command behavior in the interactive TUI.
 * Responsibilities: picker opening with the configured visual model as current,
 * persistence of `[visual_model] model`, and error paths.
 * Wiring: real command and selector with the SDK/session boundaries stubbed by a small host rig.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/commands/visual-model.test.ts
 */
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import type { SlashCommandHost } from '#/tui/commands';
import { handleVisualModelCommand } from '#/tui/commands/config';
import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';

interface PickerOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly title?: string;
  readonly thinkingControl?: boolean;
  readonly onSelect: (selection: { alias: string }) => void;
}

function model(name: string, capabilities: string[] = []): ModelAlias {
  return {
    provider: 'test',
    model: name,
    maxContextSize: 200_000,
    displayName: name,
    capabilities,
  } as unknown as ModelAlias;
}

function makeHost(options?: {
  readonly visualModel?: { model?: string };
}) {
  const appState = {
    availableModels: {
      k2: model('k2', ['image_in', 'tool_use']),
      vision: model('vision', ['image_in', 'video_in', 'audio_in']),
      // The v1 derived entry must never be selectable.
      '__secondary__': model('vision', ['image_in']),
    } as Record<string, ModelAlias>,
    availableProviders: {},
    transcriptEntries: [],
  };
  const host = {
    state: {
      appState,
      transcriptEntries: [],
    },
    authFlow: {
      refreshOAuthProviderModels: vi.fn(async () => undefined),
    },
    harness: {
      getConfig: vi.fn(async () => ({
        providers: {},
        visualModel: options?.visualModel,
      })),
      setConfig: vi.fn(async () => ({})),
    },
    setAppState: vi.fn((patch) => Object.assign(appState, patch)),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    showStatus: vi.fn(),
    showError: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
  } as unknown as SlashCommandHost & {
    harness: {
      getConfig: ReturnType<typeof vi.fn>;
      setConfig: ReturnType<typeof vi.fn>;
    };
    mountEditorReplacement: ReturnType<typeof vi.fn>;
    showStatus: ReturnType<typeof vi.fn>;
    showError: ReturnType<typeof vi.fn>;
    showNotice: ReturnType<typeof vi.fn>;
  };
  return { host };
}

function mountedPicker(host: { mountEditorReplacement: ReturnType<typeof vi.fn> }): PickerOptions {
  expect(host.mountEditorReplacement).toHaveBeenCalledOnce();
  const component = host.mountEditorReplacement.mock.calls[0]![0];
  expect(component).toBeInstanceOf(TabbedModelSelectorComponent);
  return (component as unknown as { opts: PickerOptions }).opts;
}

describe('handleVisualModelCommand', () => {
  it('opens the picker filtered to user models, with the configured visual model as current', async () => {
    const { host } = makeHost({ visualModel: { model: 'vision' } });

    await handleVisualModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['k2', 'vision']);
    expect(opts.currentValue).toBe('vision');
    expect(opts.title).toContain('visual model');
    // The visual binding carries no explicit thinking choice in the picker.
    expect(opts.thinkingControl).toBe(false);
  });

  it('filters out models without media input capability', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {
      text: model('text'), // no capabilities at all
      imageOnly: model('imageOnly', ['image_in']),
      audioOnly: model('audioOnly', ['audio_in']),
    };

    await handleVisualModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['imageOnly', 'audioOnly']);
  });

  it('shows a notice when no configured model has media input capability', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {
      text: model('text'),
    };

    await handleVisualModelCommand(host, '');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.showError).not.toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('keeps the currently pinned visual model visible even if it lost its media capability', async () => {
    const { host } = makeHost({ visualModel: { model: 'text' } });
    host.state.appState.availableModels = {
      text: model('text'), // pinned alias, but no media capability
      vision: model('vision', ['image_in']),
    };

    await handleVisualModelCommand(host, '');

    const opts = mountedPicker(host);
    expect(Object.keys(opts.models)).toEqual(['text', 'vision']);
    expect(opts.currentValue).toBe('text');
  });

  it('rejects an alias argument whose model lacks media input capability', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {
      text: model('text'),
      vision: model('vision', ['image_in']),
    };

    await handleVisualModelCommand(host, 'text');

    expect(host.showError).toHaveBeenCalledWith(
      'text does not support media input (image, video, or audio).',
    );
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('persists the picked alias as [visual_model] model', async () => {
    const { host } = makeHost();

    await handleVisualModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'vision' });

    await vi.waitFor(() => {
      expect(host.showStatus).toHaveBeenCalled();
    });
    expect(host.harness.setConfig).toHaveBeenCalledWith({
      visualModel: { model: 'vision' },
    });
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('pre-selects a valid alias argument instead of erroring', async () => {
    const { host } = makeHost();

    await handleVisualModelCommand(host, 'vision');

    const opts = mountedPicker(host);
    expect(opts.selectedValue).toBe('vision');
  });

  it('rejects an unknown alias argument without opening the picker', async () => {
    const { host } = makeHost();

    await handleVisualModelCommand(host, 'nope');

    expect(host.showError).toHaveBeenCalledWith('Unknown model alias: nope');
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('shows a notice when no models are configured', async () => {
    const { host } = makeHost();
    host.state.appState.availableModels = {};

    await handleVisualModelCommand(host, '');

    expect(host.showNotice).toHaveBeenCalled();
    expect(host.mountEditorReplacement).not.toHaveBeenCalled();
  });

  it('reports a persistence failure without a status message', async () => {
    const { host } = makeHost();
    host.harness.setConfig.mockRejectedValueOnce(new Error('disk full'));

    await handleVisualModelCommand(host, '');
    mountedPicker(host).onSelect({ alias: 'vision' });

    await vi.waitFor(() => {
      expect(host.showError).toHaveBeenCalled();
    });
    expect(host.showError.mock.calls[0]![0]).toContain('disk full');
    expect(host.showStatus).not.toHaveBeenCalled();
  });
});
