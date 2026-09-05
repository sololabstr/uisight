/**
 * `uisight-mcp`, `uisight-panel` and `uisight-audit` are bin names inside the
 * `uisight` package — they are not packages. `npx -y uisight-mcp` therefore
 * fails with E404, and the README told every new user to run exactly that as
 * the way to register the MCP server.
 *
 * It is also a supply-chain trap: the docs point at a name nobody owns, so
 * whoever publishes it runs code on the machine of anyone following them.
 *
 * This reads the commands out of the docs and checks each one names a package
 * that actually exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const BINS = Object.keys(pkg.bin);          // uisight, uisight-panel, uisight-mcp, uisight-audit
const PAKET = pkg.name;                      // the only one npm can resolve
const ALT_BINLER = BINS.filter((b) => b !== PAKET);

const DOSYALAR = ['README.md', 'README.tr.md', 'smithery.yaml', 'src/mcp.mjs', 'extension/README.md'];

test('no doc tells anyone to npx a package that does not exist', () => {
  for (const d of DOSYALAR) {
    const metin = readFileSync(join(root, d), 'utf8');
    for (const [, satir] of metin.matchAll(/(npx [^\n`"]*)/g)) {
      const parcalar = satir.trim().split(/\s+/).slice(1);
      // Which token is the package? The first one that is not a flag or a
      // flag's value; `-p <name>` names it outright.
      const p = parcalar.indexOf('-p') >= 0 ? parcalar[parcalar.indexOf('-p') + 1]
              : parcalar.find((x) => !x.startsWith('-'));
      if (!p) continue;
      const ad = p.replace(/@[^@/]*$/, '');   // uisight@latest -> uisight
      assert.ok(
        !ALT_BINLER.includes(ad),
        `${d}: "${satir.trim()}" names the bin ${ad}, which is not a package — use "npx -y -p ${PAKET} ${ad}"`,
      );
    }
  }
});

test('the Smithery listing starts the server the same way the docs do', () => {
  const y = readFileSync(join(root, 'smithery.yaml'), 'utf8');
  const args = /args:\s*\[([^\]]+)\]/.exec(y)?.[1] || '';
  const parcalar = args.split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  // A tag is allowed and wanted here: npx caches, so a long-lived start command
  // written without one keeps running whatever uisight was current the first
  // time it ran.
  const p = (parcalar[parcalar.indexOf('-p') + 1] || '').replace(/@[^@/]*$/, '');
  assert.equal(p, PAKET, `Smithery would run "npx ${parcalar.join(' ')}" — that package does not exist`);
});

/**
 * Every bin should answer --help. Three of the four did not: they ignored the
 * flag and went ahead. `uisight-audit --help` started a real sign-in against
 * whatever panel was on 5055, and `uisight-panel --help` launched a browser.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const calistir = promisify(execFile);

for (const [ad, dosya] of Object.entries(pkg.bin)) {
  test(`${ad} --help explains itself instead of running`, async () => {
    const { stdout } = await calistir(process.execPath, [join(root, dosya), '--help'], { timeout: 25000 });
    assert.ok(stdout.trimStart().startsWith(ad), `${ad} --help must start by naming itself, got: ${JSON.stringify(stdout.slice(0, 40))}`);
    assert.ok(stdout.length > 80, `${ad} --help printed almost nothing`);
  });
}

test('a flag this command does not know is refused, not dropped', async () => {
  // `--desktop desktop` is a real flag — of uisight-panel. The CLI took it,
  // said nothing, and produced two phone profiles and a report that never
  // mentioned the desktop one was missing.
  const CLI = join(root, 'src', 'cli.mjs');
  let hata = null;
  try {
    await calistir(process.execPath, [CLI, 'https://example.com', '--desktop', 'desktop'], { timeout: 25000 });
  } catch (e) { hata = e; }
  assert.ok(hata, 'it must not proceed');
  assert.equal(hata.code, 2);
  assert.match(hata.stderr, /unknown option: --desktop/);
  assert.match(hata.stderr, /belongs to uisight-panel/, 'say where the flag does live');
});
