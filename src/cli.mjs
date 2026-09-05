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
import { createRequire } from 'node:module';
import { offerInstall } from './install-browser.mjs';
import { checkForUpdate, currentVersion } from './update-check.mjs';

// --- Device profiles --------------------------------------------------------
// webkit = the real iOS Safari rendering engine (it does run on Windows).
// chromium = Android Chrome / WebView.
// mobile:false profiles are desktop — mobile-only rules (touch targets) are skipped there.
/**
 * Cihaz profilleri.
 *
 * 🔴 `pw` alani Playwright'in cihaz adi. Disaridan cagiran biri `prof.playwright`
 * yazdi, `devices[undefined]` oldu ve Playwright sessizce 1280x720 MASAUSTU
 * viewport'una dustu — 12 sayfa mobil sanilip masaustunde olculdu, tek uyari
 * cikmadan. Hata ancak ekran goruntusune gozle bakinca anlasildi.
 *
 * O yuzden ikisi de kabul ediliyor ve `deviceSettings` bilmedigi ada FIRLATIYOR.
 * Sessizce yanlis olcmek, hic olcmemekten kotudur.
 */
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
  const o = { url: null, device: DEFAULT_DEVICES, path: ['/'], theme: ['light'], full: false, live: null, settle: 1200, watch: 0, open: true, locale: null, timeout: 30000, maxRequests: 0 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--device' || a === '-d') o.device = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--locale') o.locale = argv[++i];
    else if (a === '--path' || a === '-p') o.path = argv[++i].split(',').map((s) => s.trim());
    else if (a === '--theme' || a === '-t') o.theme = argv[++i] === 'both' ? ['light', 'dark'] : [argv[i]];
    else if (a === '--full') o.full = true;
    else if (a === '--live') o.live = argv[++i] || 'iphone-15';
    // Sabit 30 sn bir kosumu tamamen bosa cikardi: agir bir Next.js uygulamasinin
    // ILK derlemesi bunu asti ve 72 ekranin hepsi TimeoutError ile bos dondu.
    else if (a === '--timeout') o.timeout = Math.max(5000, Number(argv[++i]) || 30000);
    // Olculdu: TEK sayfa yuklemesi ayni anda 20 istek ucuruyor — bu tarayicinin
    // kendi baglanti havuzu, bu aracin es zamanliligi degil (cihaz/tema/path
    // donguleri zaten sirali). Havuzu kucuk bir arka uc (ornegin Prisma
    // connection_limit=1) bu 20 istegi tek baglantida kuyruga alip kilitlenebilir;
    // bir kullanicinin yerel sunucusu iki kez tamamen durdu.
    else if (a === '--max-requests') o.maxRequests = Math.max(1, Number(argv[++i]) || 0);
    else if (a === '--wait') o.settle = Number(argv[++i]);
    else if (a === '--watch') o.watch = Number(argv[++i] || 10);
    else if (a === '--no-open') o.open = false;
    else if (a === '--help' || a === '-h') o.printHelp = true;
    else rest.push(a);
  }
  o.url = rest.find((x) => !x.startsWith('-')) || null;
  // A flag this does not know used to be dropped without a word. `--desktop
  // desktop` is a real flag -- of uisight-panel, not of this -- so a run that
  // asked for a desktop profile quietly produced two phones and a report that
  // did not mention the omission.
  o.unknownFlags = rest.filter((x) => x.startsWith('-'));
  return o;
}

// Flags that exist, but on the other command. Worth naming: the mistake is
// copying a line from the panel's help, not inventing a flag.
export const PANEL_ONLY_FLAGS = new Set(['--desktop', '--single', '--port', '--narrow']);

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
  --timeout <ms> per-page load budget; raise it for a cold dev server   (default: 30000)
  --max-requests <n>  cap in-flight requests; a page fires ~20 at once and a
                 backend with a small connection pool can stall on that
  --version, -v  print the version and exit
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
  // Pin the version. Playwright ties each release to one browser build, so a
  // bare `npx playwright install` fetches whatever is newest and can leave the
  // exact gap it was meant to close — which is how a machine with three
  // chromium builds still reported none.
  let pinned = 'playwright';
  try {
    // Resolved, not guessed at a path: under npx, playwright is hoisted beside
    // uisight rather than nested under it.
    const { version } = createRequire(import.meta.url)('playwright/package.json');
    pinned = `playwright@${version}`;
  } catch {}
  const hata = new Error(
    `${engine} is not installed yet.\n\n` +
    `  npx ${pinned} install ${engine}\n\n` +
    `Playwright ships the driver over npm but downloads browsers separately (~150 MB, once).\n` +
    `For real iOS Safari on iPhone profiles, add webkit: npx ${pinned} install chromium webkit`
  );
  // Someone whose only problem is "run one command" should not have to read a
  // stack trace to find it.
  hata.hint = true;
  return hata;
}

/**
 * Detay listeleri kapali (token maliyeti) ama SAYI asla gizlenmez.
 * "12" ile "12 / 34" arasindaki fark, kullanicinin ilerledigini gorup
 * gormemesidir: 12 bulguyu duzeltip tekrar "12" gormek, hicbir sey
 * degismemis gibi okunur.
 */
const kac = (d, key) => {
  const toplam = d.totals?.[key] ?? (d[key] || []).length;
  const gosterilen = (d[key] || []).length;
  return toplam > gosterilen ? `${gosterilen} / ${toplam}` : String(toplam);
};

export function deviceSettings(pwName) {
  const d = devices[pwName];
  if (d) return d;
  const f = FALLBACK_DEVICES[pwName];
  if (f) return { ...f };
  // Bilinmeyen ad SESSIZCE bos nesne dondurmemeli: Playwright onu "ayar yok"
  // sayip masaustune duser ve cagiran mobil olctugunu SANIR. Bir kullanici tam
  // olarak boyle 12 sayfayi yanlis viewport'ta olctu, tek uyari almadan.
  throw new Error(
    `unknown device "${pwName}". Pass a Playwright device name, or use profileSettings('iphone-15') `
    + `with a profile key: ${Object.keys(PROFILES).join(', ')}`,
  );
}

/**
 * Profil ANAHTARINDAN ayarlar — `devices[...]` sozlugune hic dokunmadan.
 *
 * Disaridan cagiranin `PROFILES['iphone-15'].pw` alanini bilmesi gerekmesin diye
 * var: o alani `playwright` sanan biri sessizce masaustunde olcmustu.
 */
export function profileSettings(key) {
  const p = PROFILES[key];
  if (!p) throw new Error(`unknown profile "${key}". Have: ${Object.keys(PROFILES).join(', ')}`);
  return { ...deviceSettings(p.pw), _profile: key, _mobile: p.mobile !== false };
}

/** The checks that run inside the page (color/theme/buttons).
 *  With settings.mobile=false the touch-target (44px) rules are skipped — desktop inspection. */
/**
 * Records permission requests, installed before any page code runs.
 *
 * A permission asked for with no explanation is accepted by well under half the
 * people who see it, and the fix is never technical — it is showing why first.
 * What can be measured is the tell: the request firing during load, before the
 * person has done anything that would explain it.
 *
 * Wrapping is deliberately transparent: the real API is still called, so the
 * page behaves exactly as it would unobserved.
 */
export const PERMISSION_HOOKS = () => {
  const log = [];
  Object.defineProperty(window, '__uisightPermissions', { get: () => log, configurable: true });

  // A request is "explained" if the person did something first. Load-time
  // requests have no gesture behind them by definition.
  let gestured = false;
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, () => { gestured = true; }, { capture: true, passive: true });
  }
  const note = (api) => log.push({ api, gesture: gestured, atMs: Math.round(performance.now()) });

  try {
    const real = Notification && Notification.requestPermission;
    if (real) {
      Notification.requestPermission = function (...a) { note('notifications'); return real.apply(this, a); };
    }
  } catch { /* no Notification in this context */ }

  try {
    const geo = navigator.geolocation;
    if (geo) {
      for (const m of ['getCurrentPosition', 'watchPosition']) {
        const real = geo[m];
        if (real) geo[m] = function (...a) { note('location'); return real.apply(this, a); };
      }
    }
  } catch { /* no geolocation */ }

  try {
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const real = md.getUserMedia;
      md.getUserMedia = function (c, ...a) {
        note(c && c.video ? 'camera' : 'microphone');
        return real.call(this, c, ...a);
      };
    }
  } catch { /* no mediaDevices */ }
};

