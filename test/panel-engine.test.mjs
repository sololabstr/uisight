/**
 * A profile runs on the engine it declares.
 *
 * `PROFILES` gives every profile an `engine`, and cli.mjs honours it: the
 * iPhone and iPad profiles open webkit, the real iOS Safari engine. The panel
 * read the same table but only its `pw` field, and called `chromium.launch()`
 * unconditionally -- so a live `iphone-15` session was a Chromium window at an
 * iPhone's size, labelled "iPhone 15 Pro — iOS Safari engine".
 *
 * Nothing it showed was false. It simply could not show an iOS-specific bug,
 * while every label said it was looking at one. A tool that reports "clean" on
 * a screen it never rendered is worse than one that reports nothing, so the
 * engine now travels all the way out: /state, the /frame headers, and the MCP
 * captions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const server = strip(readFileSync(join(root, 'src', 'server.mjs'), 'utf8'));
const mcp = strip(readFileSync(join(root, 'src', 'mcp.mjs'), 'utf8'));
const { PROFILES } = await import(join(root, 'src', 'cli.mjs'));

test('the table the panel reads still declares two engines', () => {
  // If this ever collapses to one, the rest of this file is dead weight.
  const engines = new Set(Object.values(PROFILES).map((p) => p.engine));
  assert.deepEqual([...engines].sort(), ['chromium', 'webkit']);
  assert.equal(PROFILES['iphone-15'].engine, 'webkit');
  assert.equal(PROFILES['pixel'].engine, 'chromium');
});

test('the panel reads the engine instead of assuming chromium', () => {
  assert.match(server, /profile\.engine/, 'the declared engine has to be read');
  assert.ok(!/=\s*await\s+chromium\.launch\(\)/.test(server), 'launching chromium unconditionally ignores the table');
  assert.match(server, /ENGINES\s*=\s*\{\s*chromium,\s*webkit\s*\}/, 'both engines have to be reachable');
});

test('a fallback to chromium is never silent', () => {
  assert.match(server, /engineFellBack/, '/state has to say the engine is not the one asked for');
  assert.match(mcp, /engineFellBack/, 'and the MCP captions have to repeat it');
  assert.match(mcp, /x-engine/, 'see_screen has to name the engine it actually looked at');
});

test('CDP is only attempted where it exists', () => {
  // newCDPSession throws on webkit; three attempts and 2.4s of sleeps for a
  // screencast that was never possible, plus three alarming log lines.
  assert.match(server, /hasCdp/, 'the engine decides whether a screencast is even attempted');
});

test('the frame loop cannot stack work on itself', () => {
  // setInterval with an async body queues the next frame whether or not the
  // last one finished. One fixed rate is wrong for both engines anyway:
  // the same screenshot is 3ms on webkit and 33ms on chromium.
  assert.ok(!/setInterval\(/.test(server), 'an async body on setInterval compounds under load');
  assert.match(server, /setTimeout\(tick/, 'the next frame is scheduled only after the previous one lands');
});

test('a closing session retires the frame already in flight', () => {
  // clearTimeout only cancels a frame that has not started yet -- that is
  // enough for setInterval, which is cleared outright, but not for a
  // self-rescheduling tick. One that was mid-screenshot when the session
  // closed comes back, finds its own state still there, and schedules the
  // next: a loop over a closed page with nothing left to stop it.
  const body = (name) => {
    const m = server.match(new RegExp(`function ${name}\\(([\\s\\S]*?)\\n\\}`));
    assert.ok(m, `${name} has to exist to be checked`);
    return m[0];
  };
  assert.match(body('closeSession'), /o\.streamGen\s*=/, 'closing has to retire the running loop');
  const loop = body('frameLoop');
  assert.match(loop, /o\.streamGen === gen/, 'a tick has to know whether it is still the current one');
  assert.match(loop, /const live = \(\) =>/, 'the liveness of a tick has to be expressible');
  assert.equal((loop.match(/!live\(\)/g) || []).length, 2,
    'checked before the screenshot and again after it -- the second is the one that matters');
});
