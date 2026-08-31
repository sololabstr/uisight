#!/usr/bin/env node
/**
 * uisight CLI — one-shot mobile & responsive UI audits from your desktop.
 *
 * Usage:
 *   uisight <url> [options]
 *   uisight https://example.com --path /,/pricing --theme both --full
 *   uisight http://localhost:3000 --device iphone-15,pixel
 *   uisight https://example.com --live iphone-15    # opens a real window to browse by hand
 *
 * Output: outputs/<host>-<time>/  with PNGs + gallery.html + REPORT.md + report.json
 */

import { chromium, webkit, devices } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exec } from 'node:child_process';
import { platform } from 'node:os';

// --- Device profiles --------------------------------------------------------
// webkit = the real iOS Safari rendering engine (it does run on Windows).
// chromium = Android Chrome / WebView.
// mobile:false profiles are desktop — mobile-only rules (touch targets) are skipped there.
export const PROFILES = {
  'iphone-15': { engine: 'webkit', pw: 'iPhone 15 Pro', label: 'iPhone 15 Pro — iOS Safari engine', mobile: true },
  'iphone-se': { engine: 'webkit', pw: 'iPhone SE', label: 'iPhone SE — small screen (375px)', mobile: true },
  'pixel': { engine: 'chromium', pw: 'Pixel 7', label: 'Pixel 7 — Android Chrome', mobile: true },
  'galaxy': { engine: 'chromium', pw: 'Galaxy S9+', label: 'Galaxy S9+ — Android', mobile: true },
  'ipad': { engine: 'webkit', pw: 'iPad (gen 7)', label: 'iPad — tablet breakpoint', mobile: true },
  'desktop': { engine: 'chromium', pw: 'Desktop 1440', label: 'Desktop — 1440px', mobile: false },
  'laptop': { engine: 'chromium', pw: 'Laptop 1366', label: 'Laptop — 1366px', mobile: false },
};

