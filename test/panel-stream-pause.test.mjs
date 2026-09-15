/**
 * A panel with nobody watching does not keep encoding frames.
 *
 * `Page.startScreencast` was started once per session and never stopped --
 * `stopScreencast` appeared nowhere in the file. Every repaint was encoded to a
 * JPEG and discarded for as long as the panel lived, open tab or not. Measured
 * on a continuously repainting page: ~59% of a core per panel, idle. A static
 * page hid it completely, because a screencast only fires on repaint.
 *
 * Two things have to hold together, and either one alone is useless:
 * the stream stops when the last viewer leaves AND starts again on the first,
 * and every reader of the cached frame checks its age -- otherwise pausing the
 * stream just trades a CPU bug for a stale-screenshot bug, which is worse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs'), 'utf8');
// Comments quote the shapes they replaced; assert on what runs.
const server = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('the stream can actually be stopped', () => {
  assert.ok(server.includes("'Page.stopScreencast'"), 'a stream that is never stopped is the bug');
  // The timer has to be cleared, whichever clear does it: a later change swapped
  // this loop from setInterval to setTimeout recursion, and an assertion bound to
  // the spelling failed on a file that still stops the stream perfectly well.
  // Test the behaviour -- the fallback timer is cleared in the stop path.
  const stop = server.match(/async function stopStream\([\s\S]*?\n\}/);
  assert.ok(stop, 'the stop path has to exist to be checked');
  assert.match(stop[0], /clear(Interval|Timeout)\(o\.fallbackTimer\)/,
    'the screenshot fallback is a frame producer too, and must stop with it');
  assert.match(stop[0], /o\.fallbackTimer = null/, 'and the handle has to be dropped, not left dangling');
});

test('the viewer set decides, in both directions', () => {
  assert.match(server, /clients\.size === 1/, 'the first viewer has to restart the stream');
  assert.match(server, /clients\.size === 0/, 'the last one leaving has to stop it');
  // Stopping without restarting would leave the panel frozen for the next viewer.
  assert.ok(/resumeStream|resumeAllStreams/.test(server), 'there has to be a way back');
});

test('every reader of the cached frame checks its age', () => {
  // With the stream stopped, `lastFrame` can be arbitrarily old. A reader that
  // trusts it hands back a screen that no longer exists -- the failure this
  // tool cannot afford.
  const readers = server.match(/o\.lastFrame\s*(\?|&&)/g) || [];
  assert.ok(readers.length >= 2, `expected the frame to be read in more than one place, found ${readers.length}`);
  assert.equal(
    (server.match(/o\.lastFrame\s*\?\s*Buffer\.from/g) || []).length, 0,
    'an ungated read of the cached frame can return a screen that is no longer on display',
  );
});
