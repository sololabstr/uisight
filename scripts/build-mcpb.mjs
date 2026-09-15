#!/usr/bin/env node
/**
 * Builds dist/uisight-<version>.mcpb: the MCP server as a one-click bundle for
 * Claude Desktop (MCPB, https://github.com/modelcontextprotocol/mcpb).
 *
 * A bundle carries its own node_modules, so they are installed fresh into a
 * staging folder from the published version ranges. They are never copied from
 * a dev checkout, which may hold dev tools, a junction, or another platform's
 * binaries. Browsers are NOT bundled (Chromium is ~700 MB on disk): the install screen asks whether
 * to fetch one on first use (UISIGHT_AUTO_INSTALL).
 *
 *   node scripts/build-mcpb.mjs          build
 *   node scripts/build-mcpb.mjs --keep   keep the staging folder to inspect it
 */
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Pinned: `pack` validates the manifest against this CLI's own schema.
const MCPB_CLI = '@anthropic-ai/mcpb@2.1.2';

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'mcpb', 'manifest.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`  mcpb/manifest.json says ${manifest.version} but package.json says ${pkg.version}`);
  process.exit(1);
}

const DIST = join(ROOT, 'dist');
const STAGE = join(DIST, 'mcpb-stage');
const OUT = join(DIST, `uisight-${pkg.version}.mcpb`);

function run(cmd, args, cwd) {
  // npm and npx are .cmd shims on Windows, which Node refuses to spawn without a
  // shell. With a shell, pass one command line: handing it an args array is
  // deprecated (DEP0190), because the array is concatenated, not escaped. The
  // arguments here are fixed flags and paths this script built itself.
  const r = process.platform === 'win32'
    ? spawnSync([cmd, ...args].join(' '), { cwd, stdio: 'inherit', shell: true })
    : spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`  failed (${r.status}): ${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
}

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
cpSync(join(ROOT, 'src'), join(STAGE, 'src'), { recursive: true });
for (const f of ['LICENSE', 'README.md']) cpSync(join(ROOT, f), join(STAGE, f));
cpSync(join(ROOT, 'extension', 'media', 'icon.png'), join(STAGE, 'icon.png'));
writeFileSync(join(STAGE, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// Only what the runtime needs: no scripts to run, no devDependencies to fetch.
const { name, version, type, license, engines, dependencies } = pkg;
writeFileSync(join(STAGE, 'package.json'), `${JSON.stringify({ name, version, type, license, engines, dependencies }, null, 2)}\n`);

run('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], STAGE);
rmSync(OUT, { force: true });
run('npx', ['-y', MCPB_CLI, 'pack', STAGE, OUT], ROOT);

console.log(`\n  ${OUT}  (${(statSync(OUT).size / 1048576).toFixed(1)} MB)`);
if (!process.argv.includes('--keep')) rmSync(STAGE, { recursive: true, force: true });
