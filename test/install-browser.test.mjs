/**
 * The one property that matters here is negative: this must never ask a
 * question, and never start a 150 MB download, where there is nobody to answer.
 * The panel and the MCP server are normally launched by an editor or an agent
 * host with no terminal attached — a prompt there is indistinguishable from a
 * hang, and a download there is somebody's CI bill.
 *
 * The one exception is a download agreed to in advance: an MCPB bundle's
 * install screen asks once and passes the answer in as UISIGHT_AUTO_INSTALL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canAsk, autoInstall, missingEngines, installCommand, offerInstall } from '../src/install-browser.mjs';

const TTY = { isTTY: true };
const DUZ = { isTTY: false };

test('it only offers where there is someone to answer', () => {
  assert.equal(canAsk({}, TTY, TTY), true, 'a real terminal');
  assert.equal(canAsk({}, DUZ, TTY), false, 'no stdin to read a yes from');
  assert.equal(canAsk({}, TTY, DUZ), false, 'output is being piped somewhere');
  assert.equal(canAsk({ CI: 'true' }, TTY, TTY), false, 'nobody asked for this in a build');
  assert.equal(canAsk({ UISIGHT_NO_INSTALL: '1' }, TTY, TTY), false, 'an explicit no stays no');
});

test('what is missing is decided by what is on disk', () => {
  const sahte = (yollar) => Object.fromEntries(
    Object.entries(yollar).map(([ad, p]) => [ad, { executablePath: () => p }]),
  );
  // A path that cannot exist stands in for a browser that was never downloaded.
  const yok = 'C:/uisight-test/definitely-not-here/chrome.exe';
  assert.deepEqual(missingEngines(['chromium'], sahte({ chromium: yok })), ['chromium']);
  assert.deepEqual(missingEngines(['chromium'], sahte({ chromium: process.execPath })), []);
  // An engine Playwright will not even name is missing, not a crash.
  assert.deepEqual(missingEngines(['webkit'], {}), ['webkit']);
});

test('nothing is asked and nothing is fetched when the browser is already there', async () => {
  let soruldu = false;
  const sonuc = await offerInstall(['chromium'], { chromium: { executablePath: () => process.execPath } },
    { ask: async () => { soruldu = true; return true; } });
  assert.equal(sonuc, true);
  assert.equal(soruldu, false, 'it must not ask about a browser that is present');
});

test('a missing browser in a non-interactive session is reported, not downloaded', async () => {
  // canAsk() reads the real process here, and the test runner has no TTY —
  // which is exactly the shape of an MCP host and of CI.
  let soruldu = false;
  let indirildi = false;
  const sonuc = await offerInstall(['chromium'], { chromium: { executablePath: () => 'C:/uisight-test/nope.exe' } },
    { ask: async () => { soruldu = true; return true; }, auto: false, run: async () => { indirildi = true; return 0; } });
  assert.equal(sonuc, false, 'the caller must fall back to explaining');
  assert.equal(soruldu, false, 'a prompt here is a hang');
  assert.equal(indirildi, false, 'and without an advance yes, nothing is fetched');
});

test('the install command is resolved from the installed Playwright, not guessed', () => {
  const k = installCommand(['chromium']);
  assert.equal(k.cmd, process.execPath);
  assert.match(k.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual(k.args.slice(1), ['install', 'chromium']);
  assert.match(k.args[0], /playwright/, 'it must point inside the playwright package');
});

test('only an explicit advance yes counts, and CI or an explicit no still win', () => {
  for (const evet of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(autoInstall({ UISIGHT_AUTO_INSTALL: evet }), true, `${evet} is a yes`);
  }
  for (const hayir of ['', '0', 'false', 'no', 'off']) {
    assert.equal(autoInstall({ UISIGHT_AUTO_INSTALL: hayir }), false, `"${hayir}" is not a yes`);
  }
  assert.equal(autoInstall({}), false, 'unset is not a yes');
  // A host that did not fill the template passes the placeholder through.
  assert.equal(autoInstall({ UISIGHT_AUTO_INSTALL: '${user_config.auto_install_browser}' }), false,
    'an unfilled template is not a yes');
  assert.equal(autoInstall({ UISIGHT_AUTO_INSTALL: 'true', CI: 'true' }), false, 'a build never downloads');
  assert.equal(autoInstall({ UISIGHT_AUTO_INSTALL: 'true', UISIGHT_NO_INSTALL: '1' }), false, 'an explicit no wins');
});

test('with an advance yes and no terminal, it downloads without asking and says it started', async () => {
  let var_ = false;
  let soruldu = false;
  let baslayan = null;
  let komut = null;
  let stdio = null;
  const sonuc = await offerInstall(
    ['chromium'],
    { chromium: { executablePath: () => (var_ ? process.execPath : 'C:/uisight-test/nope.exe') } },
    {
      auto: true,
      ask: async () => { soruldu = true; return true; },
      onStart: (e, boyut) => { baslayan = e; assert.equal(boyut, 'about 700 MB on disk', 'the size shown is the measured one'); },
      run: async (k, s) => { komut = k; stdio = s; var_ = true; return 0; },
    },
  );
  assert.equal(sonuc, true, 'the browser is there afterwards');
  assert.equal(soruldu, false, 'there is still nobody to ask');
  assert.deepEqual(baslayan, ['chromium'], 'the caller is told what is being fetched, before the wait');
  assert.deepEqual(komut.args.slice(1), ['install', 'chromium'], 'the bundled Playwright fetches its own revision');
  assert.equal(stdio, 'ignore', 'no terminal to inherit, so nothing is written where JSON-RPC runs');
});

test('a download that fails is reported as missing, not as present', async () => {
  const sonuc = await offerInstall(['chromium'], { chromium: { executablePath: () => 'C:/uisight-test/nope.exe' } },
    { auto: true, run: async () => 1 });
  assert.equal(sonuc, false);
});
