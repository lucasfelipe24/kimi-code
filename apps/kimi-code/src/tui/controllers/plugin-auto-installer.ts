import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk';

import { resolveBundledPluginDir } from '#/utils/bundled-plugins';

/**
 * The slice of the SDK session the auto-installer needs. Structurally
 * satisfied by the full SDK `Session`, and easy to fake in tests.
 */
export interface PluginAutoInstallerSession {
  listPlugins(): Promise<readonly PluginSummary[]>;
  installPlugin(source: string): Promise<PluginSummary>;
}

export interface PluginAutoInstallerDeps {
  readonly getSession: () => PluginAutoInstallerSession | undefined;
  /** Overridable for tests; defaults to the packaged bundle resolution. */
  readonly resolvePluginDir?: (pluginId: string) => Promise<string | undefined>;
  /** Called with a non-blocking warning when auto-install fails. */
  readonly warn?: (message: string) => void;
}

/** Official plugins bundled into the CLI package and auto-installed at startup. */
const BUNDLED_PLUGIN_IDS = ['kimi-documents'] as const;

async function readBundledVersion(pluginDir: string): Promise<string | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(pluginDir, 'kimi.plugin.json'), 'utf8'));
    if (typeof raw === 'object' && raw !== null) {
      const version = (raw as Record<string, unknown>)['version'];
      if (typeof version === 'string' && version.length > 0) return version;
    }
  } catch {
    // Fall through — an unreadable manifest forces a reinstall attempt.
  }
  return undefined;
}

/**
 * Installs the official plugins bundled inside the CLI package. Runs once per
 * app run, after the first session is ready. Installation copies from the
 * local bundle (`installPlugin` with a directory source) — no network access
 * is involved. A plugin is (re)installed when it is missing or its installed
 * version differs from the bundled manifest's version, so CLI upgrades roll
 * the plugin forward automatically.
 *
 * Fully best-effort: never rejects, never blocks startup.
 */
export class PluginAutoInstaller {
  private ran = false;

  constructor(private readonly deps: PluginAutoInstallerDeps) {}

  async ensureInstalled(): Promise<void> {
    if (this.ran) return;
    this.ran = true;
    for (const pluginId of BUNDLED_PLUGIN_IDS) {
      await this.ensurePlugin(pluginId).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.deps.warn?.(`Bundled plugin ${pluginId} could not be auto-installed: ${message}`);
      });
    }
  }

  private async ensurePlugin(pluginId: string): Promise<void> {
    const resolveDir = this.deps.resolvePluginDir ?? resolveBundledPluginDir;
    const pluginDir = await resolveDir(pluginId);
    if (pluginDir === undefined) return;
    const session = this.deps.getSession();
    if (session === undefined) return;
    const bundledVersion = await readBundledVersion(pluginDir);
    const installed = (await session.listPlugins()).find((plugin) => plugin.id === pluginId);
    if (installed !== undefined && installed.version === bundledVersion) return;
    await session.installPlugin(pluginDir);
  }
}
