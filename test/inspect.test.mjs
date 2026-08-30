/**
 * Inspection-engine regression tests.
 *
 * These run the REAL `INSPECTION_SCRIPT` in a REAL browser. The function is
 * serialized and shipped to the page by Playwright, so it cannot close over
 * anything outside itself — meaning the color math can't be extracted into a
 * module without duplicating it. A duplicate would drift: we'd be testing a
 * copy while the shipped engine rots. So the fixtures below are hand-computed
 * known answers, and every case is one we actually got wrong at some point.
 *
 * Run: node --test test/
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { INSPECTION_SCRIPT, PROFILES, deviceSettings } from '../src/cli.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

/** Loads an HTML fixture in the given device profile and returns the findings. */
async function inspect(html, { profile = 'pixel', theme = 'light' } = {}) {
  const p = PROFILES[profile];
  const ctx = await browser.newContext({ ...deviceSettings(p.pw), colorScheme: theme });
  const page = await ctx.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(INSPECTION_SCRIPT, { mobile: p.mobile !== false });
  } finally {
    await ctx.close();
  }
}

const body = (icerik, stil = '') =>
  `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>
     body{margin:0;background:#fff;font-family:sans-serif}${stil}
   </style></head><body>${icerik}</body></html>`;

const bulunanMetinler = (list) => (list || []).map((x) => x.text);

test('white text on white background is reported as invisible (1:1)', async () => {
  const d = await inspect(body('<p style="color:#fff;background:#fff">ghost text</p>'));
  const finding = (d.invisibleText || []).find((x) => x.text === 'ghost text');
  assert.ok(finding, 'expected an invisible-text finding');
  assert.equal(finding.ratio, 1, 'contrast of identical colors must be exactly 1:1');
});

test('black on white is clean — the engine does not cry wolf', async () => {
  const d = await inspect(body('<p style="color:#000;background:#fff">readable copy</p>'));
  assert.equal((d.invisibleText || []).length, 0);
  assert.equal((d.lowContrast || []).length, 0);
});

test('WCAG AA boundary: 4.3:1 fails, 4.6:1 passes', async () => {
  // #767676 on white = 4.54:1 (passes AA) · #808080 on white = 3.95:1 (fails)
  const d = await inspect(body(
    '<p style="color:#767676;background:#fff">passes AA</p>' +
    '<p style="color:#808080;background:#fff">fails AA</p>'
  ));
  const low = bulunanMetinler(d.lowContrast);
  assert.ok(low.includes('fails AA'), '3.95:1 must be flagged');
  assert.ok(!low.includes('passes AA'), '4.54:1 must not be flagged');
});

test('semi-transparent layers are alpha-composited, not taken at face value', async () => {
  // The bug this locks in: a 15%-white overlay was read as solid white, so dark
  // text on it looked "invisible" and produced a false positive (hesapla case).
  const d = await inspect(body(
    '<div style="background:#1a1a1a"><div style="background:rgba(255,255,255,.15)">' +
    '<span style="color:#eaeaea">on a translucent layer</span></div></div>'
  ));
  const falseAlarm = bulunanMetinler(d.invisibleText).includes('on a translucent layer');
  assert.equal(falseAlarm, false, 'light text over a dark-ish composite must not be flagged');
});

test('gradient text is measured through its color stops, not skipped', async () => {
  // Tailwind v4 emits oklab() stops; a plain rgb regex missed them entirely and
  // the engine stayed silent on a genuinely invisible headline (NFC case).
  const d = await inspect(body(
    '<h1><span style="background-image:linear-gradient(to right,' +
    ' oklab(0.999994 0.0000455678 0.0000200868 / 0.5) 0%,' +
    ' oklab(0.999994 0.0000455678 0.0000200868 / 0.6) 100%);' +
    ' -webkit-background-clip:text;background-clip:text;color:transparent">washed out heading</span></h1>'
  ));
  const finding = (d.invisibleText || []).find((x) => x.text === 'washed out heading');
  assert.ok(finding, 'near-white gradient text on white must be reported');
  assert.ok(finding.sel.includes('gradient'), 'finding should say it came from gradient text');
});