// Fallback definitions for when the installed Playwright does not know a device name.
// isMobile/hasTouch live here; desktop profiles must keep touch OFF
// (touchscreen.tap throws in a context without hasTouch).
const FALLBACK_DEVICES = {
  'iPhone 15 Pro': { viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  'iPhone SE': { viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'Pixel 7': { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.6, isMobile: true, hasTouch: true },
  'Galaxy S9+': { viewport: { width: 320, height: 658 }, deviceScaleFactor: 4.5, isMobile: true, hasTouch: true },
  'iPad (gen 7)': { viewport: { width: 810, height: 1080 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  'Desktop 1440': { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  'Laptop 1366': { viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
};

const DEFAULT_DEVICES = ['iphone-15', 'pixel'];

// --- Arguments --------------------------------------------------------------
function parseArgs(argv) {
  const o = { url: null, device: DEFAULT_DEVICES, path: ['/'], theme: ['light'], full: false, live: null, settle: 1200, watch: 0, open: true, locale: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device' || a === '-d') o.device = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--locale') o.locale = argv[++i];
    else if (a === '--path' || a === '-p') o.path = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--theme' || a === '-t') o.theme = argv[++i] === 'both' ? ['light', 'dark'] : [argv[i]];
    else if (a === '--full') o.full = true;
    else if (a === '--live') o.live = argv[++i] || 'iphone-15';
    else if (a === '--wait') o.settle = Number(argv[++i]);
    else if (a === '--watch') o.watch = Number(argv[++i] || 10);
    else if (a === '--no-open') o.open = false;
    else if (a === '--help' || a === '-h') o.printHelp = true;
    else rest.push(a);
  }
  o.url = rest[0] || null;
  return o;
}

function printHelp() {
  console.log(`
uisight — mobile & responsive UI audits from your desktop

  uisight <url> [options]

Options
  --device, -d   comma-separated: ${Object.keys(PROFILES).join(', ')}   (default: iphone-15,pixel)
  --path,   -p   comma-separated routes, e.g. /,/pricing,/cart          (default: /)
  --theme,  -t   light | dark | both                                    (default: light)
  --full         full-page screenshots (not just the viewport)
  --wait <ms>    settle time after page load                            (default: 1200)
  --watch <s>    continuous mode: re-captures every <s> seconds, gallery auto-refreshes
  --locale <tag> pin a browser locale, e.g. en-US (default: this machine's)
  --no-open      do not auto-open the gallery in the browser
  --live <device>  opens a real window you can browse by hand (no automation)

Examples
  uisight https://example.com --path /,/pricing --theme both --full
  uisight http://localhost:3000 --device iphone-se,galaxy
  uisight https://example.com --live pixel

Live panel (human + AI watching the same session):  uisight-panel <url>
MCP server for Claude Code / Cursor / Antigravity:  uisight-mcp
`);
}

// --- Helpers ----------------------------------------------------------------
const slug = (s) => (s.replace(/^\//, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'home');

/**
 * npm installs the Playwright package but not the browsers it drives, so the very
 * first `npx uisight` on a clean machine used to die on a raw Playwright stack
 * trace. That is the worst possible first impression: it reads like the tool is
 * broken, and there is nothing in it telling you what to run.
 */
export function missingBrowser(e, engine) {
  const s = String(e);
  if (!/Executable doesn't exist|playwright install|browserType\.launch/i.test(s)) return e;
  return new Error(
    `${engine} is not installed yet.\n\n` +
    `  npx playwright install ${engine}\n\n` +
    `Playwright ships the driver over npm but downloads browsers separately (~150 MB, once).\n` +
    `For real iOS Safari on iPhone profiles, add webkit: npx playwright install chromium webkit`
  );
}

export function deviceSettings(pwName) {
  const d = devices[pwName];
  if (d) return d;
  return { ...FALLBACK_DEVICES[pwName] };
}

/** The checks that run inside the page (color/theme/buttons).
 *  With settings.mobile=false the touch-target (44px) rules are skipped — desktop inspection. */
export const INSPECTION_SCRIPT = (settings) => {
  const isMobile = !settings || settings.mobile !== false;
  const result = {
    horizontalOverflow: null, smallTargets: [], tinyText: [], imagesWithoutAlt: 0,
    invisibleText: [], lowContrast: [], buttonIssues: [], themeSignature: [],
  };

  // --- color helpers (WCAG) ---
  // Color parsing is left to the browser: oklab/oklch/lab/color-mix all work.
  // (Tailwind v4 emits gradient stops as oklab() — a plain regex used to miss them.)
  let _canvas = null;
  const parseColor = (text) => {
    if (!_canvas) { _canvas = document.createElement('canvas'); _canvas.width = 1; _canvas.height = 1; }
    const c = _canvas.getContext('2d', { willReadFrequently: true });
    c.clearRect(0, 0, 1, 1);
    c.fillStyle = 'rgba(0,0,0,0)';
    c.fillStyle = text;                 // invalid input keeps the previous value -> transparent
    c.fillRect(0, 0, 1, 1);
    const d = c.getImageData(0, 0, 1, 1).data;
    return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
  };
  const rgb = (s) => {
    if (!s) return null;
    const t = String(s).trim();
    if (t === 'none' || t === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const m = t.match(/^rgba?\(([^)]+)\)$/);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map((x) => parseFloat(x));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    try { return parseColor(t); } catch { return null; }
  };
  const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const contrast = (a, b) => {
    const l1 = luminance(a), l2 = luminance(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const blend = (on, bgc) => ({ // blend semi-transparent text with its background plane
    r: on.r * on.a + bgc.r * (1 - on.a), g: on.g * on.a + bgc.g * (1 - on.a), b: on.b * on.a + bgc.b * (1 - on.a), a: 1,
  });
  /** The element's REAL background plane: the first non-transparent ancestor. */
  const gradientColors = (bi) =>
    [...String(bi).matchAll(/(?:rgba?|oklab|oklch|lab|lch|hsla?|hwb|color)\([^()]*\)/g)]
      .map((m) => rgb(m[0])).filter(Boolean);

  /** The element's REAL backdrop: collects semi-transparent layers (bg-white/15 and
   *  friends) downward and alpha-BLENDS them — treating 15% white as solid white is
   *  how false alarms are born. A photo background (url) -> null: it cannot be measured
   *  from CSS, so say nothing rather than "invisible" (the hesapla case). */
  const effectiveBackground = (el) => {
    const layers = []; // ustten alta
    let base = null;
    let n = el;
    while (n && n !== document.documentElement) {
      const s = getComputedStyle(n);
      const bi = s.backgroundImage;
      if (bi && bi !== 'none') {
        if (bi.includes('url(')) return null; // a real image background — not measurable
        if (bi.includes('gradient')) {
          const d = gradientColors(bi);
          if (d.length) {
            const t = d.reduce((a, c) => ({ r: a.r + c.r, g: a.g + c.g, b: a.b + c.b, a: a.a + c.a }), { r: 0, g: 0, b: 0, a: 0 });
            layers.push({ r: t.r / d.length, g: t.g / d.length, b: t.b / d.length, a: t.a / d.length });
          }
        }
      }
      const bg = rgb(s.backgroundColor);
      if (bg && bg.a > 0.01) {
        if (bg.a >= 0.99) { base = bg; break; }
        layers.push(bg);
      }
      n = n.parentElement;
    }
    if (!base) {
      const root = rgb(getComputedStyle(document.body).backgroundColor);
      base = root && root.a >= 0.99 ? root : { r: 255, g: 255, b: 255, a: 1 };
    }
    let result = base;
    for (let i = layers.length - 1; i >= 0; i--) result = blend(layers[i], result);
    return result;
  };
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && parseFloat(st.opacity) > 0.05;
  };
  const describe = (el) => {
    const className = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).slice(0, 2).join('.');
    return `${el.tagName.toLowerCase()}${className ? '.' + className : ''}`;
  };
  const shortLabel = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 45);

  // --- 5) Color check: invisible text + low contrast ---
  // This catches the "I switched themes and the text vanished" case (the NFC lesson).
  // Do NOT narrow this to a tag list: text often lives inside a <div>, and a fixed
  // list skips it silently (the nfc-card-3d case). Walk every element instead — the
  // "does it own a text node" filter already drops the containers.
  const ATLA = /^(script|style|svg|path|noscript|template|br|iframe|canvas|video|audio|source)$/i;
  const textElements = [...document.querySelectorAll('body *')].filter((el) => !ATLA.test(el.tagName));
  for (const el of textElements) {
    if (!isVisible(el)) continue;
    const text = shortLabel(el);
    if (!text) continue;
    // only elements with their own text (so containers are not counted twice)
    const hasOwnText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasOwnText && el.tagName !== 'INPUT') continue;

    // Icon fonts: the content is a ligature name ("restaurant"), not real copy — the text-contrast rule does not apply.
    if (/material symbols|material icons|font ?awesome|icomoon|glyphicon|bootstrap-icons|remixicon|lucide|feather/i.test(getComputedStyle(el).fontFamily || '')) continue;

    // On inputs like range/checkbox, .value is never painted as text — it is a control widget.
    if (el.tagName === 'INPUT' && /^(range|checkbox|radio|color|file|hidden|submit|button|image)$/i.test(el.type || '')) continue;

    // Outlined text (text-stroke): visible through its stroke even with a transparent fill (the watermark pattern).
    const kontur = parseFloat(getComputedStyle(el).webkitTextStrokeWidth) || 0;
    if (kontur > 0) continue;

    const st = getComputedStyle(el);
    // Gradient text: the element's color is transparent, the real color lives in background-image.
    // Skipping it is WRONG — in a light theme the gradient can melt into the backdrop.
    // Measure the gradient's color stops instead and report the WORST one.
    const gradientHost = (n) => {
      let c = n;
      for (let i = 0; c && i < 3; i++, c = c.parentElement) {
        const s = getComputedStyle(c);
        if ((s.webkitBackgroundClip === 'text' || s.backgroundClip === 'text') && s.backgroundImage !== 'none') return c;
      }
      return null;
    };
    const fontSizeG = parseFloat(st.fontSize) || 16;
    const isBoldG = parseInt(st.fontWeight, 10) >= 700;
    const thresholdG = (fontSizeG >= 24 || (fontSizeG >= 18.66 && isBoldG)) ? 3 : 4.5;

    const gt = gradientHost(el);
    if (gt) {
      const stops = [...getComputedStyle(gt).backgroundImage.matchAll(/(?:rgba?|oklab|oklch|lab|lch|hsla?|hwb|color)\([^()]*\)/g)]
        .map((m) => rgb(m[0])).filter((r) => r && r.a > 0.02);
      if (!stops.length) continue;
      const bgG = effectiveBackground(gt.parentElement || gt);
      if (!bgG) continue; // photo background — not measurable
      let worst = Infinity, worstStop = null;
      for (const r of stops) {
        const k = contrast(r.a < 1 ? blend(r, bgG) : r, bgG);
        if (k < worst) { worst = k; worstStop = r; }
      }
      const recordG = {
        sel: describe(el) + ' (gradient text)', text, ratio: Math.round(worst * 100) / 100,
        color: `rgba(${Math.round(worstStop.r)}, ${Math.round(worstStop.g)}, ${Math.round(worstStop.b)}, ${worstStop.a})`,
        bg: `rgb(${Math.round(bgG.r)}, ${Math.round(bgG.g)}, ${Math.round(bgG.b)})`, fontSize: `${Math.round(fontSizeG)}px`,
      };
      if (worst < 1.6) result.invisibleText.push(recordG);
      else if (worst < thresholdG) result.lowContrast.push({ ...recordG, threshold: thresholdG });
      continue;
    }

    const on = rgb(st.color);
    if (!on) continue;
    const bgc = effectiveBackground(el);
    if (!bgc) continue; // photo background — not measurable, yanlis alarm uretme
    const blendedFg = on.a < 1 ? blend(on, bgc) : on;
    const k = contrast(blendedFg, bgc);
    const fs = parseFloat(st.fontSize) || 16;
    const isBold = parseInt(st.fontWeight, 10) >= 700;
    const isLargeText = fs >= 24 || (fs >= 18.66 && isBold);
    const threshold = isLargeText ? 3 : 4.5;
    const record = { sel: describe(el), text, ratio: Math.round(k * 100) / 100, color: st.color, bg: `rgb(${Math.round(bgc.r)}, ${Math.round(bgc.g)}, ${Math.round(bgc.b)})`, fontSize: `${Math.round(fs)}px` };
    if (k < 1.6) result.invisibleText.push(record);        // pratikte okunmuyor
    else if (k < threshold) result.lowContrast.push({ ...record, threshold });
  }

  // --- 6) Button check: contrast + size + distinguishability ---
  for (const el of document.querySelectorAll('button,[role="button"],a.btn,input[type="submit"],input[type="button"]')) {
    if (!isVisible(el)) continue;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    const on = rgb(st.color), bgc = effectiveBackground(el);
    const issues = [];
    if (on && bgc) { // bgc=null: photo background, contrast not measurable
      const k = contrast(on.a < 1 ? blend(on, bgc) : on, bgc);
      if (k < 3) issues.push(`text/bg kontrasti ${Math.round(k * 100) / 100}:1`);
    }
    if (isMobile && (r.height < 44 || r.width < 44)) issues.push(`size ${Math.round(r.width)}x${Math.round(r.height)} (<44px)`);
    const border = rgb(st.borderTopColor);
    const noBackground = !rgb(st.backgroundColor) || rgb(st.backgroundColor).a < 0.05;
    if (noBackground && (!border || border.a < 0.05) && el.tagName === 'BUTTON') issues.push('no background and no border — does not read as a button');
    if (el.disabled && parseFloat(st.opacity) > 0.85) issues.push('disabled but visually indistinguishable');
    if (issues.length) result.buttonIssues.push({ sel: describe(el), text: shortLabel(el) || '(no text)', issues });
  }

  // --- 7) Theme signature: the basis for comparing two themes ---
  const signatureTargets = [...document.querySelectorAll('body,header,nav,main,footer,button,a,input,[class*="card"],[class*="panel"],[class*="modal"],[class*="menu"]')].filter(isVisible).slice(0, 60);
  for (const el of signatureTargets) {
    const st = getComputedStyle(el);
    result.themeSignature.push({ sel: describe(el), text: shortLabel(el).slice(0, 24), color: st.color, bg: st.backgroundColor, border: st.borderTopColor });
  }

  result.invisibleText = result.invisibleText.slice(0, 12);
  result.lowContrast = result.lowContrast.slice(0, 12);
  result.buttonIssues = result.buttonIssues.slice(0, 12);

  // 1) Horizontal overflow — the most common mobile bug there is.
  const docWidth = document.documentElement.scrollWidth;
  const visibleWidth = window.innerWidth;
  if (docWidth > visibleWidth + 2) {
    const offenders = [];
    document.querySelectorAll('body *').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > visibleWidth + 2) {
        offenders.push({
          label: el.tagName.toLowerCase(),
          className: (el.className && String(el.className).slice(0, 60)) || '',
          right: Math.round(r.right),
        });
      }
    });
    result.horizontalOverflow = { pageWidth: docWidth, viewportWidth: visibleWidth, overflowing: offenders.slice(0, 8) };
  }

  // 2) Touch targets under 44px (Apple HIG / WCAG 2.5.5) — mobile profiles only.
  // For an inline TEXT link the width follows the copy, so only height is enforced.
  // Icon/textless targets are checked on both axes. 0.5px rounding slack (the 43.6 -> "44" case).
  if (isMobile) document.querySelectorAll('a, button, [role="button"], input, select, textarea').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const metinVar = !!(el.innerText || el.value || '').trim();
    const dar = !metinVar && r.width < 43.5;
    const kisa = r.height < 43.5;
    if (dar || kisa) {
      result.smallTargets.push({
        label: el.tagName.toLowerCase(),
        text: (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 40),
        size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      });
    }
  });

  // 3) Text under 12px — unreadable on a phone.
  document.querySelectorAll('p, span, li, a, button, label, td').forEach((el) => {
    if (!el.innerText || !el.innerText.trim()) return;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs && fs < 12) result.tinyText.push({ fontSize: `${fs}px`, text: el.innerText.trim().slice(0, 40) });
  });

  // 4) Images without alt text.
  document.querySelectorAll('img').forEach((el) => {
    if (!el.getAttribute('alt')) result.imagesWithoutAlt++;
  });

  result.smallTargets = result.smallTargets.slice(0, 12);
  result.tinyText = result.tinyText.slice(0, 8);
  return result;
};

