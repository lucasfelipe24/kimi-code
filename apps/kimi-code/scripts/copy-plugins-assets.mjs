import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(appRoot, '../..');
const pluginsRoot = resolve(repoRoot, 'plugins/official');
const target = resolve(appRoot, 'dist-plugins');

// Official plugins bundled into the CLI package. They are auto-installed from
// this local copy at startup — no marketplace download required.
const BUNDLED_PLUGINS = ['kimi-documents'];

async function assertPlugin(id) {
  const dir = resolve(pluginsRoot, id);
  const manifest = await stat(resolve(dir, 'kimi.plugin.json')).catch(() => undefined);
  if (manifest?.isFile() !== true) {
    throw new Error(`Official plugin "${id}" not found at ${dir} (missing kimi.plugin.json).`);
  }
  return dir;
}

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

for (const id of BUNDLED_PLUGINS) {
  const src = await assertPlugin(id);
  await cp(src, resolve(target, id), { recursive: true });
  console.log(`Copied official plugin ${id} to dist-plugins/${id}`);
}
