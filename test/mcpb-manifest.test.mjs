/**
 * The MCPB bundle's manifest describes code that lives elsewhere, and nothing
 * keeps two descriptions of one thing in step except a test.
 *
 * Claude Desktop reads the manifest, not the code: the tool list it shows, the
 * settings it asks for and the environment it passes all come from this file.
 * A tool renamed in mcp.mjs, a setting nobody reads, or a version that lags the
 * package would each ship quietly, because the bundle still installs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const src = (p) => strip(readFileSync(join(root, 'src', p), 'utf8'));

const manifest = json('mcpb/manifest.json');
const mcp = src('mcp.mjs');
const server = src('server.mjs');

test('one version everywhere a registry or installer reads it', () => {
  const pkg = json('package.json');
  const reg = json('server.json');
  assert.equal(manifest.version, pkg.version, 'the bundle has to carry the package version');
  assert.equal(reg.version, pkg.version);
  assert.equal(reg.packages[0].version, pkg.version);
});

test('the manifest lists exactly the tools the server registers', () => {
  const registered = [...mcp.matchAll(/^tool\('([a-z_]+)'/gm)].map((m) => m[1]).sort();
  assert.ok(registered.length >= 9, `expected the full tool set in mcp.mjs, found ${registered.length}`);
  assert.deepEqual(manifest.tools.map((t) => t.name).sort(), registered,
    'a tool renamed or added in mcp.mjs has to be renamed or added here too');
  for (const t of manifest.tools) assert.ok(t.description?.length > 10, `${t.name} needs a description`);
});

test('the server entry point exists and is what the host runs', () => {
  assert.equal(manifest.server.type, 'node');
  assert.ok(existsSync(join(root, manifest.server.entry_point)), 'entry_point has to exist in the repo');
  assert.deepEqual(manifest.server.mcp_config.args, [`\${__dirname}/${manifest.server.entry_point}`]);
  assert.ok(existsSync(join(root, 'extension', 'media', 'icon.png')), 'the build copies this icon');
});

test('every setting the install screen asks for is passed on and actually read', () => {
  const env = manifest.server.mcp_config.env;
  const used = new Set();
  for (const [name, value] of Object.entries(env)) {
    const m = value.match(/^\$\{user_config\.([a-z_]+)\}$/);
    assert.ok(m, `${name} should come straight from one setting`);
    assert.ok(manifest.user_config[m[1]], `${name} refers to a setting that does not exist`);
    used.add(m[1]);
    const readers = ['mcp.mjs', 'server.mjs', 'install-browser.mjs'].map(src).join('\n');
    assert.ok(readers.includes(name), `${name} is passed in but nothing reads it`);
  }
  assert.deepEqual([...used].sort(), Object.keys(manifest.user_config).sort(), 'a setting nobody passes on is a dead question');
});

test('the defaults are values the code accepts', () => {
  const { tools, url, auto_install_browser: auto } = manifest.user_config;
  assert.match(mcp, /raw === 'all'/, `the tool-set default "${tools.default}" has to mean every tool`);
  assert.equal(tools.default, 'all');
  assert.doesNotThrow(() => new URL(url.default));
  assert.equal(auto.type, 'boolean');
  assert.equal(auto.default, true, 'a one-click install that fails on first use is not one click');
  assert.match(auto.description, /700 MB on disk/, 'the measured size of what it downloads has to be stated where it is agreed to');
});

test('a first-run download is visible to the MCP client, not a 30-second timeout', () => {
  assert.match(server, /installing: state\.installing/, '/state has to say a download is under way');
  assert.match(server, /onStart:/, 'and the panel has to set it when the download starts');
  assert.match(mcp, /d\?\.installing/, 'ensureEngine has to read it');
  const ensure = mcp.match(/async function ensureEngine\(\)[\s\S]*?\n\}/);
  assert.ok(ensure, 'ensureEngine has to exist to be checked');
  assert.equal((ensure[0].match(/notReadyBecause\(d\)/g) || []).length, 2,
    'checked on the first look and inside the wait -- the download starts after the panel is already up');
});
