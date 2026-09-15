/**
 * WebKit is offered where it will be used, and missing it is not an alarm.
 *
 * Once the panel honours each profile's engine, an iPhone profile needs WebKit.
 * The panel used to offer only a constant `['chromium']` at startup, so almost
 * nobody would have WebKit, and every `see_screen` on an iPhone profile would
 * carry a WARNING -- repeated on every frame, in text that is re-sent on every
 * later turn.
 *
 * So, as the CLI already does for its devices: offer the engines of the
 * profiles being opened. And tell apart the two ways of ending up on chromium.
 * Never downloaded is ordinary and is said once, with the fix. Downloaded but
 * refusing to launch is a real failure and stays loud. Either way nothing may
 * claim the iOS Safari engine while chromium renders.
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

const body = (src, name) => {
  const m = src.match(new RegExp(`function ${name}\\(([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `${name} has to exist to be checked`);
  return m[0];
};

test('startup offers the engines of the profiles it opens, not a constant', () => {
  const call = server.match(/await offerInstall\(([^;]*)\);/);
  assert.ok(call, 'the panel still offers a download at startup');
  assert.ok(!/\[\s*'chromium'\s*\]/.test(call[1]), 'a constant list never offers webkit to someone opening an iPhone');
  assert.match(server, /PROFILES\[[^\]]+\]\?\.engine/, 'the engines have to come from the profiles');
  assert.match(call[1], /webkit/, 'and webkit has to be reachable by the offer');
});

test('never downloaded and would not launch are told apart', () => {
  const open = body(server, 'openSession');
  assert.match(open, /missingEngines\(\[wantEngine\]/, 'whether the engine is on disk is checked before launching it');
  assert.match(open, /'not-installed'/, 'the ordinary case has its own name');
  assert.match(open, /'launch-failed'/, 'and so does the real failure');
  assert.match(server, /engineReason: o\.engineReason/, '/state has to carry the reason');
});

test('a stand-in that was never installed is not a WARNING on every frame', () => {
  assert.match(mcp, /notedStandIns\.has\(/, 'the quiet note is said once per session');
  assert.ok(
    /if \(o\?\.engineFellBack && o\.engineReason === 'not-installed'\)[\s\S]*?\} else if \(o\?\.engineFellBack\) \{[\s\S]*?WARNING/.test(mcp),
    'the loud warning is reserved for an engine that would not launch',
  );
  assert.match(mcp, /stand-in/, 'and the label stops claiming an engine that is not running');
});

test('pausing the stream retires a frame-loop tick already in flight', () => {
  // clearTimeout only cancels a tick that has not started; one that is
  // mid-screenshot comes back and reschedules itself unless its generation is gone.
  assert.match(body(server, 'stopStream'), /o\.streamGen\s*=/, 'a paused webkit session must not keep capturing');
});