// --- Live mode ---------------------------------------------------------------
async function canliAc(url, cihazAnahtar) {
  const p = PROFILES[cihazAnahtar];
  if (!p) throw new Error(`Bilinmeyen device: ${cihazAnahtar}`);
  const engine = p.engine === 'webkit' ? webkit : chromium;
  const browser = await engine.launch({ headless: false });
  const ctx = await browser.newContext({ ...deviceSettings(p.pw) });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`\n  ${p.label} penceresi acildi: ${url}`);
  console.log('  Browse away. Close the window or hit Ctrl+C when you are done.\n');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await browser.close();
}

// --- Main flow ---------------------------------------------------------------
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.printHelp || !o.url) { printHelp(); process.exit(o.url ? 0 : 1); }
  if (!/^https?:\/\//.test(o.url)) o.url = 'https://' + o.url;

  if (o.live) return canliAc(o.url, o.live);

  do {
    await tur(o);
    if (o.watch) {
      console.log(`  ... re-capturing in ${o.watch}s (Ctrl+C to stop)\n`);
      await new Promise((r) => setTimeout(r, o.watch * 1000));
    }
  } while (o.watch);
}

async function tur(o) {
  const host = new URL(o.url).host.replace(/[^a-z0-9.-]/gi, '_');
  const time = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  // Watch mode keeps one folder: the browser page stays on the same address and refreshes itself.
  // Outputs go to the USER's cwd — never into the package dir (npx installs land in node_modules).
  const outRoot = join(process.cwd(), 'uisight-outputs');
  const outDir = o.watch ? join(outRoot, `_watch-${host}`) : join(outRoot, `${host}-${time}`);
  mkdirSync(outDir, { recursive: true });

  const records = [];
  const engineCache = {};

  for (const key of o.device) {
    const p = PROFILES[key];
    if (!p) { console.log(`  ! unknown device skipped: ${key} (known: ${Object.keys(PROFILES).join(', ')})`); continue; }

    // If WebKit will not launch on this machine (the missing-DLL case on Windows), fall back to Chromium;
    // layout/color checks keep running; the report states the engine plainly.
    let engineUsed = p.engine;
    if (!engineCache[engineUsed]) {
      try {
        engineCache[engineUsed] = await (engineUsed === 'webkit' ? webkit : chromium).launch();
      } catch (e) {
        if (engineUsed !== 'webkit') throw missingBrowser(e, 'chromium');
        console.log(`  ! webkit would not launch (${String(e).split('\n')[0].slice(0, 60)}) -> falling back to chromium`);
        engineUsed = 'chromium-fallback';
        try {
          if (!engineCache[engineUsed]) engineCache[engineUsed] = await chromium.launch();
        } catch (e2) { throw missingBrowser(e2, 'chromium'); }
      }
    }
    const browser = engineCache[engineUsed];
    const engineName = engineUsed === 'chromium-fallback' ? 'chromium (no webkit — iOS-specific bugs WILL be missed)' : engineUsed;

    for (const theme of o.theme) {
      // No locale is forced: the page renders the way this machine would render it.
      // A hard-coded locale used to ship here, so every user in the world audited
      // their app in Turkish — language switchers and date formats included.
      const ctx = await browser.newContext({ ...deviceSettings(p.pw), colorScheme: theme, ...(o.locale ? { locale: o.locale } : {}) });
      const page = await ctx.newPage();

      for (const path of o.path) {
        const target = new URL(path, o.url).toString();
        const record = { device: key, label: p.label, engine: engineName, theme, path, url: target, console: [], network: [], error: null };

        page.on('pageerror', (e) => record.console.push({ type: 'js-error', message: String(e).slice(0, 200) }));
        page.on('console', (m) => { if (m.type() === 'error') record.console.push({ type: 'console', message: m.text().slice(0, 200) }); });
        page.on('response', (r) => { if (r.status() >= 400) record.network.push({ status: r.status(), url: r.url().slice(0, 120) }); });

        try {
          // One retry: edge networks intermittently stall a single request in a burst run.
          let response;
          try {
            response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
          } catch {
            response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
          }
          record.state = response ? response.status() : null;
          await page.waitForTimeout(o.settle);
          record.baslik = await page.title();
          record.inspection = await page.evaluate(INSPECTION_SCRIPT, { mobile: p.mobile !== false });

          const ad = `${slug(path)}__${key}__${theme}.png`;
          const png = join(outDir, ad);
          // scale:'css' saves in CSS pixels: smaller files, easier to read.
          await page.screenshot({ path: png, fullPage: o.full, scale: 'css' });
          record.image = png;
          console.log(`  ok  ${key}/${theme}  ${path}  -> ${ad}`);
        } catch (e) {
          record.error = String(e).slice(0, 300);
          console.log(`  ERROR ${key}/${theme} ${path}: ${record.error.split('\n')[0]}`);
        }
        records.push(record);
      }
      await ctx.close();
    }
  }

  for (const t of Object.values(engineCache)) await t.close();

  // --- Report ---
  const lines = [];
  lines.push(`# uisight report — ${o.url}`);
  lines.push('');
  lines.push(`- Date: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);
  lines.push(`- Devices: ${o.device.join(', ')} | Themes: ${o.theme.join(', ')} | Paths: ${o.path.join(', ')}`);
  lines.push(`- Output: ${outDir}`);
  lines.push('');

  let findingCount = 0;
  for (const k of records) {
    lines.push(`## ${k.label} · ${k.theme} · ${k.path}`);
    if (k.error) { lines.push(`- **PAGE FAILED TO LOAD:** ${k.error}`); findingCount++; lines.push(''); continue; }
    lines.push(`- Image: \`${k.image}\``);
    lines.push(`- HTTP ${k.state} · title: ${k.baslik}`);

    const d = k.inspection || {};
    if (d.horizontalOverflow) {
      findingCount++;
      lines.push(`- 🔴 **HORIZONTAL OVERFLOW**: page ${d.horizontalOverflow.pageWidth}px / viewport ${d.horizontalOverflow.viewportWidth}px`);
      for (const s of d.horizontalOverflow.overflowing) lines.push(`  - \`<${s.label} class="${s.className}">\` right edge ${s.right}px`);
    }
    if (d.smallTargets?.length) {
      findingCount++;
      lines.push(`- 🟡 **touch targets below 44px** (${d.smallTargets.length}):`);
      for (const s of d.smallTargets) lines.push(`  - \`${s.label}\` ${s.size} — "${s.text}"`);
    }
    if (d.tinyText?.length) {
      findingCount++;
      lines.push(`- 🟡 **text below 12px** (${d.tinyText.length}): ` + d.tinyText.map((m) => `${m.fontSize} "${m.text}"`).join(' · '));
    }
    if (d.invisibleText?.length) {
      findingCount++;
      lines.push(`- 🔴 **INVISIBLE TEXT** (contrast <1.6:1 — practically unreadable, ${d.invisibleText.length}):`);
      for (const s of d.invisibleText) lines.push(`  - \`${s.sel}\` ${s.ratio}:1 — text ${s.color} / bg ${s.bg} — "${s.text}"`);
    }
    if (d.lowContrast?.length) {
      findingCount++;
      lines.push(`- 🟡 **Low contrast** (below WCAG AA, ${d.lowContrast.length}):`);
      for (const s of d.lowContrast) lines.push(`  - \`${s.sel}\` ${s.ratio}:1 (threshold ${s.threshold}) ${s.fontSize} — "${s.text}"`);
    }
    if (d.buttonIssues?.length) {
      findingCount++;
      lines.push(`- 🟠 **Button issues** (${d.buttonIssues.length}):`);
      for (const s of d.buttonIssues) lines.push(`  - \`${s.sel}\` "${s.text}" → ${s.issues.join(' · ')}`);
    }
    if (d.imagesWithoutAlt) lines.push(`- ⚪ images without alt: ${d.imagesWithoutAlt}`);
    if (k.console.length) { findingCount++; lines.push(`- 🔴 **Console/JS errors** (${k.console.length}):`); for (const c of k.console.slice(0, 5)) lines.push(`  - ${c.type}: ${c.message}`); }
    if (k.network.length) { findingCount++; lines.push(`- 🔴 **Failed requests** (${k.network.length}):`); for (const a of k.network.slice(0, 5)) lines.push(`  - ${a.status} ${a.url}`); }
    // A "clean" claim has to cover EVERY finding type: when invisible text / contrast /
    // button issues were left out, the report printed "clean" right under its own findings.
    const anyFinding = d.horizontalOverflow || d.smallTargets?.length || d.tinyText?.length
      || d.invisibleText?.length || d.lowContrast?.length || d.buttonIssues?.length
      || k.console.length || k.network.length;
    if (!anyFinding) lines.push('- ✅ automated checks clean (still eyeball the image)');
    lines.push('');
  }
  // --- Theme comparison: identical colors in light and dark mean the toggle is not wired up ---
  if (o.theme.length > 1) {
    lines.push('## Theme comparison (light ↔ dark)');
    let temaBulgu = 0;
    for (const device of o.device) {
      for (const path of o.path) {
        const l = records.find((k) => k.device === device && k.theme === 'light' && k.path === path);
        const d = records.find((k) => k.device === device && k.theme === 'dark' && k.path === path);
        if (!l?.inspection?.themeSignature || !d?.inspection?.themeSignature) continue;

        const darkMap = new Map(d.inspection.themeSignature.map((x, i) => [`${i}|${x.sel}`, x]));
        const frozen = [];
        l.inspection.themeSignature.forEach((x, i) => {
          const es = darkMap.get(`${i}|${x.sel}`);
          if (!es) return;
          const zeminSaydam = /rgba\([^)]*,\s*0\)/.test(x.bg);
          if (x.color === es.color && x.bg === es.bg && !zeminSaydam) {
            frozen.push({ sel: x.sel, text: x.text, color: x.color, bg: x.bg });
          }
        });

        if (frozen.length) {
          temaBulgu++;
          lines.push(`- **${device} · ${path}** — ${frozen.length} elements IDENTICAL in both themes (likely hard-coded colors):`);
          for (const s of frozen.slice(0, 10)) lines.push(`  - \`${s.sel}\` "${s.text}" — text ${s.color} / bg ${s.bg}`);
        }
      }
    }
    if (!temaBulgu) lines.push('- No theme-frozen elements found.');
    lines.push('');
  }

  lines.push('---');
  lines.push(`Records with automated findings: ${findingCount}/${records.length}. Automated checks CANNOT see design mistakes — eyeball the PNGs.`);

  const reportPath = join(outDir, 'REPORT.md');
  writeFileSync(reportPath, lines.join('\n'), 'utf8');
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(records, null, 2), 'utf8');

  const galleryPath = join(outDir, 'gallery.html');
  writeFileSync(galleryPath, buildGallery(records, o), 'utf8');

  console.log(`\n  Gallery: ${galleryPath}`);
  console.log(`  Report : ${reportPath}\n`);

  if (o.open && !global.__opened) {
    global.__opened = true; // watch modunda her turda yeni sekme acma
    // Platform-aware open: `start` only exists on Windows (macOS: open, Linux: xdg-open).
    const p = platform();
    const command = p === 'win32' ? `start "" "${galleryPath}"` : p === 'darwin' ? `open "${galleryPath}"` : `xdg-open "${galleryPath}"`;
    exec(command, p === 'win32' ? { shell: 'cmd.exe' } : {}, (e) => {
      if (e) console.error(`  ! could not open gallery (${p}) — open manually: ${galleryPath}`);
    });
  }
}