export const INSPECTION_SCRIPT = (settings) => {
  const isMobile = !settings || settings.mobile !== false;
  const result = {
    horizontalOverflow: null, smallTargets: [], tinyText: [], imagesWithoutAlt: 0,
    coveredControls: [], clippedText: [], coveredByFixed: [],
    sameLookingActions: [], darkModeLightPatches: [], mixedLanguage: [], usDates: [],
    unsafeArea: [], genericErrors: [], destructiveWithoutConfirm: [], eagerPermissions: [],
    clippedContainer: [], loadingButEmpty: [], textUnderControl: [],
    invisibleText: [], lowContrast: [], buttonIssues: [], themeSignature: [],
  };

  // Gelistirme aracinin kendi katmani uygulamanin parcasi degil ve PROD'da yok.
  // Next.js'in dev dugmesi bir sayfada "ortulmus kontrol" olarak raporlandi;
  // sahada kullanicinin gormedigi bir seyi bulgu saymak, aracin guvenilirligini
  // ucuza harciyor.
  /**
   * Dekoratif mi? Ekranda GORUNEN ama kullanicinin dokunamadigi sey bulgu degildir.
   *
   * Bir karsilama sayfasindaki telefon maketinin icinde sahte bir alt menu gercek
   * <button> olarak duruyordu: her kosuda, her cihazda, her temada "44px alti"
   * sayildi — sayfa basina 4-8 bulgu, tamami resim.
   *
   * `pointer-events:none` zinciri tek basina yetmez; maket bunlari tasimiyordu.
   * O yuzden ayni kapi uygulamaya verilecek dogru ogudun de kendisi: dekoratif
   * bir maket `aria-hidden` ya da `inert` olmali.
   */
  const dekoratif = (el) => {
    if (el.closest?.('[aria-hidden="true"], [inert]')) return true;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).pointerEvents === 'none') return true;
    }
    return false;
  };

  const gelistirmeKatmani = (el) => !!el.closest?.(
    'nextjs-portal, #__next-build-watcher, [data-nextjs-toast], vite-error-overlay, #vite-error-overlay, [data-vite-dev-id]',
  );

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
  /**
   * Rengin kisa ve DOGRU yazimi.
   *
   * Iki sebep var. Biri maliyet: `oklab(0.999994 0.0000455677 0.0000200868 / 0.8)`
   * 46 karakter, `#ffffff 80%` 11 — ve bu metin sohbette kalip her turda yeniden
   * gonderiliyor. Digeri dogruluk: kontrast orani ZATEN bu sRGB degerinden
   * hesaplaniyor, dolayisiyla ham oklab'i raporlamak olculmeyen bir sayiyi
   * gostermek olur.
   */
  const hex = (c) => {
    if (!c) return 'yok';
    const iki = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
    const h = `#${iki(c.r)}${iki(c.g)}${iki(c.b)}`;
    return c.a != null && c.a < 0.999 ? `${h} ${Math.round(c.a * 100)}%` : h;
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

    // Emoji paint themselves. The element's `color` says nothing about how a
    // ⚖️ or ✅ actually looks, so measuring it produces a contrast number for a
    // colour that was never used. Icon fonts were already exempt; emoji are the
    // same problem wearing a different hat.
    const gorunenMetin = (el.innerText || '').trim();
    if (gorunenMetin && !/[\p{L}\p{N}]/u.test(gorunenMetin)) continue;   // harf/rakam yok = simge

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
        color: hex(worstStop), bg: hex(bgG), fontSize: `${Math.round(fontSizeG)}px`,
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
    const record = { sel: describe(el), text, ratio: Math.round(k * 100) / 100, color: hex(on), bg: hex(bgc), fontSize: `${Math.round(fs)}px` };
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
    // 44px kurali BURADA DEGIL: smallTargets zaten ayni ogeleri ayni olcutle
    // sayiyor. Iki yerde raporlamak hem her turda tekrar gonderilen metni
    // buyutuyor hem de raporu oldugundan kotu gosteriyordu — olculen bir sayfada
    // "8 buton sorunu + 12 dokunma hedefi" 20 sorun gibi okunuyordu, 12 vardi.
    const border = rgb(st.borderTopColor);
    const noBackground = !rgb(st.backgroundColor) || rgb(st.backgroundColor).a < 0.05;
    // Bir sekme cubugundaki sekmenin arka plani ve kenarligi OLMAZ; secili olani
    // alt cizgiyle belli edilir. Bu kural orada oterse, dogru yapilmis her sekme
    // cubugu bulgu uretir — ve boyle bir kontrol okunmaz hale gelir.
    const sekmeIcinde = el.closest('nav, [role="tablist"], [role="navigation"], [role="menubar"]');
    if (noBackground && (!border || border.a < 0.05) && el.tagName === 'BUTTON' && !sekmeIcinde) {
      issues.push('no background and no border — does not read as a button');
    }
    // Pasiflik yalniz saydamlikla anlatilmaz. Bir uygulama zemini zinc-900'den
    // zinc-200'e aldi, metni zinc-600 yapti, `cursor: not-allowed` ve aciklayici
    // bir `title` ekledi — kontrol yine "ayirt edilemez" dedi, cunku sadece
    // opacity'ye bakiyordu. Duzeltmeyi gormeyen kontrol, duzeltmeyi caydiriyor.
    if (el.disabled) {
      const solgun = parseFloat(st.opacity) <= 0.85;
      const imlec = /not-allowed|default/.test(st.cursor);
      const anlatiyor = el.getAttribute('title') || el.getAttribute('aria-describedby');
      // Etkin bir kardesle ayni zemini paylasiyor mu? Ayni ise gorsel fark yok.
      let zeminFarkli = false;
      const kardes = [...(el.parentElement?.children || [])]
        .find((n) => n !== el && n.tagName === el.tagName && !n.disabled);
      if (kardes) {
        const a = effectiveBackground(el), b = effectiveBackground(kardes);
        zeminFarkli = !!(a && b) && (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b)) > 24;
      }
      if (!solgun && !imlec && !anlatiyor && !zeminFarkli) {
        issues.push('disabled but visually indistinguishable');
      }
    }
    if (issues.length) result.buttonIssues.push({ sel: describe(el), text: shortLabel(el) || '(no text)', issues });
  }

  // --- 7) Theme signature: the basis for comparing two themes ---
  const signatureTargets = [...document.querySelectorAll('body,header,nav,main,footer,button,a,input,[class*="card"],[class*="panel"],[class*="modal"],[class*="menu"]')].filter(isVisible).slice(0, 60);
  for (const el of signatureTargets) {
    const st = getComputedStyle(el);
    result.themeSignature.push({ sel: describe(el), text: shortLabel(el).slice(0, 24), color: st.color, bg: st.backgroundColor, border: st.borderTopColor });
  }

  // Lists are capped so a bad page does not flood the report (and the agent's
  // context). But capping the list while ALSO printing its length hides how bad
  // the page is: a site with 34 contrast failures reported "12", you fixed all
  // 12, re-ran, and saw "12" again — nothing looked like it had changed. So keep
  // the cap on the detail, and always carry the true count separately.
  result.totals = {};
  const capAt = (key, n) => {
    result.totals[key] = result[key].length;
    result[key] = result[key].slice(0, n);
  };
  capAt('invisibleText', 12);
  capAt('lowContrast', 12);
  capAt('buttonIssues', 12);

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
      if (dekoratif(el)) return;
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

  // 5) A control that something else is sitting on top of.
  //
  // This is the failure a person spots instantly and no contrast or size rule can
  // see: a floating action button parked on the corner of the primary CTA, a
  // toast covering "Save". An earlier version of this check only sampled the
  // element's CENTRE and was blind to exactly that — a FAB covering the right end
  // of a wide button leaves the centre clear. So sample a grid, edge to edge.
  document.querySelectorAll('button, a[href], [role="button"], input[type="submit"]').forEach((el) => {
    if (!isVisible(el) || gelistirmeKatmani(el) || dekoratif(el)) return;

    // An inline link that wraps onto two lines has a bounding BOX spanning both
    // lines AND the gap between them — a rectangle covering text that belongs to
    // neither line. Measured on a real page: a "Terms of Use" link came back "13%
    // covered" by the link beside it, purely because their boxes overlap in space
    // neither of them paints. getClientRects() gives the actual line fragments;
    // the widest one is the piece worth measuring.
    const parcalar = [...el.getClientRects()].filter((x) => x.width > 0 && x.height > 0);
    const cokSatirli = parcalar.length > 1;
    if (cokSatirli && getComputedStyle(el).display.startsWith('inline')) {
      // Inline ve cok satirli: kutu yalan soyluyor. En genis satir parcasini al.
      parcalar.sort((a, b) => b.width - a.width);
    }
    const r = cokSatirli && getComputedStyle(el).display.startsWith('inline')
      ? parcalar[0]
      : el.getBoundingClientRect();
    if (!r || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
    const st2 = getComputedStyle(el);

    const cols = Math.min(9, Math.max(5, Math.round(r.width / 60)));
    const covers = new Map();

    // A round button's bounding BOX has corners the button does not paint. Sampling
    // them returns whatever is behind and reads as "this control is covered" — a
    // floating chat button over body text reported ~27% covered, which is almost
    // exactly the corner area a circle leaves in its square (1 - pi/4 = 21%).
    // So for pill/circle shapes, only sample inside the inscribed ellipse.
    const radius = parseFloat(st2.borderRadius) || 0;
    const roundish = st2.borderRadius.includes('%')
      ? parseFloat(st2.borderRadius) >= 40
      : radius >= Math.min(r.width, r.height) * 0.4;
    const icerde = (px, py) => {
      if (!roundish) return true;
      const nx = (px - (r.left + r.width / 2)) / (r.width / 2);
      const ny = (py - (r.top + r.height / 2)) / (r.height / 2);
      return nx * nx + ny * ny <= 0.9;   // kenara teget noktalari da ele
    };

    let sampled = 0, blocked = 0;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < 3; j++) {
        // Pay YUZDE olarak degil, en az 2 CSS pikseli olarak tabanlanir: %3, 26px'lik
        // bir ogede kenardan 0.78px demek ve alt-piksel yerlesimde komsu doner.
        const ic = Math.min(Math.max(2, r.width * 0.03), r.width / 2 - 0.5);
        const x = r.left + ic + ((r.width - 2 * ic) / (cols - 1)) * i;
        const y = r.top + r.height * (0.15 + 0.35 * j);
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        if (!icerde(x, y)) continue;
        sampled++;
        const top = document.elementFromPoint(x, y);
        if (!top || el.contains(top) || top.contains(el)) continue;

        // 🔴 ORTEN de gelistirme katmani olabilir. Ilk duzeltmede yalniz HEDEF
        // tarafi elenmisti — yanlis yon: Next.js'in dev dugmesi gercek bir
        // baglantiyi ortuyordu ve bulgu duruyordu. Denetimi tekrar kosturmasak
        // fark edilmezdi.
        if (gelistirmeKatmani(top)) continue;

        // Akistaki kardes ORTEMEZ — boyama sirasi geregi.
        //
        // Olculdu: yan yana dort 26px dugmede, ornekleme sutunlari genisligin
        // %3-%97'sinde oldugu icin en yakin ornek paylasilan sinira 0.78px
        // dusuyordu; alt-piksel yerlesimde `elementFromPoint` komsuyu donduruyor.
        // 15 ornegin 3'u yanlis isabet (%20) ve dorduncusu de "%20 ortulmus"
        // raporlandi. Dordu de elle tiklandi, calisiyorlardi.
        //
        // Sayiyla degil KURALLA cozulur: konumlandirilmamis, yigin baglami
        // yaratmayan bir kardes, hedefin ustunde boyanamaz.
        if (top.parentElement === el.parentElement) {
          const ts = getComputedStyle(top);
          const duzKardes = ts.position === 'static'
            && (ts.zIndex === 'auto' || ts.zIndex === '')
            && ts.transform === 'none'
            && ts.filter === 'none'
            && parseFloat(ts.opacity) >= 1;
          if (duzKardes) continue;
        }

        blocked++;
        const k = describe(top);
        if (!covers.has(k)) covers.set(k, { el: top, n: 0 });
        covers.get(k).n++;
      }
    }
    if (!sampled || !blocked) return;
    const pct = Math.round((blocked / sampled) * 100);
    if (pct < 10) return; // a shadow or border grazing the edge is not a cover
    const [name, hit] = [...covers.entries()].sort((a, b) => b[1].n - a[1].n)[0];

    // Alt cubugun ORTTUGU sey, kullanicinin kaydirip gecebildigi bir sey olabilir.
    // Bu kapi coveredByFixed'e konulmustu ama BURAYA konulmamisti — saha raporu
    // ikisini birden soyluyordu, biri kapatildi. Sonuc: prod bir uygulamada
    // "Moduller" satiri alt gezinmenin altinda %100 ortulu raporlandi, oysa sayfa
    // 1715px daha kayiyor ve satir kaydirinca cikiyor.
    //
    // Ayni istisna: hedefin KENDISI sabitse kaydirmak onu kurtarmaz.
    {
      // Sabit olan sey ORTEN OGENIN KENDISI degil, ATASI olabilir: alt gezinmede
      // orten "Ana" baglantisidir ve o statiktir; `fixed` olan onu tasiyan <nav>.
      // Yalniz ogenin kendisine bakmak kapiyi sessizce etkisiz birakiyordu —
      // sentetik test geciyordu, gercek sayfa gecmiyordu.
      let sabitAta = null;
      for (let n = hit.el; n && n !== document.body; n = n.parentElement) {
        const ns = getComputedStyle(n);
        if (ns.position === 'fixed' || ns.position === 'sticky') { sabitAta = n; break; }
      }
      const cr = sabitAta ? sabitAta.getBoundingClientRect() : hit.el.getBoundingClientRect();
      const altCubuk = !!sabitAta && cr.bottom >= innerHeight - 4;
      const dahaKayiyor = (window.scrollY + innerHeight) < (document.documentElement.scrollHeight - 4);
      const hedefSabit = st2.position === 'fixed' || st2.position === 'sticky';
      if (altCubuk && dahaKayiyor && !hedefSabit) return;
    }

    // A modal covering what is behind it is the POINT of a modal, not a defect.
    // Without this, every open dialog reported every control on the page beneath
    // it — a check that fires on correct behaviour is a check people learn to
    // ignore. Testing only the covering element itself is not enough: the scrim
    // gets exempted but the dialog's own content box then takes its place as the
    // reported cover (seen on songa: 10 findings became 8, all still the modal).
    // So walk up: anything inside a near-full-viewport overlay, or inside an
    // explicit dialog, is part of a modal. A cookie bar or a FAB covers a slice
    // of the screen and is still reported.
    const isModalPart = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.getAttribute?.('role') === 'dialog' || n.getAttribute?.('aria-modal') === 'true') return true;
        const st = getComputedStyle(n);
        if (st.position === 'fixed' || st.position === 'absolute') {
          const r2 = n.getBoundingClientRect();
          if (r2.width * r2.height >= innerWidth * innerHeight * 0.9) return true;
        }
      }
      return false;
    };
    if (isModalPart(hit.el)) return;
    result.coveredControls.push({
      sel: describe(el), text: shortLabel(el) || '(no text)',
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      coveredBy: name, coveredByText: shortLabel(hit.el) || '(no text)', percent: pct,
    });
  });

  // 6) Text that does not fit its own box and is cut off.
  document.querySelectorAll('h1, h2, h3, p, span, div, button, a, label').forEach((el) => {
    if (!isVisible(el) || el.children.length) return;
    const t = (el.innerText || '').trim();
    if (t.length < 3) return;
    const st = getComputedStyle(el);
    if (st.overflow === 'visible' && st.overflowY === 'visible') return;
    const cutV = el.scrollHeight - el.clientHeight > 3;
    const cutH = el.scrollWidth - el.clientWidth > 3;
    if (!cutV && !cutH) return;
    if (st.textOverflow === 'ellipsis' && cutH && !cutV) return;   // deliberate …
    if (/auto|scroll/.test(st.overflowY) && cutV) return;          // a scroll area
    // line-clamp is deliberate truncation, same as an ellipsis — a card preview
    // showing two lines of a recipe is the design, not a defect. Across a scan of
    // 14 live sites, 17 of 18 "clipped" findings were line-clamped card text.
    const clamp = st.webkitLineClamp || st.lineClamp;
    if (clamp && clamp !== 'none') return;
    result.clippedText.push({
      sel: describe(el), text: t.slice(0, 40), axis: cutV ? 'vertical' : 'horizontal',
      hiddenPx: cutV ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth,
    });
  });

  // 7) Content sitting under a fixed/sticky bar. Headers that scroll over their
  // own page content read as "half the sentence is missing" to the user.
  const bars = [...document.querySelectorAll('*')].filter((el) => {
    if (!isVisible(el)) return false;
    if (gelistirmeKatmani(el)) return false;
    const st = getComputedStyle(el);
    return (st.position === 'fixed' || st.position === 'sticky') && parseFloat(st.zIndex || 0) >= 0;
  });
  // Sayfa daha asagi kayabiliyor mu? Alt cubuk icin bu kapi sart: kullanici
  // kaydirinca oge cubugun ustune cikiyorsa orada KALICI olarak kapali degildir.
  //
  // Olculdu: bir uygulamada 17 bulgunun tamami buydu — kap `pb-24` (96px) alt
  // bosluk veriyor, cubuk `h-14` (56px); sona kaydirinca icerik cubugun ustunde.
  // Cipler emulatorde elle tiklandi, erisilebiliyorlardi. Bu tek sinif, gercek
  // bulgu listesinin en buyuk gurultu kaynagiydi.
  const dahaKayiyor = (window.scrollY + innerHeight) < (document.documentElement.scrollHeight - 4);

  for (const bar of bars) {
    const br = bar.getBoundingClientRect();
    if (br.height < 20 || br.height > innerHeight * 0.5) continue;
    // Ekranin ALTINA yapisik mi? Karar oge bazinda verilir (asagida): akan icerik
    // kaydirmayla kurtulur, sabit konumlu oge kurtulmaz.
    const altaYapisik = br.bottom >= innerHeight - 4;
    document.querySelectorAll('h1, h2, h3, p, label, button, a').forEach((el) => {
      if (!isVisible(el) || bar.contains(el) || el.contains(bar)) return;
      const r = el.getBoundingClientRect();
      const over = Math.max(0, Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top));
      if (over <= r.height * 0.4 || r.width <= 40) return;

      // Kaydirma kapisi yalniz AKAN icerik icin gecerli: ogenin kendisi de sabitse
      // kaydirmak onu cubugun altindan cikarmaz, kalici olarak orada kalir.
      if (altaYapisik && dahaKayiyor) {
        const ost = getComputedStyle(el).position;
        if (ost !== 'fixed' && ost !== 'sticky') return;
      }

      // Geometry alone LIES. A fixed element can overlap a box and still be behind
      // it (lower z-index) or be transparent — on app.redios.com.tr a floating
      // button geometrically covered the cookie buttons while sitting behind the
      // banner, perfectly readable. Ask the browser what is actually on top.
      const x = Math.max(r.left, 0) + Math.min(r.width, innerWidth) / 2;
      const y = Math.max(r.top, br.top) + over / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return;
      const top = document.elementFromPoint(x, y);
      if (!top || !(bar === top || bar.contains(top))) return;

      result.coveredByFixed.push({
        sel: describe(el), text: shortLabel(el) || (el.innerText || '').trim().slice(0, 40),
        bar: describe(bar), percent: Math.round((over / r.height) * 100),
      });
    });
  }

  capAt('smallTargets', 12);
  capAt('tinyText', 8);
  capAt('coveredControls', 10);
  capAt('clippedText', 10);

  // 8) Bir grupta HER dugme ayni gorunuyorsa hangisinin ana eylem oldugu
  // anlasilmaz. "Kaydet · Iptal · Sil" ucu de ayni renkse kullanici hangisine
  // basacagini renkten degil OKUYARAK bulmak zorunda kalir.
  //
  // Two guards, both learned from false alarms on a real app:
  //
  //   * A bottom nav ("Search / Calendar / Messages / Profile") and filter chips
  //     ("This weekend / Next week") are SUPPOSED to look alike — uniformity is
  //     the design, and flagging it teaches people to ignore the tool.
  //   * The finding only matters when clicking the wrong one costs something.
  //     So the group must contain at least one committing action: save, delete,
  //     send, pay. "Search / Calendar / Messages / Profile" contains none.
  //
  const COMMITTING = /^(kaydet|sil|gonder|onayla|odeme|ode|satin al|olustur|guncelle|yayinla|kabul|tamamla|iptal et|save|delete|remove|send|submit|confirm|pay|buy|create|update|publish|accept|apply|discard)\b/i;
  const NAV_CONTAINER = 'nav, [role="tablist"], [role="navigation"], [role="menu"], [role="menubar"], [role="radiogroup"], [role="group"][aria-label*="filter" i]';

  const gruplar = new Map();
  document.querySelectorAll('button, a[href][class*="btn"], [role="button"]').forEach((el) => {
    if (!isVisible(el)) return;
    const t2 = shortLabel(el);
    if (!t2 || t2.length > 24) return;                 // ikon/uzun metin degil, eylem etiketi
    const p = el.parentElement;
    if (!p) return;
    if (!gruplar.has(p)) gruplar.set(p, []);
    gruplar.get(p).push(el);
  });
  for (const [ebeveyn, uyeler] of gruplar) {
    if (uyeler.length < 2 || uyeler.length > 6) continue;
    if (ebeveyn.closest(NAV_CONTAINER)) continue;                 // tabs and menus: uniform on purpose
    // Links that go to DIFFERENT pages are navigation, whatever they are styled as.
    const hrefler = new Set(uyeler.map((el) => el.getAttribute('href')).filter(Boolean));
    if (hrefler.size === uyeler.length && hrefler.size > 1) continue;
    if (!uyeler.some((el) => COMMITTING.test(shortLabel(el)))) continue;   // nothing to lose by mis-clicking
    const imzalar = uyeler.map((el) => {
      const s = getComputedStyle(el);
      const bgc = effectiveBackground(el);
      return {
        el,
        imza: `${bgc ? Math.round(bgc.r) + ',' + Math.round(bgc.g) + ',' + Math.round(bgc.b) : 'yok'}|${s.borderColor}|${s.fontWeight}`,
      };
    });
    const benzersiz = new Set(imzalar.map((x) => x.imza));
    if (benzersiz.size !== 1) continue;                // en az biri farkli -> sorun yok
    result.sameLookingActions.push({
      sel: describe(uyeler[0].parentElement),
      count: uyeler.length,
      labels: uyeler.map((el) => shortLabel(el)).slice(0, 6),
    });
  }

  // 9) Koyu temada acik renkli buyuk alan — "karanlik modda beyaz ekran".
  if (settings && settings.theme === 'dark') {
    document.querySelectorAll('main, section, article, div, header, footer, aside').forEach((el) => {
      if (!isVisible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < innerWidth * innerHeight * 0.06) return;   // kucuk kutu degil
      const bgc = effectiveBackground(el);
      if (!bgc) return;
      if (luminance(bgc) < 0.5) return;                 // koyu -> sorun yok
      // Ebeveyni de acikta ise tek kaynak orasi; en dis acik kutuyu bildir.
      const pbg = el.parentElement ? effectiveBackground(el.parentElement) : null;
      if (pbg && luminance(pbg) >= 0.5) return;
      result.darkModeLightPatches.push({
        sel: describe(el), size: `${Math.round(r.width)}x${Math.round(r.height)}`,
        bg: `rgb(${Math.round(bgc.r)}, ${Math.round(bgc.g)}, ${Math.round(bgc.b)})`,
        share: Math.round((r.width * r.height) / (innerWidth * innerHeight) * 100),
      });
    });
  }

  // 10) Ayni ekranda iki dil. Turkce'ye ozgu harf/ek TASIYAN metinle, yalniz
  // Ingilizce kelimelerden olusan metin bir arada gorunuyorsa tutarsizlik var.
  // Tek bir innerText blobu ALDATIR: yan yana iki dugmenin metni bosluksuz
  // birlesir ("KaydetCancelDelete") ve kelime sinirlari tutmaz. Metni oge oge
  // toplayip bosluklarla birlestiriyoruz — ekranda okundugu gibi.
  const govdeMetni = [...document.querySelectorAll('body *')]
    .filter((el) => !el.children.length && (el.innerText || '').trim())
    .map((el) => el.innerText.trim())
    .join(' ')
    .slice(0, 20000);
  const trIsaret = (govdeMetni.match(/[ığşçöüİĞŞÇÖÜ]|\b(ve|için|ile|bir|bu|olarak|yeni|kaydet|iptal|ara|giriş)\b/gi) || []).length;
  const enIsaret = (govdeMetni.match(/\b(the|and|with|your|save|cancel|search|login|sign in|settings|continue|delete|next|back)\b/gi) || []).length;
  // Mutlak sayi tek basina YALAN SOYLER: gercek bir sayfada 591 Turkce isarete
  // karsi 7 Ingilizce ("next", "Next" — karusel etiketi) "iki dil" sayildi. %1
  // gurultudur, tutarsizlik degil. Azinlik dilin ANLAMLI bir pay tutmasi ve
  // birden fazla FARKLI kelimeyle gorunmesi aranir.
  const ornekler = [...new Set((govdeMetni.match(/\b(the|and|with|your|save|cancel|search|login|sign in|settings|continue|delete|next|back)\b/gi) || []))]
    .map((w) => w.toLowerCase());
  const enPay = enIsaret / Math.max(1, trIsaret + enIsaret);
  if (trIsaret >= 5 && enIsaret >= 3 && enPay >= 0.1 && new Set(ornekler).size >= 2) {
    result.mixedLanguage.push({
      trCount: trIsaret, enCount: enIsaret,
      share: Math.round(enPay * 100),
      englishWords: [...new Set(ornekler)].slice(0, 6),
    });
  }

  // 11) Amerikan tarih bicimi. GG/AA belirsizligi degil, ay-once olani ara:
  // 13'ten buyuk ikinci parca varsa kesin AA/GG/YYYY.
  const tarihler = [...new Set((govdeMetni.match(/\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19|20)\d\d\b/g) || []))];
  for (const d2 of tarihler.slice(0, 6)) {
    const [a2, b2] = d2.split('/').map(Number);
    if (b2 > 12) result.usDates.push({ text: d2, note: 'AA/GG/YYYY — ikinci parca 12den buyuk' });
    else if (a2 <= 12 && b2 <= 12) result.usDates.push({ text: d2, note: 'belirsiz: AA/GG mi GG/AA mi' });
  }

  // 12) Centik / ev cubugu: sabit cubuk guvenli alanin ALTINDA kaliyor mu.
  //
  // Burada kesin bir kapi var ve yanlis alarmi kendisi eliyor: iOS'ta
  // `viewport-fit=cover` YOKSA tarayici sayfayi zaten centigin disina yerlestirir
  // (letterbox) ve `env(safe-area-inset-*)` her yerde 0 doner — yani sorun
  // OLUSMAZ. Bulgu ancak sayfa `cover` ile tam ekrani istemis AMA karsiliginda
  // gelen payi hic kullanmamissa gecerlidir. Tam da PWA/TWA'da yasanan hata.
  if (isMobile) {
    const meta = document.querySelector('meta[name="viewport"]');
    const cover = /viewport-fit\s*=\s*cover/i.test(meta ? meta.getAttribute('content') || '' : '');
    if (cover) {
      // Sayfanin kendi CSS'i pay kullaniyor mu. Baska kaynaktan gelen stil
      // sayfasi okunamaz (SecurityError) — okunamayani "kullanmiyor" saymak
      // yanlis alarm uretir, o yuzden okunamayan varsa kontrol susar.
      let paySahibi = false;
      let okunamayan = false;
      for (const sheet of document.styleSheets) {
        let kurallar = null;
        try { kurallar = sheet.cssRules; } catch { okunamayan = true; continue; }
        if (!kurallar) continue;
        for (const k of kurallar) {
          if (k.cssText && k.cssText.includes('safe-area-inset')) { paySahibi = true; break; }
        }
        if (paySahibi) break;
      }
      // Satir ici stiller de sayilir (Tailwind arbitrary deger cogu zaman boyle biner).
      if (!paySahibi && document.documentElement.innerHTML.includes('safe-area-inset')) paySahibi = true;

      if (!paySahibi && !okunamayan) {
        const KENAR = 24;      // ust/alt kenara "yapisik" sayilma toleransi
        for (const el of document.querySelectorAll('body *')) {
          const st = getComputedStyle(el);
          if (st.position !== 'fixed' && st.position !== 'sticky') continue;
          if (!isVisible(el)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < innerWidth * 0.5) continue;             // kenar cubugu degil, kucuk rozet
          const ust = r.top <= KENAR;
          const alt = r.bottom >= innerHeight - KENAR;
          if (!ust && !alt) continue;
          // Icinde gercekten dokunulacak bir sey var mi; suslu bir serit degil.
          const kontrol = el.querySelector('button, a[href], input, select, [role="button"]');
          if (!kontrol) continue;
          result.unsafeArea.push({
            sel: describe(el), edge: ust ? 'top' : 'bottom',
            text: shortLabel(kontrol) || (el.innerText || '').trim().slice(0, 40) || '(no text)',
            note: 'viewport-fit=cover set, safe-area-inset never used',
          });
          if (result.unsafeArea.length >= 4) break;
        }
      }
    }
  }

  // 13) "Bir hata olustu." Hangi hata? Ne yapmali?
  //
  // Gorunur bir hata metni, sorunun ne oldugunu SOYLEMIYORSA kullanicinin
  // elinde tek secenek kalir: tekrar denemek. Kontrol, hata gibi gorunen kutuyu
  // bulur ve icinde somut bir sey (alan adi, sayi, "tekrar dene" gibi bir yon)
  // olup olmadigina bakar.
  // Kaliplar ASCII yazilir ama ekrandaki metin oyle DEGILDIR: "Bir hata olustu"
  // gercekte "Bir hata oluştu". Once katla, sonra esle — yoksa kontrol tam da
  // yakalamasi gereken Turkce mesaji kacirir.
  const TR_ASCII = { 'ç': 'c', 'ğ': 'g', 'ı': 'i', 'ö': 'o', 'ş': 's', 'ü': 'u', 'İ': 'i', 'Ç': 'c', 'Ğ': 'g', 'Ö': 'o', 'Ş': 's', 'Ü': 'u' };
  const katla = (s) => String(s).replace(/[çğıöşüİÇĞÖŞÜ]/g, (c) => TR_ASCII[c] || c);
  const GENEL_HATA = /^(bir (sorun|hata) (olustu|var|meydana geldi)|hata|hata olustu|islem basarisiz|basarisiz|bilinmeyen hata|something went wrong|an error occurred|error|failed|oops|unknown error)[.!]?$/i;
  const hataKaplari = document.querySelectorAll(
    '[role="alert"], [aria-live="assertive"], .error, .alert-error, [class*="error" i], [class*="hata" i]',
  );
  for (const el of hataKaplari) {
    if (!isVisible(el)) continue;
    const metin = (el.innerText || '').trim();
    if (!metin || metin.length > 120) continue;
    if (!GENEL_HATA.test(katla(metin))) continue;
    // Yaninda somut bir yon varsa (tekrar dene dugmesi, destek baglantisi) mesaj
    // tek basina degildir — kullanici ne yapacagini biliyor.
    const yon = el.querySelector('button, a[href]')
      || (el.parentElement && el.parentElement.querySelector('button, a[href]'));
    if (yon && isVisible(yon)) continue;
    result.genericErrors.push({ sel: describe(el), text: metin.slice(0, 80) });
    if (result.genericErrors.length >= 5) break;
  }

  // 14) Sil dugmesi var, onay mekanizmasi yok.
  //
  // Dugmeye BASMAK gercekten siler — o yuzden tiklanmaz. Bakilan sey sayfanin
  // onaylama makinesine sahip olup olmadigi: bir dialog, bir modal, ya da
  // dugmenin kendisinin bir dialog actigini soylemesi. Hicbiri yoksa geri
  // donusu olmayan islem tek dokunusla oluyor demektir.
  const YIKICI = /^(sil|kaldir|hesabi sil|hesabimi sil|iptal et|delete|remove|erase|delete account)\b/i;
  // `confirm()` bir onaydir ama DOM'da hicbir izi yoktur. Bir uygulamada dort
  // satir-ici Sil dugmesi "onaysiz" raporlandi; uceunun de arkasinda
  // `if (confirm('...')) onDelete(...)` vardi. Tiklamak gercekten siler, o yuzden
  // deneyerek ogrenilemez — onclick kaynagina ve sayfa metnine bakilir.
  const kaynaktaConfirm = [...document.querySelectorAll('[onclick]')]
    .some((el) => /\bconfirm\s*\(/.test(el.getAttribute('onclick') || ''));
  const onayMakinesi = kaynaktaConfirm
    || !!document.querySelector('dialog, [role="alertdialog"], [role="dialog"], [class*="modal" i], [class*="confirm" i], [data-confirm]');
  if (!onayMakinesi) {
    for (const el of document.querySelectorAll('button, [role="button"], a[href]')) {
      if (!isVisible(el)) continue;
      const etiket = shortLabel(el);
      if (!etiket || !YIKICI.test(katla(etiket))) continue;
      if (el.getAttribute('aria-haspopup') === 'dialog') continue;
      result.destructiveWithoutConfirm.push({ sel: describe(el), text: etiket });
      if (result.destructiveWithoutConfirm.length >= 4) break;
    }
  }

  // 15) Gerekcesiz izin istegi (kanca PERMISSION_HOOKS ile once kuruldu).
  for (const k of (window.__uisightPermissions || [])) {
    if (k.gesture) continue;              // once bir sey yapildi: baglam var
    result.eagerPermissions.push({ api: k.api, atMs: k.atMs });
  }

  capAt('coveredByFixed', 10);
  capAt('sameLookingActions', 6);
  capAt('darkModeLightPatches', 6);
  capAt('usDates', 6);
  // 16) Kapsayicisina sigmayan ve KAYDIRILAMAYAN icerik.
  //
  // `clippedText` yalniz yaprak metin ogelerine bakiyor (`el.children.length`
  // varsa atliyor), ama gercek kusur cogu zaman bir ust katmandadir: alti sutunlu
  // bir tablo `overflow-hidden` bir kutuda; telefonda uc sutun gorunuyor,
  // digerleri YOK ve kaydirma da yok. Uc sayfada ayni desen vardi ve motor
  // hicbirini bulmadi — insan ekran goruntusune bakarken yakaladi.
  //
  // Ayirt edici temiz: ayni oge `overflow-x: auto|scroll` olsaydi kullanici
  // kaydirabilirdi ve sorun olmazdi. Kirpan sey `hidden`.
  for (const el of document.querySelectorAll('div, section, main, aside, table, ul, ol')) {
    if (!isVisible(el) || dekoratif(el) || gelistirmeKatmani(el)) continue;
    const st = getComputedStyle(el);
    const ox = st.overflowX;
    if (ox !== 'hidden' && ox !== 'clip') continue;          // auto/scroll: kullanici kaydirir
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 24) continue;             // rozet/ikon kutusu degil

    // `scrollWidth` YANLIS OLCU. Olculdu: bir sayfada 2.193px "gizli" cikti ve
    // sebebi mutlak konumlu, animasyonlu zemin lekeleriydi — okunacak metin hic
    // kirpilmiyordu. Bir digeri kayan logo seridiydi; icerik zaten gorus alanina
    // giriyor. Ikisi de scrollWidth'i sisiriyor.
    //
    // Dogru soru: AKISTAKI, metin tasiyan bir cocuk kabin disina tasiyor mu?
    let enFazla = 0;
    let ornek = '';
    for (const c of el.children) {
      const cs = getComputedStyle(c);
      if (cs.position === 'absolute' || cs.position === 'fixed') continue;   // akista degil
      if (cs.animationName !== 'none' && cs.transform !== 'none') continue;  // kayan serit
      const metin = (c.innerText || '').trim();
      if (!metin) continue;                                   // suslu kutu: kaybolan bilgi yok
      const cr = c.getBoundingClientRect();
      const disari = Math.round(cr.right - r.right);
      if (disari > enFazla) { enFazla = disari; ornek = metin; }
    }
    if (enFazla <= 24) continue;                              // yuvarlama payi degil, gercek kayip

    result.clippedContainer.push({
      sel: describe(el),
      hiddenPx: enFazla,
      size: `${Math.round(r.width)}x${Math.round(r.height)}`,
      text: ornek.replace(/\s+/g, ' ').slice(0, 60),
    });
    if (result.clippedContainer.length >= 6) break;
  }

  // 17) "Bos" diyor ama hala yukluyor.
  //
  // Bir sayfa "TOPLAM 0" gosterirken veritabaninda 45 belge vardi; baska birinde
  // baslik "0 madde", sayac "0 / 0 gosteriliyor" derken ARAMA KUTUSUNDA donen bir
  // spinner vardi ve kutuphanede 5.055 kayit. Kullanici bir an "veritabani bos"
  // goruyor. Ikisi ayni anda ekrandaysa, gosterilen sey hakikat degil ara durumdur.
  {
    const yukleniyor = [...document.querySelectorAll(
      '[class*="spin" i], [class*="skeleton" i], [role="progressbar"], [aria-busy="true"]',
    )].some((el) => isVisible(el) && !dekoratif(el));
    if (yukleniyor) {
      const BOS = /(^|\s)0(\s|$)|bulunamad|sonuc yok|kayit yok|bos|empty|no results|nothing here/i;
      for (const el of document.querySelectorAll('p, span, div, h1, h2, h3, td')) {
        if (el.children.length || !isVisible(el) || dekoratif(el)) continue;
        const metin = (el.innerText || '').trim();
        if (!metin || metin.length > 60 || !BOS.test(metin)) continue;
        result.loadingButEmpty.push({ sel: describe(el), text: metin.slice(0, 60) });
        if (result.loadingButEmpty.length >= 3) break;
      }
    }
  }

  // 18) Akistaki metin bir kontrolun ARKASINA giriyor.
  //
  // `coveredControls` kontrolun ortulmesine bakiyor, `coveredByFixed` yalniz
  // sabit cubuklara. Aradaki bosluk gercek bir kusuru kaciriyordu: `flex
  // items-center justify-between` bir satir telefonda sarmayinca aciklama
  // paragrafi "SDS yukle" dugmesinin altina giriyordu — ne kontrol ortulu ne de
  // ortan sey sabit.
  //
  // Ayni yerde yanlis alarm riski yuksek oldugu icin uc kapi var: gorunur metin,
  // gercekten ustte olan bir KONTROL, ve dekoratif olmayan bir ortucu.
  for (const el of document.querySelectorAll('p, span, h1, h2, h3, h4, label, li')) {
    if (el.children.length || !isVisible(el) || dekoratif(el) || gelistirmeKatmani(el)) continue;
    const metin = (el.innerText || '').trim();
    if (metin.length < 8) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 8) continue;
    if (r.bottom < 0 || r.top > innerHeight) continue;

    // Metnin kendi alaninda uc nokta: sol, orta, sag ucte bir.
    let ortuk = 0;
    let ortucu = null;
    for (const pay of [0.25, 0.5, 0.75]) {
      const x = r.left + r.width * pay;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      const ust = document.elementFromPoint(x, y);
      if (!ust || ust === el || el.contains(ust) || ust.contains(el)) continue;
      // Yalniz KONTROL sayilir: dekoratif bir katman metnin uzerinde olabilir ve
      // sorun olmayabilir; tiklanabilir bir sey ise metin gercekten kayboluyor.
      const k = ust.closest('button, a[href], [role="button"], input, select, textarea');
      if (!k || dekoratif(k)) continue;

      // Kapatilabilir bir katmanin arkasindaki metin KAYIP degil: kullanici
      // kapatir, metin oradadir. Cerez banner'i fiyat kartinin ustune oturuyordu
      // ve bulgu uretti — oysa "Sadece zorunlu"ya basinca her sey gorunur.
      //
      // Ayrim onemli: ayni banner'in bir KONTROLU ortmesi gercek sorundur
      // (kullanici o dugmeye ulasamaz), o yuzden coveredControls'da muafiyet YOK.
      // Burada ortulen sey bilgi metni, ve o metin bir tik otede duruyor.
      const KAPAT = /kabul|accept|allow|tamam|onayla|agree|got it|anladim|anladım|reddet|reject|decline|sadece zorunlu|only essential|kapat|close|dismiss/i;
      let kapatilabilir = false;
      for (let n = k; n && n !== document.body; n = n.parentElement) {
        if (n.getAttribute?.('role') === 'dialog' || n.getAttribute?.('aria-modal') === 'true') { kapatilabilir = true; break; }
        const ns = getComputedStyle(n);
        if (ns.position !== 'fixed' && ns.position !== 'sticky' && ns.position !== 'absolute') continue;
        const dugmeler = [...n.querySelectorAll('button, [role="button"], a[href]')];
        if (dugmeler.some((d) => KAPAT.test((d.textContent || '').trim()))) { kapatilabilir = true; break; }
      }
      if (kapatilabilir) continue;
      ortuk++;
      ortucu = k;
    }
    if (ortuk < 2) continue;                 // tek nokta kenar payi olabilir
    result.textUnderControl.push({
      sel: describe(el), text: metin.slice(0, 50),
      control: describe(ortucu), controlText: shortLabel(ortucu) || '(no text)',
    });
    if (result.textUnderControl.length >= 5) break;
  }

  capAt('genericErrors', 5);
  capAt('clippedContainer', 6);
  capAt('destructiveWithoutConfirm', 4);
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
  await page.addInitScript(PERMISSION_HOOKS);   // sayfa kodundan ONCE
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  console.log(`\n  ${p.label} penceresi acildi: ${url}`);
  console.log('  Browse away. Close the window or hit Ctrl+C when you are done.\n');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await browser.close();
}

