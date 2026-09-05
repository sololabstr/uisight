/**
 * The extension talks to the panel over HTTP, and nothing type-checks that
 * conversation. It drifted badly once: the extension was still calling `/act`
 * with `{tip}` and reading `d.dusukKontrast`, while the server had moved to
 * `/action` with `{type}` and English keys. Nothing threw — the commands just
 * quietly did nothing, and Inspect reported "no findings" on pages full of them.
 *
 * These tests read both sides and compare them, so the next rename fails here
 * instead of in front of a user.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = readFileSync(join(root, 'extension', 'extension.js'), 'utf8');
const server = readFileSync(join(root, 'src', 'server.mjs'), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'extension', 'package.json'), 'utf8'));

const uniq = (re, s) => [...new Set([...s.matchAll(re)].map((m) => m[1]))];

test('every action the extension sends is one the panel handles', () => {
  const sent = uniq(/act\('([a-z-]+)'/g, ext);
  const handled = uniq(/case '([a-z-]+)':/g, server);
  assert.ok(sent.length, 'the extension must send at least one action');
  const unknown = sent.filter((a) => !handled.includes(a));
  assert.deepEqual(unknown, [], `the panel does not handle: ${unknown.join(', ')}`);
});

test('every route the extension calls is one the panel serves', () => {
  const called = uniq(/request\('(\/[a-z]*)'/g, ext);
  const served = uniq(/u\.pathname === '(\/[a-z]*)'/g, server);
  const unknown = called.filter((r) => !served.includes(r));
  assert.deepEqual(unknown, [], `the panel does not serve: ${unknown.join(', ')}`);
});

test('the extension sends the token, or every command it makes is a 403', () => {
  assert.match(ext, /'x-uisight-token'/, 'POSTs must carry the panel token');
  assert.match(ext, /token-\$\{port\(\)\}/, 'the token is read per port, since a restart mints a new one');
});

test('the result fields the extension renders are fields the engine produces', () => {
  const cli = readFileSync(join(root, 'src', 'cli.mjs'), 'utf8');
  // Only the `d.` reads inside the INSPECT renderer. Scanning the whole file
  // mistakes an unrelated read — `d.sessions` in the panel-discovery code — for
  // a claimed finding field.
  const i0 = ext.indexOf("register('uisight.inspect'");
  const j0 = ext.indexOf("register('uisight.send'", i0);
  const read = uniq(/\bd\.([a-zA-Z]+)\b/g, ext.slice(i0, j0)).filter((k) => k !== 'totals');
  const produced = uniq(/result\.([a-zA-Z]+)(?:\.push|\s*=)/g, cli)
    .concat(uniq(/([a-zA-Z]+): (?:\[\]|0|null)[,\n]/g, cli));
  const missing = read.filter((k) => !produced.includes(k));
  assert.deepEqual(missing, [], `the engine never produces: ${missing.join(', ')}`);
});

test('every command in the manifest is registered, and nothing extra is', () => {
  const declared = manifest.contributes.commands.map((c) => c.command).sort();
  const registered = uniq(/register\('(uisight\.[a-zA-Z]+)'/g, ext).sort();
  assert.deepEqual(registered, declared);
});

test('the webview id the manifest declares is the one the extension provides', () => {
  const id = manifest.contributes.views.uisight[0].id;
  assert.ok(ext.includes(`'${id}'`), `${id} is declared but never provided`);
  assert.deepEqual(manifest.activationEvents, [`onView:${id}`]);
});

const slashes = (s) => s.split(String.fromCharCode(92)).join('/');

test('the default tool path is empty, so a fresh install runs the published package', () => {
  // It used to default to c:/dev/uisight — this machine's checkout, which meant
  // the extension could not work on anyone else's computer. Empty means "use
  // npx uisight@latest", which is both portable and self-updating.
  const p = slashes(manifest.contributes.configuration.properties['uisight.toolPath'].default);
  assert.equal(p, '', 'a machine-specific default makes the extension unpublishable');
  assert.match(ext, /'uisight@latest'/, 'the fallback must pin @latest, or installs freeze');
  assert.doesNotMatch(ext, /mobil-qa/, 'the fork is retired');
});

test('the narrow-mode flag the extension sends is one the panel reads', () => {
  // The extension opens the panel in a ~300px side bar, where the default
  // two-column layout is unreadable. It asked for `?dar=1` for a while after the
  // server had stopped reading any such flag — so the side panel quietly showed
  // the wide layout, which is the thing narrow mode exists to prevent.
  const sent = [...ext.matchAll(/\?([a-z]+)=1/g)].map((m) => m[1]);
  assert.ok(sent.length, 'the extension must ask for narrow mode');
  for (const flag of sent) {
    assert.ok(
      server.includes(`q.has('${flag}')`),
      `the panel never reads ?${flag}=1`,
    );
  }
});

test('narrow mode stacks the two sessions and caps each card at the viewport', () => {
  // The side bar cannot fit two screens side by side, and the first answer to
  // that was to hide the desktop one. That was wrong: "the phone and the
  // desktop together" is what this tool is for, and hiding one takes it away
  // from the place people actually keep an eye on it. What does not fit side
  // by side fits stacked, desktop first.
  assert.doesNotMatch(server, /body\.narrow \.tel\[data-session="web"\] \{ display:none/,
    'the desktop session must not be hidden in the side bar');
  assert.match(server, /body\.narrow \.ekranlar \{ flex-direction:column/, 'stacked, not side by side');
  assert.match(server, /body\.narrow \.tel\[data-session="web"\] \{ order:-1/, 'desktop on top');
  // Capping still matters: a card that sizes itself to its own image overflows
  // the side bar, which is how this looked broken before either fix.
  assert.match(server, /body\.narrow \.tel \{[^}]*max-width:100%/);
});

/**
 * A check nobody displays is a check that does not exist.
 *
 * This has now happened twice. Four UX checks shipped in 0.4.0 were measured on
 * every page and printed in none of them: the CLI report enumerated ten finding
 * types and the engine produced fifteen. Nothing failed — the report was simply
 * shorter than the truth, which is the hardest kind of bug to notice, because a
 * clean report is exactly what you hope to see.
 *
 * So the engine's output is the contract, and every consumer has to cover it.
 */