test('text over a photo background is skipped rather than guessed', async () => {
  const d = await inspect(body(
    '<div style="background-image:url(data:image/gif;base64,R0lGODlhAQABAAAAACw=)">' +
    '<span style="color:#fff">caption over photo</span></div>'
  ));
  const allText = [...bulunanMetinler(d.invisibleText), ...bulunanMetinler(d.lowContrast)];
  assert.equal(allText.includes('caption over photo'), false, 'CSS cannot know the pixel behind an image');
});

test('icon-font ligatures are not treated as text', async () => {
  const d = await inspect(body(
    '<span style="font-family:\'Material Symbols Outlined\';color:#fdfdfd;background:#fff">restaurant</span>'
  ));
  const allText = [...bulunanMetinler(d.invisibleText), ...bulunanMetinler(d.lowContrast)];
  assert.equal(allText.includes('restaurant'), false, 'ligature name is not user-facing copy');
});

test('touch targets: flagged on mobile, ignored on desktop', async () => {
  const button = '<button style="width:30px;height:30px">x</button>';
  const mobile = await inspect(body(button), { profile: 'pixel' });
  const masaustu = await inspect(body(button), { profile: 'desktop' });
  assert.ok((mobile.smallTargets || []).length >= 1, '30x30 is below 44px on a phone');
  assert.equal((masaustu.smallTargets || []).length, 0, 'pointer devices have no 44px rule');
});

test('a wide text link is not flagged for being short', async () => {
  // Width follows the text on inline links; only height should be judged.
  const d = await inspect(body(
    '<p><a href="#" style="display:inline-block;height:48px;line-height:48px">a very long inline text link</a></p>'
  ));
  const dar = bulunanMetinler(d.smallTargets);
  assert.equal(dar.includes('a very long inline text link'), false);
});

test('horizontal overflow is detected with the offending element', async () => {
  const d = await inspect(body('<div style="width:2000px;height:20px">too wide</div>'));
  assert.ok(d.horizontalOverflow, 'expected an overflow finding');
  assert.ok(d.horizontalOverflow.pageWidth > d.horizontalOverflow.viewportWidth);
  assert.ok(d.horizontalOverflow.overflowing.length >= 1, 'should name what overflows');
});

test('theme signature differs between light and dark when the page responds', async () => {
  // Note the element: the signature samples structural/interactive elements
  // (body, header, nav, main, footer, button, a, input, card/panel/modal/menu),
  // not every <p>. That keeps the sample small and representative; if a page's
  // drift lives only in body copy, the light↔dark comparison won't see it.
  const html = body('<button class="t">themed</button>',
    '.t{color:#111;background:#fff}@media (prefers-color-scheme: dark){.t{color:#eee;background:#111}}');
  const light = await inspect(html, { theme: 'light' });
  const dark = await inspect(html, { theme: 'dark' });
  const find = (d) => (d.themeSignature || []).find((x) => x.sel === 'button.t');
  assert.ok(find(light) && find(dark), 'the button should appear in both signatures');
  assert.notEqual(find(light).color, find(dark).color, 'a theme-aware element must change color');
});

test('theme signature stays identical when colors are hard-coded', async () => {
  // This is the drift the engine exists to catch: same color in both themes.
  const html = body('<button class="t">frozen</button>', '.t{color:#111;background:#fff}');
  const light = await inspect(html, { theme: 'light' });
  const dark = await inspect(html, { theme: 'dark' });
  const find = (d) => (d.themeSignature || []).find((x) => x.sel === 'button.t');
  assert.equal(find(light).color, find(dark).color);
  assert.equal(find(light).bg, find(dark).bg);
});

test('device profiles expose a usable viewport and touch flag', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    const settings = deviceSettings(p.pw);
    assert.ok(settings?.viewport?.width > 0, `${name}: viewport width missing`);
    if (p.mobile === false) assert.notEqual(settings.hasTouch, true, `${name}: desktop must not claim touch`);
  }
});