// --- Main flow ---------------------------------------------------------------
async function main() {
  checkForUpdate();          // arka planda, beklenmez
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) {
    console.log(currentVersion() || 'unknown');
    return;
  }

  const o = parseArgs(process.argv.slice(2));
  // Asking for help is not a failure. This exited 1 whenever --help was used
  // without a URL — which is every time — so any script or CI step that checked
  // the status saw the help screen as an error.
  if (o.printHelp) { printHelp(); process.exit(0); }
  if (!o.url) { printHelp(); process.exit(1); }

  // Taninmayan bir bayrak ADRES sanilmamali. `uisight --version` gercekten
  // `https://--version` adresini taramaya calisti ve
  // `uisight-outputs/--version-.../` klasoru yaratti. Bilinmeyen bayrak, sessizce
  // saçma bir is yapmak yerine soylenir.
  if (o.url.startsWith('-')) {
    console.error(`  ! unknown option: ${o.url}
`);
    printHelp();
    process.exit(1);
  }
  if (o.unknownFlags?.length) {
    for (const f of o.unknownFlags) {
      console.error(`  ! unknown option: ${f}`);
      if (PANEL_ONLY_FLAGS.has(f)) console.error(`    ${f} belongs to uisight-panel, not to this command.`);
    }
    console.error('    uisight --help lists what this takes.');
    process.exit(2);
  }
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

  // A first run arrives with the driver and nothing to drive: Playwright's npm
  // package has no install hook. Asking here, before the loop, is kinder than
  // failing inside it -- and it only asks where there is someone to answer.
  const gerekenMotorlar = [...new Set(o.device.map((k) => PROFILES[k]?.engine).filter(Boolean))];
  if (gerekenMotorlar.length) await offerInstall(gerekenMotorlar, { chromium, webkit });

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
      await page.addInitScript(PERMISSION_HOOKS);

      // Ucustaki istek sayisini sinirla: kapasitesi dar bir arka ucu tikamamak icin.
      if (o.maxRequests) {
        let ucusta = 0;
        const kuyruk = [];
        const sonraki = () => {
          if (ucusta >= o.maxRequests || !kuyruk.length) return;
          ucusta++;
          kuyruk.shift()();
        };
        await page.route('**/*', async (route) => {
          await new Promise((res) => { kuyruk.push(res); sonraki(); });
          try { await route.continue(); } catch { /* iptal edilmis istek */ }
          ucusta--;
          sonraki();
        });
      }

      for (const path of o.path) {
        // Git Bash/MSYS `--path "/,/gbf"` icindeki tek basina `/` karakterini
        // `C:/Program Files/Git`e cevirir. Arac bunu yol sanip
        // `C-Program-Files-Git__pixel__dark.png` uretti ve ANA SAYFA HIC
        // taranmadi — hicbir hata da vermeden. Windows'ta ancak dosya adlarina
        // bakan biri fark eder.
        if (/^[A-Za-z]:[\\/]/.test(path) || /^\/[A-Za-z]:/.test(path)) {
          console.log(`  ! path "${path}" looks like a Windows file path, not a URL path.`);
          console.log('    Git Bash rewrote it. Re-run with MSYS_NO_PATHCONV=1, or quote as "//".');
          continue;
        }
        const target = new URL(path, o.url).toString();
        const record = { device: key, label: p.label, engine: engineName, theme, path, url: target, console: [], network: [], error: null };

        // 🔴 Bu dinleyiciler her path icin YENIDEN ekleniyor ve eskiden hic
        // kaldirilmiyordu. Her biri kendi `record`una kapanis tutuyor, dolayisiyla
        // N'inci sayfa yuklenirken N dinleyici birden tetikleniyor ve ayni olay
        // ONCEKI TUM kayitlara da yaziliyordu.
        //
        // Sahada gorulen imza tam bir azalan merdiven: 12 sayfanin her birinde
        // gercek 2 hata varken rapor `/ → 22, /gbf → 20, /sds → 18 … /themes → 2`
        // diyordu. Ilk sayfa 11 kat sismis, son sayfa dogru. Raporu okuyan ana
        // sayfada 22 basarisiz istek gorup panige kapiliyor; gercek sayi 2.
        //
        // Ayrica sizinti: 12 path x 3 dinleyici = 36 canli listener.
        const dinleyiciler = {
          pageerror: (e) => record.console.push({ type: 'js-error', message: String(e).slice(0, 200) }),
          console: (m) => { if (m.type() === 'error') record.console.push({ type: 'console', message: m.text().slice(0, 200) }); },
          response: (r) => { if (r.status() >= 400) record.network.push({ status: r.status(), url: r.url().slice(0, 120) }); },
        };
        for (const [olay, fn] of Object.entries(dinleyiciler)) page.on(olay, fn);

        try {
          // One retry: edge networks intermittently stall a single request in a burst run.
          let response;
          try {
            response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: o.timeout });
          } catch {
            response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: o.timeout });
          }
          record.state = response ? response.status() : null;
          await page.waitForTimeout(o.settle);
          record.baslik = await page.title();
          record.inspection = await page.evaluate(INSPECTION_SCRIPT, { mobile: p.mobile !== false, theme });

          const ad = `${slug(path)}__${key}__${theme}.png`;
          const png = join(outDir, ad);
          // scale:'css' saves in CSS pixels: smaller files, easier to read.
          await page.screenshot({ path: png, fullPage: o.full, scale: 'css' });
          record.image = png;
          console.log(`  ok  ${key}/${theme}  ${path}  -> ${ad}`);
        } catch (e) {
          record.error = String(e).slice(0, 300);
          console.log(`  ERROR ${key}/${theme} ${path}: ${record.error.split('\n')[0]}`);
        } finally {
          // Hata da olsa kaldir: birakılan dinleyici sonraki her sayfanin
          // olaylarini bu kayda yazmaya devam eder.
          for (const [olay, fn] of Object.entries(dinleyiciler)) page.off(olay, fn);
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
    // Bu sayac bulgu TURLERINI sayiyordu ve etiketi "kayit" diyordu, yani bir
    // ekranda iki tur cikinca pay paydayi geciyordu: gercek bir rapor "8/4"
    // yazdi. Ekran basina tek bayrak.
    let bulguVar = false;
    lines.push(`## ${k.label} · ${k.theme} · ${k.path}`);
    if (k.error) { lines.push(`- **PAGE FAILED TO LOAD:** ${k.error}`); findingCount++; lines.push(''); continue; }
    lines.push(`- Image: \`${k.image}\``);
    lines.push(`- HTTP ${k.state} · title: ${k.baslik}`);

    const d = k.inspection || {};
    if (d.horizontalOverflow) {
      bulguVar = true;
      lines.push(`- 🔴 **HORIZONTAL OVERFLOW**: page ${d.horizontalOverflow.pageWidth}px / viewport ${d.horizontalOverflow.viewportWidth}px`);
      for (const s of d.horizontalOverflow.overflowing) lines.push(`  - \`<${s.label} class="${s.className}">\` right edge ${s.right}px`);
    }
    if (d.smallTargets?.length) {
      bulguVar = true;
      lines.push(`- 🟡 **touch targets below 44px** (${kac(d, 'smallTargets')}):`);
      for (const s of d.smallTargets) lines.push(`  - \`${s.label}\` ${s.size} — "${s.text}"`);
    }
    if (d.tinyText?.length) {
      bulguVar = true;
      lines.push(`- 🟡 **text below 12px** (${d.tinyText.length}): ` + d.tinyText.map((m) => `${m.fontSize} "${m.text}"`).join(' · '));
    }
    if (d.invisibleText?.length) {
      bulguVar = true;
      lines.push(`- 🔴 **INVISIBLE TEXT** (contrast <1.6:1 — practically unreadable, ${kac(d, 'invisibleText')}):`);
      for (const s of d.invisibleText) lines.push(`  - \`${s.sel}\` ${s.ratio}:1 — text ${s.color} / bg ${s.bg} — "${s.text}"`);
    }
    if (d.lowContrast?.length) {
      bulguVar = true;
      lines.push(`- 🟡 **Low contrast** (below WCAG AA, ${kac(d, 'lowContrast')}):`);
      for (const s of d.lowContrast) lines.push(`  - \`${s.sel}\` ${s.ratio}:1 (threshold ${s.threshold}) ${s.fontSize} — "${s.text}"`);
    }
    if (d.buttonIssues?.length) {
      bulguVar = true;
      lines.push(`- 🟠 **Button issues** (${kac(d, 'buttonIssues')}):`);
      for (const s of d.buttonIssues) lines.push(`  - \`${s.sel}\` "${s.text}" → ${s.issues.join(' · ')}`);
    }
    if (d.coveredControls?.length) {
      bulguVar = true;
      lines.push(`- 🔴 **Covered controls** (something sits on top of them, ${kac(d, 'coveredControls')}):`);
      for (const s of d.coveredControls) lines.push(`  - \`${s.sel}\` "${s.text}" ${s.size} — ${s.percent}% covered by \`${s.coveredBy}\` "${s.coveredByText}"`);
    }
    if (d.coveredByFixed?.length) {
      bulguVar = true;
      lines.push(`- 🟠 **Hidden under a fixed bar** (${kac(d, 'coveredByFixed')}):`);
      for (const s of d.coveredByFixed) lines.push(`  - \`${s.sel}\` "${s.text}" — ${s.percent}% under \`${s.bar}\``);
    }
    if (d.clippedText?.length) {
      bulguVar = true;
      lines.push(`- 🟡 **Text cut off by its own box** (${kac(d, 'clippedText')}):`);
      for (const s of d.clippedText) lines.push(`  - \`${s.sel}\` "${s.text}" — ${s.hiddenPx}px hidden (${s.axis})`);
    }
    if (d.sameLookingActions?.length) {
      bulguVar = true;
      lines.push(`- 🟠 **No primary action** (every button in the row looks the same, ${kac(d, 'sameLookingActions')}):`);
      for (const s of d.sameLookingActions) lines.push(`  - \`${s.sel}\` ${s.count} buttons — ${s.labels.join(' / ')}`);
    }
    if (d.unsafeArea?.length) {
      bulguVar = true;
      lines.push(`- 🔴 **Under the notch / home indicator** (viewport-fit=cover set, safe-area-inset never used, ${kac(d, 'unsafeArea')}):`);
      for (const s of d.unsafeArea) lines.push(`  - \`${s.sel}\` ${s.edge} edge — "${s.text}"`);
    }
    if (d.darkModeLightPatches?.length) {
      bulguVar = true;
      lines.push(`- 🟠 **Light patches in dark mode** (${kac(d, 'darkModeLightPatches')}):`);
      for (const s of d.darkModeLightPatches) lines.push(`  - \`${s.sel}\` ${s.size} (${s.share}% of the screen) — ${s.bg}`);
    }
    if (d.mixedLanguage?.length) {
      bulguVar = true;
      for (const s of d.mixedLanguage) {
        lines.push(`- 🟡 **Two languages on one screen**: ${s.trCount} Turkish / ${s.enCount} English markers (${s.share}%) — ${s.englishWords.join(', ')}`);
      }
    }
    if (d.usDates?.length) {
      bulguVar = true;
      lines.push(`- 🟡 **US date format** (${kac(d, 'usDates')}): ` + d.usDates.map((s) => `${s.text} (${s.note})`).join(' · '));
    }
    if (d.clippedContainer?.length) {
      bulguVar = true;
      lines.push(`- 🔴 **Content clipped with no way to scroll** (${kac(d, 'clippedContainer')}):`);
      for (const s of d.clippedContainer) lines.push(`  - \`${s.sel}\` ${s.size}, ${s.hiddenPx}px hidden — "${s.text}"`);
    }
    if (d.textUnderControl?.length) {
      bulguVar = true;
      lines.push(`- 🔴 **Text disappearing behind a control** (${kac(d, 'textUnderControl')}):`);
      for (const s of d.textUnderControl) lines.push(`  - "${s.text}" behind \`${s.control}\` "${s.controlText}"`);
    }
    if (d.loadingButEmpty?.length) {
      bulguVar = true;
      lines.push(`- 🟠 **Says "empty" while still loading** (${kac(d, 'loadingButEmpty')}): `
        + d.loadingButEmpty.map((s) => `"${s.text}"`).join(' · '));
    }
    if (d.genericErrors?.length) {
      bulguVar = true;
      lines.push(`- 🟠 **Error message says nothing** (${kac(d, 'genericErrors')}):`);
      for (const s of d.genericErrors) lines.push(`  - \`${s.sel}\` "${s.text}"`);
    }
    if (d.destructiveWithoutConfirm?.length) {
      bulguVar = true;
      lines.push(`- 🔴 **Irreversible action with no confirmation on the page** (${kac(d, 'destructiveWithoutConfirm')}):`);
      for (const s of d.destructiveWithoutConfirm) lines.push(`  - \`${s.sel}\` "${s.text}"`);
    }
    if (d.eagerPermissions?.length) {
      bulguVar = true;
      lines.push(`- 🟠 **Permission requested during load, with nothing explaining it** (${kac(d, 'eagerPermissions')}): `
        + d.eagerPermissions.map((s) => `${s.api} at ${s.atMs}ms`).join(' · '));
    }
    if (d.imagesWithoutAlt) lines.push(`- ⚪ images without alt: ${d.imagesWithoutAlt}`);
    if (k.console.length) { bulguVar = true; lines.push(`- 🔴 **Console/JS errors** (${k.console.length}):`); for (const c of k.console.slice(0, 5)) lines.push(`  - ${c.type}: ${c.message}`); }
    if (k.network.length) { bulguVar = true; lines.push(`- 🔴 **Failed requests** (${k.network.length}):`); for (const a of k.network.slice(0, 5)) lines.push(`  - ${a.status} ${a.url}`); }
    // There used to be a second, hand-maintained list of what counts as a
    // finding here, and it had fallen behind the checks: a screen whose only
    // problem was one of the newer types printed the finding and then "clean"
    // underneath it. The flag is set by every branch that actually prints
    // something, so it cannot drift.
    if (bulguVar) findingCount++;
    else lines.push('- ✅ automated checks clean (still eyeball the image)');
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
    if (d.invisibleText?.length) badges.push(['crit', `invisible text ${kac(d, 'invisibleText')}`]);
    if (k.console?.length) badges.push(['crit', `JS errors ${k.console.length}`]);
    if (k.network?.length) badges.push(['crit', `failed requests ${k.network.length}`]);
    if (d.buttonIssues?.length) badges.push(['warn', `buttons ${kac(d, 'buttonIssues')}`]);
    if (d.lowContrast?.length) badges.push(['warn', `contrast ${d.lowContrast.length}`]);
    if (d.smallTargets?.length) badges.push(['warn', `under 44px ${kac(d, 'smallTargets')}`]);
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
  main().catch((e) => { console.error(e.hint ? `\n  ${e.message}\n` : e); process.exit(1); });
}