const FINDING_TYPES = () => {
  const cli = readFileSync(join(root, 'src', 'cli.mjs'), 'utf8');
  const init = cli.match(/const result = \{[\s\S]*?\n  \};/);
  assert.ok(init, 'could not find the result initialiser');
  // Arrays are findings; scalars and the theme baseline are not.
  return [...init[0].matchAll(/([a-zA-Z]+): \[\]/g)]
    .map((m) => m[1])
    .filter((k) => k !== 'themeSignature');
};

test('the CLI report prints every finding type the engine produces', () => {
  const cli = readFileSync(join(root, 'src', 'cli.mjs'), 'utf8');
  const report = cli.slice(cli.indexOf('// --- Report ---'));
  const missing = FINDING_TYPES().filter((k) => !report.includes(`d.${k}`));
  assert.deepEqual(missing, [], `measured but never written to REPORT.md: ${missing.join(', ')}`);
});

test('the extension prints every finding type the engine produces', () => {
  // Yalniz INSPECT gorunumune bak: dosyanin tamaminda `d.` arayan bir kalip,
  // ilgisiz bir yerdeki `d.sessions`i bulgu alani sanip yaniltiyor.
  const i = ext.indexOf("register('uisight.inspect'");
  const j = ext.indexOf("register('uisight.send'", i);
  assert.ok(i > 0 && j > i, 'the inspect renderer must be findable');
  const renderer = ext.slice(i, j);
  const missing = FINDING_TYPES().filter((k) => !renderer.includes(`d.${k}`));
  assert.deepEqual(missing, [], `measured but never shown in the editor: ${missing.join(', ')}`);
});

test('the audit summary counts every finding type, or its totals lie', () => {
  const audit = readFileSync(join(root, 'src', 'audit.mjs'), 'utf8');
  const summary = audit.slice(audit.indexOf('const summarise'), audit.indexOf('const total'));
  const missing = FINDING_TYPES().filter((k) => !summary.includes(`d.${k}`));
  assert.deepEqual(missing, [], `not counted in the audit total: ${missing.join(', ')}`);
});

/**
 * Frame scale. The numbers here are measured, not assumed: the same mobile
 * screen is 461 tokens at full size, 259 at 0.75 (indistinguishable, small print
 * included) and 115 at 0.5 (layout and every meaningful label still read).
 *
 * Cost falls with the SQUARE of the scale, which is why the default moved: 44%
 * off for nothing. These tests pin the contract so a later edit cannot quietly
 * put the default back to 1 — or push it so low the image stops being worth
 * sending at all.
 */
