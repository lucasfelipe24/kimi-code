import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the directory of an official plugin bundled with the CLI package.
 *
 * The build (`scripts/copy-plugins-assets.mjs`) copies bundled official
 * plugins into `dist-plugins/` next to `dist/`. When running from a repo
 * checkout (dev), the source tree under `plugins/official/` is used instead.
 * Returns `undefined` when no copy is found (e.g. a custom build that left
 * the plugin out) — callers must treat auto-install as best-effort.
 */
export async function resolveBundledPluginDir(pluginId: string): Promise<string | undefined> {
  const sourceDir = import.meta.dirname;
  const candidates = [
    // Bundled into the app: dist-plugins/<id> next to dist/ (this file is
    // bundled into dist/main.mjs by tsdown).
    resolve(sourceDir, '../dist-plugins', pluginId),
    // Built inside a repo checkout: dist/ is three levels below the repo root.
    resolve(sourceDir, '../../../plugins/official', pluginId),
    // Dev without a build: this file lives at src/utils/.
    resolve(sourceDir, '../../../../plugins/official', pluginId),
    // Native (SEA) personal build: the executable stays in the repo at
    // apps/kimi-code/dist-native/bin/<platform>/, five levels below the root.
    resolve(sourceDir, '../../../../../plugins/official', pluginId),
  ];
  for (const dir of candidates) {
    const manifest = await stat(join(dir, 'kimi.plugin.json')).catch(() => undefined);
    if (manifest?.isFile() === true) return dir;
  }
  return undefined;
}
