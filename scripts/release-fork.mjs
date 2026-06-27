/**
 * Build + package native binary for GitHub Release (lucasfelipe24 fork).
 *
 * Steps:
 *   1. Build kimi-web (for web assets)
 *   2. Build native SEA binary
 *   3. Package to zip + sha256
 *   4. Generate CDN metadata (cdn/latest, cdn/latest.json)
 *   5. Print release instructions
 *
 * Usage:
 *   node scripts/release-fork.mjs [version]
 *
 * If version is omitted, reads from apps/kimi-code/package.json.
 */

import { execSync } from 'node:child_process';
import { createHash, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, ren, stat, writeFile, cp } from 'node:fs/promises';
import { basename, resolve, join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { ZipFile } from 'yazl';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const appDir = resolve(rootDir, 'apps/kimi-code');
const distDir = resolve(rootDir, 'dist-release');

// URLs used in release instructions
const GITHUB_RELEASES_BASE = 'https://github.com/lucasfelipe24/kimi-code/releases/latest/download';
const KIMI_CODE_CDN_LATEST_URL = 'https://raw.githubusercontent.com/lucasfelipe24/kimi-code/refs/heads/main/cdn/latest';
const KIMI_CODE_CDN_LATEST_JSON_URL = 'https://raw.githubusercontent.com/lucasfelipe24/kimi-code/refs/heads/main/cdn/latest.json';

// ── Helpers ─────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  console.log(`  → ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: rootDir, ...opts });
}

function runSilent(cmd) {
  return execSync(cmd, { encoding: 'utf-8', cwd: rootDir }).trim();
}

async function sha256File(path) {
  return await new Promise((resolveHash, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}

// ── Platform targets ────────────────────────────────────────────────────

function currentTarget() {
  const platform = process.platform;
  const arch = { x64: 'x64', arm64: 'arm64' }[process.arch] ?? process.arch;
  return `${platform}-${arch}`;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const pkgJson = JSON.parse(
    await readFile(resolve(appDir, 'package.json'), 'utf-8'),
  );
  const version = process.argv[2] ?? pkgJson.version;
  const tag = `v${version}`;
  const target = currentTarget();

  console.log(`Building kimi-code v${version} for ${target}`);
  console.log('');

  // Step 1: Build kimi-web (needed for web assets in native build)
  console.log('[1/4] Building kimi-web...');
  run('pnpm --filter @moonshot-ai/kimi-web build');

  // Step 2: Build native SEA binary
  console.log('[2/4] Building native SEA binary...');
  run('pnpm --filter @moonshot-ai/kimi-code run build:native:sea');

  // Step 3: Package (zip + sha256)
  console.log('[3/4] Packaging...');
  await mkdir(distDir, { recursive: true });

  const nativeArtifactsDir = resolve(appDir, 'dist-native/artifacts');
  let zipFile;

  // Find the zip file produced by build:native:sea → package:native
  // If package:native was already run, use that. Otherwise build the zip ourselves.
  try {
    const files = await readdir(nativeArtifactsDir);
    zipFile = files.find((f) => f.endsWith('.zip') && !f.endsWith('.sha256'));
  } catch {
    // Fallback: run package
    run('pnpm --filter @moonshot-ai/kimi-code run package:native');
    const files = await readdir(nativeArtifactsDir);
    zipFile = files.find((f) => f.endsWith('.zip') && !f.endsWith('.sha256'));
  }

  if (!zipFile) {
    console.error('No zip found. Build may have failed.');
    process.exit(1);
  }

  const zipPath = resolve(nativeArtifactsDir, zipFile);
  const destZip = resolve(distDir, zipFile);
  const destChecksum = resolve(distDir, `${zipFile}.sha256`);

  await cp(zipPath, destZip);
  const digest = await sha256File(destZip);
  const checksumContent = `${digest}  ${zipFile}\n`;
  await writeFile(destChecksum, checksumContent);

  console.log(`  Zip: ${destZip}`);
  console.log(`  SHA256: ${digest}`);

  // Step 4: Generate manifest.json for multi-platform releases (optional for single)
  const manifest = {
    version,
    tag,
    platforms: {
      [target]: {
        filename: zipFile,
        checksum: digest,
      },
    },
  };

  // Also copy native binary itself for convenience
  const nativeBinPath = (() => {
    const ext = process.platform === 'win32' ? '.exe' : '';
    return resolve(appDir, `dist-native/kimi-code-${target}${ext}`);
  })();

  try {
    await stat(nativeBinPath);
    await cp(nativeBinPath, resolve(distDir, `kimi-code-${target}${process.platform === 'win32' ? '.exe' : ''}`));
  } catch {
    // Binary may be in a different location; that's OK
  }

  console.log(`[4/5] Generating CDN metadata...`);
  // Generate cdn/latest and cdn/latest.json
  const cdnDir = resolve(rootDir, 'cdn');
  await mkdir(cdnDir, { recursive: true });
  await writeFile(resolve(cdnDir, 'latest'), `${version}\n`);
  await writeFile(resolve(cdnDir, 'latest.json'), `${JSON.stringify({ version, publishedAt: new Date().toISOString(), rollout: [] }, null, 2)}\n`);
  console.log(`  cdn/latest → ${version}`);
  console.log(`  cdn/latest.json written`);

  console.log(`[5/5] Done!`);

  // ── Release instructions ───────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  GitHub Release Instructions');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('');
  console.log(`  1. Commit and push the updated CDN files:`);
  console.log(`     git add cdn/latest cdn/latest.json && git commit -m "cdn: bump to v${version}" && git push`);
  console.log('');
  console.log(`  2. Create a new release at:`);
  console.log(`     https://github.com/lucasfelipe24/kimi-code/releases/new`);
  console.log(`     Tag: ${tag}`);
  console.log(`     Title: v${version}`);
  console.log('');
  console.log(`  3. Upload these files to the release:`);
  console.log(`     - dist-release/${zipFile}`);
  console.log(`     - dist-release/${zipFile}.sha256`);
  console.log(`     - install.sh`);
  console.log(`     - install.ps1`);
  console.log('');
  console.log(`  4. Publish the release.`);
  console.log('');
  console.log(`  Install commands:`);
  console.log(`    macOS/Linux:  curl -fsSL ${GITHUB_RELEASES_BASE}/install.sh | bash`);
  console.log(`    Windows:      irm ${GITHUB_RELEASES_BASE}/install.ps1 | iex`);
  console.log('');
  console.log(`  CDN endpoints (served via raw.githubusercontent.com):`);
  console.log(`    Latest version:  ${KIMI_CODE_CDN_LATEST_URL}`);
  console.log(`    Update manifest: ${KIMI_CODE_CDN_LATEST_JSON_URL}`);
  console.log('═══════════════════════════════════════════════════════════════');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