test('the default frame scale saves real money and stays in a sane range', () => {
  const m = server.match(/DEFAULT_FRAME_SCALE\s*=\s*Math\.min\(1,\s*Math\.max\(([\d.]+),[^)]*\)\s*\|\|\s*([\d.]+)\)/);
  assert.ok(m, 'the default scale must be a clamped constant');
  const floor = Number(m[1]);
  const def = Number(m[2]);
  assert.ok(def < 1, 'a default of 1 spends 44% more for no visible gain');
  assert.ok(def >= 0.5, `below 0.5 the small print goes, got ${def}`);
  assert.ok(floor >= 0.2, 'the floor must stop a scale that produces an unusable image');
});

test('scale is clamped, so a bad value cannot produce a useless or giant image', () => {
  assert.match(server, /Math\.min\(1,\s*Math\.max\(0\.25/, 'requests are clamped to 0.25-1');
});

test('the scaled capture falls back instead of failing when CDP is absent', () => {
  const fn = server.slice(server.indexOf('async function captureScaled'));
  assert.match(fn.slice(0, 600), /if \(!o\.cdp\) return null/, 'no CDP means fall back, not throw');
  assert.match(fn.slice(0, 900), /catch \{\s*\n?\s*return null/, 'a capture error must fall back too');
});

test('see_screen exposes scale, and says what it buys', () => {
  const mcp = readFileSync(join(root, 'src', 'mcp.mjs'), 'utf8');
  const block = mcp.slice(mcp.indexOf("tool('see_screen'"), mcp.indexOf("tool('inspect'"));
  assert.match(block, /scale: z\.number\(\)/, 'the agent needs the lever');
  assert.match(block, /quarter the price/, 'and needs to know what it costs');
});

/**
 * Port derivation lives in two files and has to agree in both.
 *
 * It exists because a fixed 5055 made four projects share one panel: an agent
 * auditing Lexa could measure Kokart's page, and a `goto` from one yanked
 * everyone else's panel to its own address. Nothing failed — it just answered
 * about the wrong app.
 *
 * If the extension and the MCP ever compute different ports, the side panel
 * shows a different application than the one the agent is measuring. That is
 * the same silent-wrong-answer failure wearing a different hat, so the two
 * implementations are compared here rather than trusted.
 */
const derive = (src, folder) => {
  let h = 2166136261;
  for (const c of folder.toLowerCase()) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  const blocked = new Set(
    [...src.matchAll(/BLOCKED_PORTS = new Set\(\[([^\]]+)\]/g)]
      .flatMap((m) => m[1].split(',').map((n) => Number(n.trim())))
      .filter(Boolean),
  );
  for (let i = 0; i < 120; i++) {
    const p = 5055 + ((Math.abs(h) + i) % 120);
    if (!blocked.has(p)) return p;
  }
  return 5055;
};

test('the extension and the MCP derive the same port for the same folder', () => {
  const mcp = readFileSync(join(root, 'src', 'mcp.mjs'), 'utf8');
  assert.match(mcp, /2166136261/, 'the MCP must derive a per-project port');
  assert.match(ext, /2166136261/, 'and the extension must use the same hash');

  // Same constants on both sides: base, span, and the blocked set.
  for (const src of [mcp, ext]) {
    assert.match(src, /5055 \+ \(\(Math\.abs\(h\) \+ i\) % 120\)/, 'same base and span');
    assert.match(src, /5060, 5061/, 'both must skip the ports the URL spec blocks');
  }

  // And they land on the same number for real folders.
  for (const folder of ['c:/dev/lexa-dashboard', 'c:/dev/kokart', '/home/x/noben']) {
    assert.equal(derive(ext, folder), derive(readFileSync(join(root, 'src', 'mcp.mjs'), 'utf8'), folder));
  }
});

test('different projects get different ports, and the same project keeps its own', () => {
  const seen = new Map();
  for (const f of ['c:/dev/lexa-dashboard', 'c:/dev/kokart', 'c:/dev/fiko', 'c:/dev/noben', 'c:/dev/uisight']) {
    const p = derive(ext, f);
    assert.ok(!seen.has(p), `${f} collides with ${seen.get(p)} on ${p}`);
    seen.set(p, f);
    assert.equal(derive(ext, f), p, 'the same folder must always get the same port');
  }
});

test('the MCP refuses a panel that is serving a different app', () => {
  const mcp = readFileSync(join(root, 'src', 'mcp.mjs'), 'utf8');
  assert.match(mcp, /panelMatchesTarget/, 'attaching blindly measures the wrong application');
  assert.match(mcp, /serving a different app/, 'and it has to say so out loud');
});

/**
 * Frame freshness.
 *
 * The panel keeps the last screencast frame because reusing it is free. But
 * Chromium only sends frames when something repaints, so on a page that has
 * settled the cached frame simply ages — measured at 25 seconds on an idle page.
 * If the view changed without a frame arriving (a scroll whose repaint landed
 * before the scroll finished, say), `see_screen` hands the model an old picture
 * while `inspect` reads the live DOM. The two disagree, and the disagreement
 * reads as "the layout broke". That was reported from the field.
 *
 * A fresh capture costs 35ms, so the age decides: fast path while the screencast
 * keeps up, fresh capture when it does not.
 */
test('a stale cached frame is replaced rather than served', () => {
  assert.match(server, /lastFrameAt/, 'the frame must carry a timestamp');
  assert.match(server, /yas < 250/, 'and a freshness threshold that rejects an old one');
  assert.match(server, /x-frame-age/, 'and the age must be visible for debugging');
});

test('the freshness threshold is short enough to matter and long enough to be useful', () => {
  const m = server.match(/yas < (\d+)/);
  assert.ok(m, 'threshold must be a literal');
  const ms = Number(m[1]);
  assert.ok(ms >= 100, `below ~100ms every call re-captures for nothing, got ${ms}`);
  assert.ok(ms <= 500, `above ~500ms a changed view can still be served stale, got ${ms}`);
});

/**
 * The switcher bar is the one piece of UI the extension itself draws, so it is
 * the one piece uisight cannot audit for us. These run it for real.
 */
const gomuluHtml = (() => {
  const i = ext.indexOf('function gomuluHtml');
  const j = ext.indexOf('\nconst bilgiHtml', i);
  return new Function('return ' + ext.slice(i, j).replace('function gomuluHtml', 'function'))();
})();

const PANELLER = [
  { port: 5062, url: 'https://kokart.app/ara' },
  { port: 5109, url: 'https://fiko.sololabs.tr/transactions/723/edit' },
];

test('the switcher appears only when there is something to switch between', () => {
  assert.ok(!gomuluHtml(5062, true, [PANELLER[0]]).includes('id="sec"'), 'one panel needs no chooser');
  assert.ok(!gomuluHtml(5062, true, []).includes('id="sec"'), 'no discovery, no chooser');
  assert.ok(gomuluHtml(5062, true, PANELLER).includes('id="sec"'), 'two panels need a chooser');
});

test('every panel you can pick is a frame the CSP will actually load', () => {
  // Listing only the current port passed review once and still broke: picking
  // the other panel swapped the iframe src to a blocked origin, and the user
  // got a blank rectangle with the reason buried in the webview console.
  const html = gomuluHtml(5062, false, PANELLER);
  const frameSrc = /frame-src ([^;]+);/.exec(html)?.[1] || '';
  for (const p of PANELLER) {
    assert.ok(frameSrc.includes(`localhost:${p.port}`), `port ${p.port} is offered but not allowed`);
  }
  assert.ok(html.includes(`value="5062" selected`), 'the port in use must be the one shown');
});

test('the bar takes its colours from the editor, not from a palette we picked', () => {
  // A hardcoded dark bar sits as a slab above the panel in a light theme —
  // exactly the class of defect this tool exists to catch.
  const css = /<style>([\s\S]*?)<\/style>/.exec(gomuluHtml(5062, true, PANELLER))[1];
  const kurallar = css.split('}').filter((r) => r.includes('.sw'));
  assert.ok(kurallar.length >= 3, 'the switcher rules must be present to be checked');
  for (const kural of kurallar) {
    for (const [, dekl] of kural.matchAll(/(?:^|;)\s*((?:background|color|border-color)\s*:[^;]+)/g)) {
      assert.ok(dekl.includes('var(--vscode-'), `nailed-down colour: ${dekl.trim()}`);
    }
  }
});

test('the switcher does not reuse a glyph the panel already binds to something else', () => {
  // The rescan button was ⟳, sitting a few pixels above the panel's own ⟳,
  // which reloads the page. Two identical controls, different actions — the
  // exact thing this tool flags on other people's UIs. Pressing "rescan"
  // reloaded the site instead, and the report from the user was simply that
  // the button "reopens noben".
  const panelGlifleri = new Set(
    [...server.matchAll(/<button onclick="act\([^"]*\)">([^<]{1,3})<\/button>/g)].map((m) => m[1].trim()),
  );
  assert.ok(panelGlifleri.size >= 3, `expected the panel toolbar glyphs, found ${[...panelGlifleri]}`);
  const cubuk = /<div class="sw">([\s\S]*?)<\/div>/.exec(ext)?.[1] || '';
  assert.ok(cubuk, 'the switcher bar markup must be findable');
  for (const g of panelGlifleri) {
    assert.ok(!cubuk.includes(`>${g}<`), `the switcher reuses the panel's "${g}"`);
  }
});
