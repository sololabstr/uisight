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
import { INSPECTION_SCRIPT, PERMISSION_HOOKS, PROFILES, deviceSettings } from '../src/cli.mjs';

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

/** Loads an HTML fixture in the given device profile and returns the findings. */
async function inspect(html, { profile = 'pixel', theme = 'light', navigate = false } = {}) {
  const p = PROFILES[profile];
  const ctx = await browser.newContext({ ...deviceSettings(p.pw), colorScheme: theme });
  const page = await ctx.newPage();
  await page.addInitScript(PERMISSION_HOOKS);
  try {
    // setContent does NOT run init scripts, so anything that has to be in place
    // before page code (the permission hooks) needs a real navigation. Only the
    // tests that need it pay for it.
    if (navigate) await page.goto('data:text/html,' + encodeURIComponent(html), { waitUntil: 'load' });
    else await page.setContent(html, { waitUntil: 'domcontentloaded' });
    return await page.evaluate(INSPECTION_SCRIPT, { mobile: p.mobile !== false, theme });
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

/**
 * Overlap, clipping, and fixed-bar coverage.
 *
 * These three came from four screenshots a person took by hand. The engine
 * measured those same pages and called them clean, because contrast and size
 * rules cannot see one element sitting on top of another.
 *
 * The first version of the overlap check sampled only the element's centre and
 * missed the very case that prompted it — a floating button on the corner of a
 * wide CTA. That is why the grid case below exists: it is the bug, not a
 * hypothetical.
 */
test('a floating button covering the corner of a CTA is caught, not just the centre', async () => {
  const d = await inspect(body(`
    <div style="position:relative;height:100vh">
      <button style="position:absolute;bottom:40px;left:20px;right:20px;height:64px">Devam Et</button>
      <button aria-label="chat" style="position:absolute;bottom:28px;right:24px;width:64px;height:64px;border-radius:50%;z-index:9">C</button>
    </div>`));
  const hit = (d.coveredControls || []).find((x) => x.text.includes('Devam'));
  assert.ok(hit, 'the covered CTA must be reported');
  assert.ok(hit.percent >= 10, `coverage should be measured, got ${hit?.percent}`);
});

test('buttons that merely sit next to each other are not reported as covered', async () => {
  const d = await inspect(body(`
    <div style="padding:20px">
      <button style="display:block;width:200px;height:48px;margin-bottom:16px">Kaydet</button>
      <button style="display:block;width:200px;height:48px">Iptal</button>
    </div>`));
  assert.equal((d.coveredControls || []).length, 0, 'adjacent buttons must not be flagged');
});

test('text cut off by its own box is reported', async () => {
  const d = await inspect(body(`<div style="width:160px;height:24px;overflow:hidden">Bu metin kutusuna kesinlikle sigmiyor ve alt satira tasip kirpiliyor</div>`));
  const hit = (d.clippedText || []).find((x) => x.text.includes('sigmiyor'));
  assert.ok(hit, 'clipped text must be reported');
  assert.equal(hit.axis, 'vertical');
  assert.ok(hit.hiddenPx > 3, 'it should say how much is hidden');
});

test('a deliberate ellipsis is not treated as a bug', async () => {
  const d = await inspect(body(`<div style="width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Cok uzun bir baslik burada kesilecek</div>`));
  assert.equal((d.clippedText || []).length, 0, 'text-overflow:ellipsis is a choice, not a defect');
});

test('a sticky header covering page text is reported', async () => {
  const d = await inspect(body(`
    <header style="position:fixed;top:0;left:0;right:0;height:90px;background:#fff;z-index:5">Kokart</header>
    <main style="padding-top:20px"><p style="margin:0 16px">ekle, genel rehberseniz bos birakabilirsiniz)</p></main>`));
  const hit = (d.coveredByFixed || []).find((x) => x.text.includes('rehberseniz'));
  assert.ok(hit, 'text under the fixed header must be reported');
  assert.ok(hit.percent >= 40, `coverage percent should be meaningful, got ${hit?.percent}`);
});

test('a normal page with a header and spaced content stays clean on all three', async () => {
  const d = await inspect(body(`
    <header style="position:fixed;top:0;left:0;right:0;height:60px;background:#fff;z-index:5">Baslik</header>
    <main style="padding-top:80px">
      <h1>Hos geldiniz</h1>
      <p>Normal bir paragraf, hicbir sey ustune binmiyor.</p>
      <button style="width:200px;height:48px">Devam</button>
    </main>`));
  assert.equal((d.coveredControls || []).length, 0, 'no false overlap');
  assert.equal((d.clippedText || []).length, 0, 'no false clipping');
  assert.equal((d.coveredByFixed || []).length, 0, 'no false fixed-bar coverage');
});

test('a modal covering the page beneath it is not reported — that is what a modal does', async () => {
  const d = await inspect(body(`
    <main>
      <button style="width:200px;height:48px">Kaydet</button>
      <button style="width:200px;height:48px">Iptal</button>
    </main>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;display:flex;align-items:center;justify-content:center">
      <div style="background:#fff;padding:24px;border-radius:12px">Hos geldin</div>
    </div>`));
  assert.equal((d.coveredControls || []).length, 0,
    'a full-screen overlay is a modal, not a layout bug');
});

test('a bottom cookie bar covering a floating button IS reported', async () => {
  const d = await inspect(body(`
    <div style="position:relative;height:100vh">
      <button aria-label="whatsapp" style="position:fixed;bottom:24px;right:20px;width:56px;height:56px;border-radius:50%">W</button>
      <div style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#fff;z-index:9;padding:16px">
        <button style="width:160px;height:44px">Hepsini Kabul Et</button>
      </div>
    </div>`));
  const hit = (d.coveredControls || []).find((x) => x.size === '56x56');
  assert.ok(hit, 'a partial cover must still be reported — this is the redios case');
  assert.ok(hit.percent >= 50, `the bar sits right over it, got ${hit?.percent}%`);
});

test('the dialog box inside a modal is exempt too, not just the scrim', async () => {
  // songa: exempting only the scrim left the dialog's own content box reported
  // as the cover — 10 false findings became 8, all still the same modal.
  const d = await inspect(body(`
    <main><button style="width:200px;height:48px">Kaydet</button></main>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50">
      <div style="position:absolute;top:20px;left:10px;right:10px;background:#fff;padding:24px">
        <h2>Hos geldin</h2><p>Uzun bir karsilama metni burada duruyor.</p>
      </div>
    </div>`));
  assert.equal((d.coveredControls || []).length, 0, 'the dialog content box is part of the modal');
});

test('line-clamped card text is deliberate truncation, not a clipping bug', async () => {
  // Across 14 live sites, 17 of 18 "clipped text" findings were line-clamp:
  // recipe cards, quote cards, product blurbs. All of them by design.
  const d = await inspect(body(`
    <div style="width:280px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">
      Havucla yapilan bu pratik tarator, Akdeniz mutfaginin en sevilen mezelerinden biridir
      ve sofralarda hep ilk biten tabak olur.
    </div>`));
  assert.equal((d.clippedText || []).length, 0, 'line-clamp is a design choice');
});

test('a fixed element that overlaps but sits BEHIND is not reported', async () => {
  // app.redios.com.tr: a floating button geometrically covered the cookie
  // banner's buttons while rendering behind it, perfectly readable. Geometry
  // alone lies; the browser has to say what is actually on top.
  const d = await inspect(body(`
    <div style="position:fixed;bottom:24px;right:20px;width:56px;height:56px;z-index:1;background:#25d366">W</div>
    <div style="position:fixed;bottom:0;left:0;right:0;background:#fff;z-index:40;padding:20px">
      <button style="width:160px;height:44px">Hepsini Kabul Et</button>
    </div>`));
  assert.equal((d.coveredByFixed || []).length, 0, 'the button is on top, nothing hides it');
});

test('content genuinely hidden behind a bottom nav IS reported', async () => {
  // "Genuinely" means scrolling cannot save it. A FIXED element under a fixed
  // bar stays there at every scroll position; ordinary flow content does not,
  // and the test below covers that case.
  const d = await inspect(body(`
    <main style="height:200vh">uzun sayfa</main>
    <p style="position:fixed;bottom:10px;left:16px;width:200px;margin:0">WELCOME PAKET</p>
    <nav style="position:fixed;bottom:0;left:0;right:0;height:64px;background:#fff;z-index:40">nav</nav>`));
  const hit = (d.coveredByFixed || []).find((x) => x.text.includes('WELCOME'));
  assert.ok(hit, 'a fixed element under a fixed bar is trapped at every scroll position');
});

test('flow content the user can simply scroll clear of is NOT reported', async () => {
  // Measured on a real app: all 17 findings of this kind were this case. The
  // container gave 96px of bottom padding against a 56px bar, so scrolling to
  // the end put the content above the bar — the chips were tapped by hand on a
  // device and worked. Reporting it made the noisiest category in the run.
  const d = await inspect(body(`
    <main style="height:200vh;padding-bottom:96px">
      <p style="margin-top:calc(100vh - 40px);width:200px">KAYDIRINCA CIKAR</p>
    </main>
    <nav style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#fff;z-index:40">nav</nav>`));
  const hit = (d.coveredByFixed || []).find((x) => x.text.includes('KAYDIRINCA'));
  assert.equal(hit, undefined, 'more page below means the user can scroll it clear');
});

test('a bottom nav over a control the user can scroll clear of is not a finding', async () => {
  // Measured on a production app: a "Modules" row read as 100% covered by the
  // bottom nav while the page had 1,715px left to scroll — the row rises above
  // the bar as soon as you move. The gate existed in the fixed-bar check and was
  // missing here; the field report named both, and only one got it.
  const d = await inspect(body(`
    <main style="height:200vh;padding-bottom:96px">
      <a href="/x" style="display:block;margin-top:calc(100vh - 30px);width:340px">Modüller ›</a>
    </main>
    <nav style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#fff;z-index:40">
      <a href="/a">Ana</a></nav>`));
  const hit = (d.coveredControls || []).find((x) => x.text.includes('Modüller'));
  assert.equal(hit, undefined, 'more page below means the user can scroll it clear');
});

test('a development overlay covering a real control is not a finding', async () => {
  // Next.js puts a dev-tools button in a <nextjs-portal>. It covered a rating
  // link and produced a finding on two pages. It does not exist in production.
  //
  // The first attempt at this fix exempted the wrong side — targets inside a dev
  // overlay rather than dev overlays doing the covering — and the finding stayed.
  // Only re-running the audit caught that.
  const d = await inspect(body(`
    <a href="/x" style="position:absolute;top:20px;left:20px">4.9 (44)</a>
    <nextjs-portal style="position:fixed;top:20px;left:20px;width:120px;height:40px;background:#000"></nextjs-portal>`));
  const hit = (d.coveredControls || []).find((x) => x.text.includes('4.9'));
  assert.equal(hit, undefined, 'a dev overlay is not part of the application');
});

test('a round floating button is not reported as covered by what shows through its corners', async () => {
  // A circle inside a 56x56 box leaves ~21% of the box unpainted at the corners.
  // Sampling those corners returns the text behind and read as "the button is
  // covered" — a chat FAB over body copy reported 27% covered on four pages.
  const d = await inspect(body(`
    <p style="position:absolute;bottom:30px;left:16px;width:340px">
      Turk Hukuku uygulanir; uyusmazliklarda Istanbul mahkemeleri yetkilidir.
    </p>
    <button aria-label="Sohbetler" style="position:fixed;bottom:20px;right:20px;width:56px;height:56px;border-radius:50%;background:#cf4709;color:#fff;border:0;z-index:50">S</button>`));
  const hit = (d.coveredControls || []).find((x) => x.text.includes('Sohbet') || x.size === '56x56');
  assert.equal(hit, undefined, 'the FAB paints over the text, it is not covered by it');
});

/**
 * UX checks — the failures a person names in a sentence, not a stack trace.
 *
 * Each of these came from a list of real complaints. They are only worth having
 * if they stay quiet on correct pages, so every one has a false-alarm test too.
 */
test('buttons in a row that all look identical hide which one is the primary action', async () => {
  const d = await inspect(body(`
    <div style="display:flex;gap:8px;padding:16px">
      <button style="background:#e5e5e5;border:1px solid #ccc;padding:10px 18px">Kaydet</button>
      <button style="background:#e5e5e5;border:1px solid #ccc;padding:10px 18px">Iptal</button>
      <button style="background:#e5e5e5;border:1px solid #ccc;padding:10px 18px">Sil</button>
    </div>`));
  const hit = (d.sameLookingActions || [])[0];
  assert.ok(hit, 'three identical buttons must be reported');
  assert.equal(hit.count, 3);
  assert.ok(hit.labels.includes('Kaydet'));
});

test('a row where the primary action stands out is not reported', async () => {
  const d = await inspect(body(`
    <div style="display:flex;gap:8px;padding:16px">
      <button style="background:#cf4709;color:#fff;border:0;padding:10px 18px">Kaydet</button>
      <button style="background:#e5e5e5;border:1px solid #ccc;padding:10px 18px">Iptal</button>
    </div>`));
  assert.equal((d.sameLookingActions || []).length, 0, 'a distinct primary action is the point');
});

/**
 * The three false alarms this check produced on a real app, all on one run.
 * A bottom nav, filter chips and a link row are SUPPOSED to look uniform; a tool
 * that flags them on every page teaches people to ignore it.
 */
test('a bottom navigation bar is not a row of competing actions', async () => {
  const d = await inspect(body(`
    <nav style="display:flex;gap:8px;padding:16px">
      <button style="background:#e5e5e5;border:1px solid #ccc;padding:10px 18px">Ara</button>
      <button style="background:#e5e5e5;border:1px solid #ccc;padding:10px 18px">Takvim</button>
      <button style="background:#e5e5e5;border:1px solid #ccc;padding:10px 18px">Mesaj</button>
      <button style="background:#e5e5e5;border:1px solid #ccc;padding:10px 18px">Profil</button>
    </nav>`));
  assert.equal((d.sameLookingActions || []).length, 0, 'tabs are uniform on purpose');
});

test('filter chips are not reported: mis-clicking one costs nothing', async () => {
  const d = await inspect(body(`
    <div style="display:flex;gap:8px;padding:16px">
      <button style="background:#eee;border:1px solid #ccc;padding:8px 14px">Bu hafta sonu</button>
      <button style="background:#eee;border:1px solid #ccc;padding:8px 14px">Onumuzdeki hafta</button>
    </div>`));
  assert.equal((d.sameLookingActions || []).length, 0, 'no committing action in the group');
});

test('links that lead to different pages are navigation, however they are styled', async () => {
  const d = await inspect(body(`
    <div style="display:flex;gap:8px;padding:16px">
      <a href="/kaydet" class="btn" style="background:#eee;border:1px solid #ccc;padding:10px">Kaydet</a>
      <a href="/sil" class="btn" style="background:#eee;border:1px solid #ccc;padding:10px">Sil</a>
    </div>`));
  assert.equal((d.sameLookingActions || []).length, 0, 'different destinations = navigation');
});

/**
 * Notch / home indicator. The gate here is precise, and it is what keeps this
 * check quiet: without `viewport-fit=cover` iOS letterboxes the page and the
 * insets are all 0, so nothing can be hidden. The finding only exists when a
 * page asked for the full screen and then never used the padding it got back.
 */
test('a fixed bar under the home indicator is reported when the page asked for the full screen', async () => {
  const d = await inspect(
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
     <body style="margin:0">
       <div style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#222">
         <button style="width:100%;height:56px;color:#fff;background:#222;border:0">Devam</button>
       </div>
     </body>`,
    { profile: 'pixel' },
  );
  const hit = (d.unsafeArea || [])[0];
  assert.ok(hit, 'a full-width fixed bar at the bottom edge must be reported');
  assert.equal(hit.edge, 'bottom');
});

test('without viewport-fit=cover the notch cannot reach the page, so nothing is reported', async () => {
  const d = await inspect(
    `<meta name="viewport" content="width=device-width, initial-scale=1">
     <body style="margin:0">
       <div style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#222">
         <button style="width:100%;height:56px;color:#fff;background:#222;border:0">Devam</button>
       </div>
     </body>`,
    { profile: 'pixel' },
  );
  assert.equal((d.unsafeArea || []).length, 0, 'iOS letterboxes the page; the insets are 0');
});

test('a page that uses the inset it asked for is not reported', async () => {
  const d = await inspect(
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
     <style>.bar { padding-bottom: env(safe-area-inset-bottom); }</style>
     <body style="margin:0">
       <div class="bar" style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#222">
         <button style="width:100%;height:56px;color:#fff;background:#222;border:0">Devam</button>
       </div>
     </body>`,
    { profile: 'pixel' },
  );
  assert.equal((d.unsafeArea || []).length, 0, 'the padding is there — that is the fix');
});

test('a desktop viewport has no notch, so the check does not run', async () => {
  const d = await inspect(
    `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
     <body style="margin:0">
       <div style="position:fixed;bottom:0;left:0;right:0;height:56px;background:#222">
         <button style="width:100%;height:56px;color:#fff;background:#222;border:0">Devam</button>
       </div>
     </body>`,
    { profile: 'desktop' },
  );
  assert.equal((d.unsafeArea || []).length, 0, 'desktop screens have no home indicator');
});

/**
 * "An error occurred." Which error? And then what?
 *
 * A message that names nothing leaves one option: try again and hope. The check
 * stays quiet when the box says something concrete, or when it offers a way out.
 */
test('an error box that says nothing specific is reported', async () => {
  const d = await inspect(body('<div role="alert" style="padding:12px">Bir hata oluştu.</div>'));
  const hit = (d.genericErrors || [])[0];
  assert.ok(hit, 'a message with no content must be reported');
  assert.match(hit.text, /hata/i);
});

test('an error that names the problem is not reported', async () => {
  const d = await inspect(body(
    '<div role="alert" style="padding:12px">E-posta adresi geçersiz: @ işareti eksik.</div>'));
  assert.equal((d.genericErrors || []).length, 0, 'this one tells you what to fix');
});

test('a vague error that still offers a way out is not reported', async () => {
  const d = await inspect(body(
    '<div role="alert" style="padding:12px">Bir hata oluştu.<button>Tekrar dene</button></div>'));
  assert.equal((d.genericErrors || []).length, 0, 'the person knows what to do next');
});

/**
 * Delete with nothing between the tap and the loss.
 *
 * The button is never clicked — clicking it really deletes. What is measured is
 * whether the page owns any confirmation machinery at all.
 */
test('a delete button on a page with no confirmation machinery is reported', async () => {
  const d = await inspect(body('<button>Sil</button>'));
  const hit = (d.destructiveWithoutConfirm || [])[0];
  assert.ok(hit, 'an irreversible action one tap away must be reported');
  assert.equal(hit.text, 'Sil');
});

test('a delete button on a page that has a dialog is not reported', async () => {
  const d = await inspect(body(
    '<button aria-haspopup="dialog">Sil</button><dialog><p>Emin misiniz?</p></dialog>'));
  assert.equal((d.destructiveWithoutConfirm || []).length, 0, 'the confirmation step exists');
});

test('a harmless button is not mistaken for a destructive one', async () => {
  const d = await inspect(body('<button>Kaydet</button><button>Paylaş</button>'));
  assert.equal((d.destructiveWithoutConfirm || []).length, 0, 'nothing is lost by tapping these');
});

/**
 * Permissions asked for before there is any reason to say yes.
 *
 * The hook is installed before page code runs and calls the real API through,
 * so the page behaves exactly as it would unobserved.
 */
test('a permission requested during load, with nothing explaining it, is reported', async () => {
  const d = await inspect(body(
    '<p>Hoş geldiniz</p><script>try{navigator.geolocation.getCurrentPosition(()=>{},()=>{})}catch(e){}</script>'), { navigate: true });
  const hit = (d.eagerPermissions || [])[0];
  assert.ok(hit, 'a load-time request has no context behind it');
  assert.equal(hit.api, 'location');
});

test('a permission requested after the person acts is not reported', async () => {
  const d = await inspect(body(
    `<button id="b">Yakınımdakileri göster</button>
     <script>
       document.getElementById('b').addEventListener('click', () => {
         try { navigator.geolocation.getCurrentPosition(()=>{},()=>{}) } catch(e) {}
       });
       addEventListener('load', () => document.getElementById('b').dispatchEvent(
         new PointerEvent('pointerdown', { bubbles: true })));
       addEventListener('load', () => document.getElementById('b').click());
     </script>`), { navigate: true });
  assert.equal((d.eagerPermissions || []).length, 0, 'the tap is the explanation');
});

test('a page that asks for nothing reports nothing', async () => {
  const d = await inspect(body('<p>Merhaba</p>'), { navigate: true });
  assert.equal((d.eagerPermissions || []).length, 0);
});

/**
 * Content clipped by a container, with no way to scroll to it.
 *
 * The leaf-text check skips anything with children, so the real defect one level
 * up was invisible: a six-column table inside an `overflow-hidden` box showed
 * three columns on a phone and the rest simply did not exist. Three pages had
 * the same pattern and the engine found none of them; a person spotted it in a
 * screenshot.
 *
 * The discriminator is clean, which is why this check can be trusted: the same
 * box with `overflow-x: auto` is fine, because the user can reach the rest.
 */
test('a wide table inside an overflow-hidden box is reported', async () => {
  const d = await inspect(body(`
    <div style="width:300px;overflow:hidden">
      <table style="width:900px"><tr><td>Ad</td><td>Sınıflandırma</td><td>H ifadeleri</td></tr></table>
    </div>`));
  const hit = (d.clippedContainer || [])[0];
  assert.ok(hit, 'content the user cannot reach must be reported');
  assert.ok(hit.hiddenPx > 100, `expected a real overflow, got ${hit?.hiddenPx}`);
});

test('the same table in a scrollable box is not reported', async () => {
  const d = await inspect(body(`
    <div style="width:300px;overflow-x:auto">
      <table style="width:900px"><tr><td>Ad</td><td>Sınıflandırma</td><td>H ifadeleri</td></tr></table>
    </div>`));
  assert.equal((d.clippedContainer || []).length, 0, 'the user can scroll to it — that is the fix');
});

test('a box whose content fits is not reported', async () => {
  const d = await inspect(body(
    `<div style="width:300px;overflow:hidden"><p>kısa metin</p></div>`));
  assert.equal((d.clippedContainer || []).length, 0);
});

test('a decorative clipped strip with no text is not reported', async () => {
  const d = await inspect(body(`
    <div aria-hidden="true" style="width:200px;overflow:hidden">
      <div style="width:800px;height:40px;background:linear-gradient(90deg,#f00,#00f)"></div>
    </div>`));
  assert.equal((d.clippedContainer || []).length, 0, 'nothing to read means nothing is lost');
});

/**
 * "Empty" shown while the data is still on its way.
 *
 * One page said TOTAL 0 with 45 documents in the database. Another showed
 * "0 items" in the heading and "0 / 0 shown" in the counter while a spinner
 * turned in the search box — the library had 5,055 records. For a moment the
 * user is told the database is empty. If both are on screen at once, what is
 * displayed is not the truth, it is an intermediate state.
 */
test('a zero count next to a running spinner is reported', async () => {
  const d = await inspect(body(`
    <div class="animate-spin" style="width:20px;height:20px;border:2px solid #333"></div>
    <p>0 kayıt bulunamadı</p>`));
  assert.ok((d.loadingButEmpty || [])[0], 'the user is being told something untrue');
});

test('a zero count with nothing loading is a real empty state', async () => {
  const d = await inspect(body('<p>0 kayıt bulunamadı</p>'));
  assert.equal((d.loadingButEmpty || []).length, 0, 'an honest empty state is not a bug');
});

test('a spinner with real content beside it is not reported', async () => {
  const d = await inspect(body(`
    <div role="progressbar" style="width:20px;height:20px"></div>
    <p>45 belge listeleniyor</p>`));
  assert.equal((d.loadingButEmpty || []).length, 0, 'loading while showing data is normal');
});

/**
 * Text vanishing behind a control.
 *
 * There was a gap between two checks: one looks for controls being covered, the
 * other only at fixed bars. The real defect was neither — a `justify-between`
 * row that did not wrap on a phone, so the description paragraph slid under the
 * upload button. Nothing was fixed and no control was covered, so nobody saw it.
 *
 * This is a place where a false alarm is cheap to create, so the gates are
 * narrow: two of three sample points, and the thing on top has to be a control.
 * A decorative layer over text is often intentional; a button over text is not.
 */
test('a paragraph sliding under a button is reported', async () => {
  const d = await inspect(body(`
    <div style="position:relative;width:360px">
      <p style="position:absolute;top:0;left:0;width:340px;margin:0">
        SDS dosyanızı yükleyin, sistem otomatik ayrıştırsın
      </p>
      <button style="position:absolute;top:0;left:60px;width:200px;height:40px;background:#cf4709;color:#fff;border:0">
        SDS yükle
      </button>
    </div>`));
  const hit = (d.textUnderControl || [])[0];
  assert.ok(hit, 'text a user cannot read must be reported');
  assert.match(hit.controlText, /SDS/);
});

test('text beside a button, not under it, is not reported', async () => {
  const d = await inspect(body(`
    <div style="display:flex;gap:16px;width:360px">
      <p style="margin:0;flex:1">SDS dosyanızı yükleyin, sistem ayrıştırsın</p>
      <button style="background:#cf4709;color:#fff;border:0;padding:10px">SDS yükle</button>
    </div>`));
  assert.equal((d.textUnderControl || []).length, 0, 'a normal row is not a collision');
});

test('text behind a dismissible consent banner is not reported', async () => {
  // Found on a real page the first time this check ran: a cookie banner sat over
  // a pricing card and produced a finding. Pressing "only essential" reveals
  // everything — the text is one tap away, not lost.
  //
  // The distinction matters: the same banner covering a CONTROL is a real bug,
  // because the user cannot reach that control. So coveredControls keeps no such
  // exemption; this one is only about text.
  const d = await inspect(body(`
    <div style="position:relative;width:360px">
      <p style="position:absolute;top:0;left:0;width:340px;margin:0">
        Bordro puantajı, tatil zammı otomatik hesaplanır
      </p>
      <div style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:8px">
        <p style="margin:0">Çerez ve gizlilik</p>
        <button style="position:absolute;top:-40px;left:60px;width:200px;height:40px">Sadece zorunlu</button>
      </div>
    </div>`));
  assert.equal((d.textUnderControl || []).length, 0, 'a banner is dismissed, not permanent');
});

test('a decorative layer over text is not a control and is not reported', async () => {
  const d = await inspect(body(`
    <div style="position:relative;width:360px">
      <p style="position:absolute;top:0;left:0;width:340px;margin:0">
        Türk hukuku uygulanır; uyuşmazlıklarda İstanbul mahkemeleri yetkilidir
      </p>
      <div aria-hidden="true" style="position:absolute;top:0;left:0;width:340px;height:40px;
        background:linear-gradient(#fff0,#fff)"></div>
    </div>`));
  assert.equal((d.textUnderControl || []).length, 0, 'a fade overlay is a design choice');
});

test('a light panel left behind in dark mode is reported', async () => {
  const d = await inspect(
    body(`<main style="background:#111;min-height:100vh">
            <section style="background:#ffffff;height:60vh">Ayarlar</section>
          </main>`),
    { theme: 'dark' });
  const hit = (d.darkModeLightPatches || [])[0];
  assert.ok(hit, 'a white panel in dark mode must be reported');
  assert.ok(hit.share >= 20, `it should say how much of the screen, got ${hit?.share}`);
});

test('a properly dark page in dark mode is not reported', async () => {
  const d = await inspect(
    body(`<main style="background:#111;min-height:100vh;color:#eee">
            <section style="background:#1c1c1c;height:60vh">Ayarlar</section>
          </main>`),
    { theme: 'dark' });
  assert.equal((d.darkModeLightPatches || []).length, 0, 'dark on dark is correct');
});

test('a light page in LIGHT mode is never reported as a dark-mode problem', async () => {
  const d = await inspect(body(`<main style="background:#fff;min-height:100vh">Ayarlar</main>`), { theme: 'light' });
  assert.equal((d.darkModeLightPatches || []).length, 0, 'the check only applies to dark mode');
});

test('American date format is reported, and an unambiguous day-first date is not', async () => {
  const d = await inspect(body(`<p>Rezervasyon: 09/28/2026 tarihinde baslar ve bir hafta surer.</p>`));
  const hit = (d.usDates || []).find((x) => x.text === '09/28/2026');
  assert.ok(hit, 'MM/DD/YYYY must be reported');
  assert.match(hit.note, /AA\/GG/);

  const temiz = await inspect(body(`<p>Rezervasyon 28.09.2026 tarihinde baslar ve bir hafta surer.</p>`));
  assert.equal((temiz.usDates || []).length, 0, 'dotted Turkish dates are fine');
});

test('a page mixing Turkish and English UI words is reported', async () => {
  const d = await inspect(body(`
    <nav><a href="#">Ana sayfa</a> <a href="#">Ayarlar</a> <a href="#">Settings</a></nav>
    <p>Rehberinizi bölgeye göre bulun ve rezervasyon yapın. Please continue with your account to save changes.</p>
    <button>Kaydet</button><button>Cancel</button><button>Delete</button>`));
  const hit = (d.mixedLanguage || [])[0];
  assert.ok(hit, 'mixed UI language must be reported');
  assert.ok(hit.englishWords.length > 0, 'it should name the English words found');
});

test('a page entirely in Turkish is not reported as mixed', async () => {
  const d = await inspect(body(`
    <nav><a href="#">Ana sayfa</a> <a href="#">Ayarlar</a> <a href="#">Profil</a></nav>
    <p>Rehberinizi bölgeye göre bulun ve rezervasyon yapın. Hesabınızla devam ederek değişiklikleri kaydedin.</p>
    <button>Kaydet</button><button>İptal</button><button>Sil</button>`));
  assert.equal((d.mixedLanguage || []).length, 0, 'a single-language page is consistent');
});

test('a couple of stray English labels on a long Turkish page are noise, not a second language', async () => {
  // Measured on a real page: 591 Turkish markers against 7 English ones, all of
  // them a carousel's "next" label. Reporting that teaches people to skip the
  // finding, and then the genuinely half-translated screen goes unread too.
  const turkce = Array.from({ length: 40 }, (_, i) =>
    `<p>Ürün ${i} için yeni bir kayıt oluşturuldu ve işlem başarıyla tamamlandı.</p>`).join('');
  const d = await inspect(body(turkce + '<button aria-label="next">next</button><button>Next</button>'));
  assert.equal((d.mixedLanguage || []).length, 0, 'a 1% minority is noise');
});

test('a genuinely half-translated screen is still reported', async () => {
  const d = await inspect(body(`
    <h1>Yeni kayıt oluştur</h1>
    <p>Bu işlem için bilgileri giriniz.</p>
    <button>Save</button><button>Cancel</button><button>Delete</button>
    <a href="/x">Settings</a><a href="/y">Continue</a>`));
  const hit = (d.mixedLanguage || [])[0];
  assert.ok(hit, 'half the controls being English is the case this check exists for');
  assert.ok(hit.share >= 10, `minority share should be meaningful, got ${hit.share}%`);
});

test('the theme signature records colours in one spelling, not the browser\'s', async () => {
  // A real report showed the same white twice: `oklab(1 0 0 / 0.8)` on one
  // device and `oklab(0.999994 0.0000455677 0.0000200868 / 0.8)` on another.
  // That is 46 characters of noise per row, and this signature is compared
  // string against string to decide whether a colour survived the theme
  // switch — two spellings of one colour is a comparison waiting to be wrong.
  const d = await inspect(`
    <main style="background:oklab(0.999994 0.0000455678 0.0000200868 / 0.8)">
      <p style="color:oklch(0.55 0.2 250)">measured</p>
      <button style="color:rgb(255,255,255);background:#3b82f6">go</button>
    </main>`);
  const imza = d.themeSignature || [];
  assert.ok(imza.length, 'the signature must have entries to check');
  for (const x of imza) {
    for (const alan of ['color', 'bg', 'border']) {
      assert.doesNotMatch(x[alan] || '', /okla?[bc]\(/,
        `${alan} kept the browser's spelling: ${x[alan]}`);
      assert.match(x[alan] || '#000000', /^(#[0-9a-f]{6}( \d+%)?|)$/,
        `${alan} should be a hex colour, got ${JSON.stringify(x[alan])}`);
    }
  }
});

test('an icon font\'s ligature name is not the button\'s label', async () => {
  // Icon fonts put the icon's NAME in the text node and draw a glyph over it,
  // so innerText reads what nobody sees. Two apps in one round reported labels
  // like "add Şarkı" and "Operatör girişi arrow_fo" — half the label spent on
  // something invisible. For an icon-only control there is nothing left to
  // read, so the accessible name is the answer, and it is the better one.
  const d = await inspect(`
    <div style="padding:0">
      <button style="height:30px">
        <span class="material-symbols-outlined">add</span> Şarkı
      </button>
      <button style="height:30px" aria-label="Tema değiştir">
        <span class="material-symbols-outlined">light_mode</span>
      </button>
      <button style="height:30px">
        <i style="font-family:'Font Awesome 6 Free'">play_arrow</i> satır
      </button>
      <select style="height:30px"><option>A1</option><option>A2</option></select>
    </div>`);
  const etiketler = (d.smallTargets || []).map((x) => x.text);
  assert.ok(etiketler.length >= 3, `expected the short controls, got ${JSON.stringify(etiketler)}`);
  assert.ok(etiketler.includes('Şarkı'), `ligature not dropped: ${JSON.stringify(etiketler)}`);
  assert.ok(etiketler.includes('Tema değiştir'), `icon-only button should fall back to its accessible name: ${JSON.stringify(etiketler)}`);
  assert.ok(etiketler.includes('satır'), `font-family detection missed it: ${JSON.stringify(etiketler)}`);
  for (const e of etiketler) {
    assert.doesNotMatch(e, /add|light_mode|play_arrow/, `an icon name survived: ${e}`);
    assert.doesNotMatch(e, /\n/, `a label must be one line: ${JSON.stringify(e)}`);
  }
});
