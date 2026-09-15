/**
 * Text nobody can see is not unreadable text.
 *
 * The touch-target rule already drops a zero-sized box. The under-12px rule did
 * not, so the contents of a `display:none` block were reported on every profile
 * that hides it. Measured on a real login screen: its theme switcher is
 * desktop-only, and the phone profile still reported its label as "11px".
 *
 * A finding the user cannot act on, about a thing that is not on the screen
 * they were shown, spends the credibility the measured findings earn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const cli = strip(readFileSync(join(root, 'src', 'cli.mjs'), 'utf8'));

const kural = (secici) => {
  const m = cli.match(new RegExp(`document\\.querySelectorAll\\('${secici}'\\)[\\s\\S]*?\\n  \\}\\);`));
  assert.ok(m, `the rule over '${secici}' has to exist to be checked`);
  return m[0];
};

test('the touch-target rule skips a box with no size', () => {
  // The positive control: this is the idiom the under-12px rule was missing,
  // and if it ever leaves this file the test below is measuring nothing.
  assert.match(kural('a, button, \\[role="button"\\], input, select, textarea'),
    /r\.width === 0 \|\| r\.height === 0/, 'a zero-sized control is not a small target');
});

test('the under-12px rule skips one too', () => {
  const r = kural('p, span, li, a, button, label, td');
  assert.match(r, /getBoundingClientRect/, 'the rule has to look at the box at all');
  assert.match(r, /!r\.width \|\| !r\.height/, 'hidden text is not tiny text');
});