/** One page, Android Studio preview style: numbered cards side by side. */
function buildGallery(records, o) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const cards = records.map((k, i) => {
    const no = i + 1;
    const d = k.inspection || {};
    const badges = [];
    if (k.error) badges.push(['crit', 'PAGE FAILED']);
    if (d.horizontalOverflow) badges.push(['crit', 'overflow']);
    if (d.invisibleText?.length) badges.push(['crit', `invisible text ${d.invisibleText.length}`]);
    if (k.console?.length) badges.push(['crit', `JS errors ${k.console.length}`]);
    if (k.network?.length) badges.push(['crit', `failed requests ${k.network.length}`]);
    if (d.buttonIssues?.length) badges.push(['warn', `buttons ${d.buttonIssues.length}`]);
    if (d.lowContrast?.length) badges.push(['warn', `contrast ${d.lowContrast.length}`]);
    if (d.smallTargets?.length) badges.push(['warn', `under 44px ${d.smallTargets.length}`]);
    if (d.tinyText?.length) badges.push(['info', `under 12px ${d.tinyText.length}`]);
    if (!badges.length) badges.push(['ok', 'automated checks clean']);

    const details = [];
    for (const s of (d.invisibleText || [])) details.push(`<li class="k">INVISIBLE ${s.ratio}:1 — <code>${esc(s.sel)}</code> "${esc(s.text)}"</li>`);
    for (const s of (d.buttonIssues || [])) details.push(`<li class="u">BUTTON <code>${esc(s.sel)}</code> "${esc(s.text)}" → ${esc(s.issues.join(' · '))}</li>`);
    for (const s of (d.lowContrast || []).slice(0, 6)) details.push(`<li class="u">contrast ${s.ratio}:1 (threshold ${s.threshold}) — "${esc(s.text)}"</li>`);
    for (const s of (d.smallTargets || []).slice(0, 6)) details.push(`<li class="u">${esc(s.size)} — "${esc(s.text)}"</li>`);
    if (d.horizontalOverflow) details.push(`<li class="k">overflow: page ${d.horizontalOverflow.pageWidth}px / viewport ${d.horizontalOverflow.viewportWidth}px</li>`);
    for (const c of (k.console || []).slice(0, 3)) details.push(`<li class="k">${esc(c.type)}: ${esc(c.message)}</li>`);
    for (const a of (k.network || []).slice(0, 3)) details.push(`<li class="k">HTTP ${a.status} — ${esc(a.url)}</li>`);

    const image = k.image
      ? `<img src="${esc(basename(k.image))}" alt="${esc(k.label)}" loading="lazy">`
      : `<div class="none">no image<br><small>${esc(k.error || '')}</small></div>`;

    return `<article class="kart">
  <header><span class="no">${no}</span><div><b>${esc(k.label)}</b><br><small>${esc(k.theme)} · ${esc(k.path)} · ${esc(k.engine)}</small></div></header>
  <div class="ekran">${image}</div>
  <div class="rozetler">${badges.map(([t, m]) => `<span class="rz ${t}">${esc(m)}</span>`).join('')}</div>
  ${details.length ? `<ul class="details">${details.join('')}</ul>` : ''}
</article>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>uisight — ${esc(o.url)}</title>
${o.watch ? `<meta http-equiv="refresh" content="${o.watch}">` : ''}
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#1e1f22; color:#dfe1e5; font:14px/1.5 "Segoe UI",system-ui,sans-serif; }
  .ust { position:sticky; top:0; z-index:5; background:#2b2d30; border-bottom:1px solid #393b40; padding:12px 20px; display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
  .ust h1 { font-size:15px; margin:0; font-weight:600; }
  .ust a { color:#6ea8fe; text-decoration:none; }
  .ust .info { color:#9da0a8; font-size:12px; }
  .live { background:#2e7d32; color:#fff; padding:2px 8px; border-radius:10px; font-size:11px; }
  .izgara { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:20px; padding:20px; align-items:start; }
  .kart { background:#2b2d30; border:1px solid #393b40; border-radius:10px; overflow:hidden; }
  .kart header { display:flex; gap:10px; align-items:center; padding:10px 12px; border-bottom:1px solid #393b40; }
  .kart header small { color:#9da0a8; font-size:11px; }
  .no { display:grid; place-items:center; min-width:26px; height:26px; border-radius:50%; background:#4c6fd6; color:#fff; font-weight:700; font-size:13px; }
  .ekran { background:#111214; display:grid; place-items:center; padding:12px; }
  .ekran img { max-width:100%; border-radius:6px; border:1px solid #45474d; display:block; cursor:zoom-in; }
  .none { color:#f28b82; padding:40px 12px; text-align:center; }
  .rozetler { display:flex; flex-wrap:wrap; gap:6px; padding:10px 12px 0; }
  .rz { font-size:11px; padding:2px 8px; border-radius:10px; font-weight:600; }
  .rz.crit { background:#5c2b2b; color:#ffb4ab; }
  .rz.warn  { background:#5a4a1f; color:#ffd77a; }
  .rz.info  { background:#33383e; color:#b9bcc2; }
  .rz.ok     { background:#264d2c; color:#9ae6a4; }
  .details { margin:10px 12px 12px; padding-left:18px; font-size:12px; color:#c3c6cc; }
  .details li { margin:3px 0; }
  .details .k { color:#ffb4ab; }
  .details .u { color:#ffd77a; }
  code { background:#1e1f22; padding:1px 4px; border-radius:3px; font-size:11px; }
  dialog { border:none; background:transparent; max-width:96vw; max-height:96vh; padding:0; }
  dialog img { max-width:96vw; max-height:96vh; border-radius:8px; }
  dialog::backdrop { background:rgba(0,0,0,.85); }
</style></head><body>
<div class="ust">
  <h1>uisight</h1>
  <a href="${esc(o.url)}" target="_blank">${esc(o.url)}</a>
  <span class="info">${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC · ${records.length} previews</span>
  ${o.watch ? `<span class="live">LIVE — refreshes every ${o.watch}s</span>` : ''}
  <span class="info">Spot a problem? Tell your AI the <b>card number</b> (e.g. "the header collides on card 3").</span>
</div>
<div class="izgara">
${cards}
</div>
<dialog id="zoom"><img id="zoomImage" alt=""></dialog>
<script>
  const dlg = document.getElementById('zoom'), img = document.getElementById('zoomImage');
  document.querySelectorAll('.ekran img').forEach((el) => el.addEventListener('click', () => { img.src = el.src; dlg.showModal(); }));
  dlg.addEventListener('click', () => dlg.close());
</script>
</body></html>`;
}

// Only run as a CLI when invoked directly — server.mjs imports this file.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
