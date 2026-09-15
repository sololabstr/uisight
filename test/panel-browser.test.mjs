/**
 * A panel opens one browser, not two.
 *
 * The two sessions are started concurrently on purpose, so a plain
 * `if (!browser) browser = await chromium.launch()` is not a guard: both
 * sessions reach the test before either assignment lands, both pass it, and a
 * second browser launches. It is then overwritten in the variable, which means
 * nothing can ever close it -- the exit handler only sees the one still held.
 * Measured on a plain `uisight-panel <url>`: two `chrome-headless-shell`
 * process trees, about 600 MB of them, for a panel that needs one.
 *
 * The launch is cached as a PROMISE for that reason, and these assertions are
 * on the source text because the failure is structural: it is the gap between
 * the test and the assignment, and it is invisible in any single run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.mjs'), 'utf8');

// Comments are source text too, and the comment above the fix quotes the shape
// it replaced -- matching against the raw file would find the bug in its own
// obituary. Strip comments and assert on what actually runs.
const server = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// These assert on shape, not on names: what matters is that no `await` sits
// between deciding to launch and storing the launch, whatever either is called.
test('no await sits between the decision to launch and storing it', () => {
  assert.ok(
    !/=\s*await\s+[\w.\[\]]+\.launch\(/.test(server),
    'awaiting a launch into the variable that guards it is the race itself',
  );
});

test('what is stored is the promise, and a failed launch is not kept', () => {
  assert.match(server, /=\s*[\w.\[\]]+\.launch\([^)]*\)\s*\.catch\(/, 'the promise has to be stored before it settles');
  assert.ok(
    /delete\s+[\w.\[\]]+\[[^\]]+\]|[\w.]+\s*=\s*null/.test(server),
    'a rejected launch must be cleared, or one transient failure is permanent',
  );
});

test('exit closes the browser the panel actually holds', () => {
  // A plain `await browser?.close()` could only ever reach the last one assigned.
  assert.match(server, /await\s*\(await\s+[\w.\[\]]+\)\?\.close\(\)/, 'teardown has to resolve the stored launch before closing it');
});
