import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import {
  PluginAutoInstaller,
  type PluginAutoInstallerSession,
} from '#/tui/controllers/plugin-auto-installer';

function makePluginSummary(overrides: Partial<PluginSummary> = {}): PluginSummary {
  return {
    id: 'kimi-documents',
    displayName: 'Kimi Documents',
    version: '0.1.0',
    enabled: true,
    state: 'ok',
    skillCount: 5,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'local-path',
    originalSource: '/bundle/kimi-documents',
    ...overrides,
  };
}

interface Harness {
  readonly session: PluginAutoInstallerSession & { installed: PluginSummary[] };
  readonly installer: PluginAutoInstaller;
  readonly installCalls: string[];
  readonly warnings: string[];
  readonly pluginDir: string;
}

async function makeHarness(options: {
  readonly installed?: readonly PluginSummary[];
  readonly bundledVersion?: string;
  readonly withBundle?: boolean;
} = {}): Promise<Harness> {
  const { installed = [], bundledVersion = '0.1.0', withBundle = true } = options;
  const pluginDir = await mkdtemp(join(tmpdir(), 'kimi-documents-bundle-'));
  if (withBundle) {
    await writeFile(
      join(pluginDir, 'kimi.plugin.json'),
      JSON.stringify({ name: 'kimi-documents', version: bundledVersion }),
    );
  }
  const installCalls: string[] = [];
  const warnings: string[] = [];
  const session = {
    installed: [...installed],
    listPlugins() {
      return Promise.resolve(session.installed);
    },
    installPlugin(source: string) {
      installCalls.push(source);
      const summary = makePluginSummary({ version: bundledVersion });
      session.installed.push(summary);
      return Promise.resolve(summary);
    },
  };
  const installer = new PluginAutoInstaller({
    getSession: () => session,
    resolvePluginDir: () => Promise.resolve(withBundle ? pluginDir : undefined),
    warn: (message) => warnings.push(message),
  });
  return { session, installer, installCalls, warnings, pluginDir };
}

describe('PluginAutoInstaller', () => {
  let harness: Harness | undefined;

  beforeEach(() => {
    harness = undefined;
  });

  afterEach(async () => {
    if (harness !== undefined) await rm(harness.pluginDir, { recursive: true, force: true });
  });

  it('installs the bundled plugin when it is not installed', async () => {
    harness = await makeHarness();
    await harness.installer.ensureInstalled();
    expect(harness.installCalls).toEqual([harness.pluginDir]);
    expect(harness.warnings).toEqual([]);
  });

  it('does nothing when the installed version matches the bundle', async () => {
    harness = await makeHarness({ installed: [makePluginSummary({ version: '0.1.0' })] });
    await harness.installer.ensureInstalled();
    expect(harness.installCalls).toEqual([]);
  });

  it('reinstalls when the installed version differs from the bundle', async () => {
    harness = await makeHarness({ installed: [makePluginSummary({ version: '0.0.9' })] });
    await harness.installer.ensureInstalled();
    expect(harness.installCalls).toEqual([harness.pluginDir]);
  });

  it('does nothing when no bundle is found', async () => {
    harness = await makeHarness({ withBundle: false });
    await harness.installer.ensureInstalled();
    expect(harness.installCalls).toEqual([]);
    expect(harness.warnings).toEqual([]);
  });

  it('runs only once per app run', async () => {
    harness = await makeHarness();
    await harness.installer.ensureInstalled();
    await harness.installer.ensureInstalled();
    expect(harness.installCalls).toEqual([harness.pluginDir]);
  });

  it('warns instead of rejecting when installation fails', async () => {
    harness = await makeHarness();
    vi.spyOn(harness.session, 'installPlugin').mockRejectedValueOnce(new Error('read-only home'));
    await harness.installer.ensureInstalled();
    expect(harness.warnings).toHaveLength(1);
    expect(harness.warnings[0]).toContain('kimi-documents');
    expect(harness.warnings[0]).toContain('read-only home');
  });

  it('does nothing without a session', async () => {
    const pluginDir = await mkdtemp(join(tmpdir(), 'kimi-documents-bundle-'));
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'kimi.plugin.json'), JSON.stringify({ name: 'kimi-documents' }));
    try {
      const installer = new PluginAutoInstaller({
        getSession: () => undefined,
        resolvePluginDir: () => Promise.resolve(pluginDir),
      });
      await installer.ensureInstalled();
    } finally {
      await rm(pluginDir, { recursive: true, force: true });
    }
  });
});
