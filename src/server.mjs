#!/usr/bin/env node
/**
 * uisight — LIVE PANEL (multi-session, synchronised).
 *
 * Web + mobile side by side at the same time: each session gets its own Playwright
 * context and streams live over CDP screencast. You click and type in the panel and
 * it lands in that session. The address bar drives EVERY session at once. The AI sees,
 * measures and drives those same sessions over MCP (mcp.mjs).
 *
 * Usage:
 *   node server.mjs http://localhost:3000                  # web (desktop) + mobile (pixel)
 *   node server.mjs <url> --device iphone-se --web laptop  # pick the profiles
 *   node server.mjs <url> --single                         # mobile session only
 *   UISIGHT_FALLBACK=1 node server.mjs <url>               # fallback stream instead of screencast (testing)
 *
 * Human -> AI channel: the panel's "Mark" button queues a note + the current frame
 * under live/marks/, and the AI reads them with the MCP `marks` tool.
 */

import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PROFILES, deviceSettings, INSPECTION_SCRIPT, PERMISSION_HOOKS, missingBrowser } from './cli.mjs';
import { signIn, switchRole, recipeFor, accountNames, checkPort } from './login.mjs';
import { checkForUpdate } from './update-check.mjs';
import { normalizeTarget } from './target-url.mjs';
import { offerInstall } from './install-browser.mjs';


// Live artifacts live under the user's home — never inside the package (npx → node_modules).
const LIVE_DIR = join(homedir(), '.uisight', 'live');
const MARKS_DIR = join(LIVE_DIR, 'marks');
const READ_DIR = join(MARKS_DIR, 'read');
for (const d of [LIVE_DIR, MARKS_DIR, READ_DIR]) mkdirSync(d, { recursive: true });

// --- Arguments ---
const argv = process.argv.slice(2);

// `--help` used to fall through the URL parser and start a panel on the default
// page -- the flag looked like it did nothing.
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`uisight-panel - a live session you and your agent both watch.

  uisight-panel <url>                page to open (default http://localhost:3000)
  --device iphone-se,pixel           mobile sessions to run
  --desktop laptop                   add a desktop session
  --theme dark                       light | dark | both
  --port 5056                        panel port (default 5055)
  --single                           one session instead of the matrix
  --no-open                          do not open a browser

Then visit http://localhost:5055. Your agent reaches the same session
through the MCP server: npx -y -p uisight uisight-mcp`);
  process.exit(0);
}

const arg = (ad, vars) => { const i = argv.indexOf(ad); return i >= 0 && argv[i + 1] ? argv[i + 1] : vars; };
const FLAGS_WITH_VALUE = new Set(['--device', '--desktop', '--theme', '--port', '--locale']);
let targetUrl = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS_WITH_VALUE.has(a)) { i++; continue; }
  if (a.startsWith('--')) continue;
  if (!targetUrl) targetUrl = a;
}
const hedef = normalizeTarget(targetUrl);
if (hedef.error) {
  console.error(`  ! not a page this can measure: ${hedef.error}`);
  console.error('    Give an http(s) address, e.g. http://localhost:3000');
  process.exit(2);
}
targetUrl = hedef.url;

const PORT = Number(process.env.UISIGHT_PORT || process.env.MOBILQA_PORT || arg('--port', 5055));
checkPort(PORT);
checkForUpdate();            // arka planda, beklenmez
// Tam sayfa goruntusunun tavani (Claude'da ~ genislik*yukseklik/750 token).
// Ortamdan buyutulebilir: UISIGHT_MAX_IMAGE_TOKENS=4000
const MAX_IMAGE_TOKENS = Number(process.env.UISIGHT_MAX_IMAGE_TOKENS || 2000);
// Kareler varsayilan olarak 0.75'te uretilir: olculdu, ayirt edilemiyor, %44 ucuz.
// UISIGHT_FRAME_SCALE=1 tam ayrinti, 0.5 dortte bir maliyet.
const DEFAULT_FRAME_SCALE = Math.min(1, Math.max(0.25, Number(process.env.UISIGHT_FRAME_SCALE) || 0.75));

/**
 * Olcekli yakalama, CDP'nin kendi olcegiyle — ek bagimlilik yok, sayfada JS
 * calistirmak yok. CDP yoksa null doner ve cagiran tam boyuta duser.
 */
async function captureScaled(o, clip, scale) {
  if (!o.cdp) return null;
  try {
    // withTimeout baska bir kapsamda; burada kendi yarisini kur.
    const r = await Promise.race([
      o.cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 85,
        captureBeyondViewport: true,
        clip: { ...clip, scale },
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('capture timeout')), 20000)),
    ]);
    return r && r.data ? Buffer.from(r.data, 'base64') : null;
  } catch {
    return null;   // eski Chromium, kopmus oturum — sessizce tam boyuta dus
  }
}

const NO_OPEN = argv.includes('--no-open');
const SINGLE = argv.includes('--single');
const FORCE_FALLBACK = (process.env.UISIGHT_FALLBACK || process.env.MOBILQA_YEDEK) === '1';
const LOCALE = process.env.UISIGHT_LOCALE || arg('--locale', null);

// --- Security: this tool is a local server that DRIVES a browser session. Two layers:
//   (1) bind to loopback only (cuts off LAN access) — see listen() below.
//   (2) Host allowlist (DNS-rebinding guard, ALL endpoints) + an action token (CSRF guard, mutating endpoints).
// The panel sends the token in a header when it fetches its own origin; a malicious
// tab (POSTing to localhost from the same machine) cannot know it, and the text/plain
// form trick cannot add a custom header, so it is refused.
const TOKEN = randomUUID();
// Write the token to a per-port local file: the MCP server (a separate process on the
// same machine) reads it and sends it in a header. A cross-site page CANNOT read this file.
const TOKEN_FILE = join(LIVE_DIR, `token-${PORT}`);

/** Opens the browser per platform. `start` only exists on Windows; on macOS/Linux this
 *  used to fail silently (exec without a callback left no trace at all). */
export function openInBrowser(address) {
  const p = platform();
  const command = p === 'win32' ? `start "" "${address}"` : p === 'darwin' ? `open "${address}"` : `xdg-open "${address}"`;
  exec(command, p === 'win32' ? { shell: 'cmd.exe' } : {}, (e) => {
    if (e) console.error(`  ! could not open browser (${p}) — open manually: ${address}`);
  });
}
function hostAllowed(req) {
  const h = String(req.headers.host || '');
  const port = h.split(':')[1] || '';
  const ana = h.split(':')[0].toLowerCase();
  return (ana === 'localhost' || ana === '127.0.0.1' || ana === '[::1]' || ana === '::1')
    && (port === '' || port === String(PORT));
}

// --- Shared state ---
const state = {
  url: targetUrl,
  theme: arg('--theme', 'light'),
  error: null,
  records: [], // last 100 console/network records (ring buffer)
};

/** id -> session. Fixed ids: 'web' (desktop class), 'mobile' (phone class). */
const sessions = new Map();
let browser = null;
const clients = new Set(); // SSE

// --- Helpers ---
function broadcast(event, data) {
  const packet = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const r of clients) { try { r.write(packet); } catch { clients.delete(r); } }
}

function addRecord(sessionId, type, message) {
  const k = { time: new Date().toISOString(), session: sessionId, type, message: String(message).slice(0, 200) };
  state.records.push(k);
  if (state.records.length > 100) state.records.shift();
  broadcast('log', k);
}

const publicState = () => ({
  url: state.url,
  theme: state.theme,
  error: state.error,
  sessions: [...sessions.values()].map((o) => ({
    id: o.id, device: o.deviceKey, label: o.profile.label, viewport: o.viewport,
    mobile: o.profile.mobile !== false, keyboard: !!o.keyboard,
  })),
  devices: Object.entries(PROFILES).map(([k, v]) => ({ k, label: v.label, mobile: v.mobile !== false })),
  accounts: accountNames(state.url),
  records: state.records.slice(-30),
});

// --- Session lifecycle ---
async function closeSession(o) {
  if (!o) return;
  if (o.fallbackTimer) { clearInterval(o.fallbackTimer); o.fallbackTimer = null; }
  if (o.cdp) { try { o.cdp.removeAllListeners(); await o.cdp.detach(); } catch {} o.cdp = null; }
  if (o.ctx) { try { await o.ctx.close(); } catch {} o.ctx = null; }
}

async function openSession(id, deviceKey, theme) {
  await closeSession(sessions.get(id));
  sessions.delete(id); // hide this session from actions until the rebuild finishes

  const profile = PROFILES[deviceKey] || PROFILES[id === 'web' ? 'desktop' : 'pixel'];
  const settings = deviceSettings(profile.pw);
  if (!browser) {
    try { browser = await chromium.launch(); }
    catch (e) { throw missingBrowser(e, 'chromium'); }
  }

  // No locale is forced — see the same note in cli.mjs. --locale pins one.
  const ctx = await browser.newContext({ ...settings, colorScheme: theme, ...(LOCALE ? { locale: LOCALE } : {}) });
  const page = await ctx.newPage();
  await page.addInitScript(PERMISSION_HOOKS);   // sayfa kodundan ONCE
  const o = {
    id, deviceKey, profile, ctx, page, cdp: null, fallbackTimer: null,
    viewport: settings.viewport, fullViewport: settings.viewport, keyboard: false,
    lastFrame: null, lastWrite: 0,
  };
  // Register in the map only AFTER the first goto completes: when the setup goto races
  // an incoming `goto` action on the same page, Chromium can commit the late navigation
  // as chrome-error (hit during the Aug 17 MCP live test).

  // Focusing a text field raises the keyboard, exactly as on a phone. Chromium's
  // device emulation has NO soft keyboard, so without simulating it the whole
  // class of "the field ended up behind the keyboard" bugs is invisible here.
  page.exposeBinding('__uisightFocus', (_src, open) => applyKeyboard(o, open)).catch(() => {});
  page.addInitScript(() => {
    const isText = (el) => !!el && (
      (el.tagName === 'INPUT' && !['button', 'submit', 'checkbox', 'radio', 'range', 'file', 'color', 'reset', 'image'].includes((el.type || 'text').toLowerCase()))
      || el.tagName === 'TEXTAREA' || el.isContentEditable
    );
    addEventListener('focusin', (e) => { if (isText(e.target)) window.__uisightFocus?.(true); }, true);
    addEventListener('focusout', () => {
      setTimeout(() => { if (!isText(document.activeElement)) window.__uisightFocus?.(false); }, 120);
    }, true);
  }).catch(() => {});

  page.on('pageerror', (e) => addRecord(id, 'js-error', e));
  page.on('console', (m) => { if (m.type() === 'error') addRecord(id, 'console', m.text()); });
  page.on('response', (r) => { if (r.status() >= 400) addRecord(id, 'network', `${r.status()} ${r.url().slice(0, 120)}`); });
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) { state.url = f.url(); broadcast('state', publicState()); }
  });

  try {
    await page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    state.error = null;
  } catch (e) {
    state.error = String(e).split('\n')[0].slice(0, 160);
    addRecord(id, 'page', state.error);
  }

  sessions.set(id, o); // the page has settled — actions may reach it now
  await startStream(o);
  broadcast('state', publicState());
  return o;
}

/**
 * Show or hide the keyboard by shrinking and restoring the viewport.
 *
 * Checked against a real device (Pixel 7 / API 35): a phone keyboard covers
 * roughly 45% of the screen. The number is not meant to be pixel-exact, it is
 * meant to make the page answer "does this end up under the keyboard".
 */
const KEYBOARD_SHARE = 0.45;

async function applyKeyboard(o, open, force = false) {
  // The audit measures WITHOUT shrinking (see below). If this listener shrank the
  // viewport underneath it, every field would look hidden.
  if (o?.auditing && !force) return;
  if (!o || !o.page || o.keyboard === open) return;
  if (!o.profile || o.profile.mobile === false) return;
  o.keyboard = open;
  const full = o.fullViewport || o.viewport;
  const next = open ? { width: full.width, height: Math.round(full.height * (1 - KEYBOARD_SHARE)) } : full;
  try {
    await o.page.setViewportSize(next);
    o.viewport = next;
    addRecord(o.id, 'keyboard', open ? `open — viewport ${next.height}px (was ${full.height}px)` : 'closed');
    broadcast('state', publicState());
  } catch (e) {
    addRecord(o.id, 'keyboard', 'could not apply: ' + String(e).slice(0, 80));
  }
}

/** Frame stream: CDP screencast first (3 attempts), falling back to a screenshot per second.
 *  Screencast is not critical on its own — if it dies the panel still works. */
async function startStream(o) {
  if (o.fallbackTimer) { clearInterval(o.fallbackTimer); o.fallbackTimer = null; }

  // CDP setup can silently hang on a second context — cap every attempt at 5s
  // and fall through to the screenshot-interval fallback (seen 2026-08-19).
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout ${ms}ms`)), ms))]);

  if (!FORCE_FALLBACK) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        o.cdp = await withTimeout(o.ctx.newCDPSession(o.page), 5000);
        o.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
          try { await o.cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
          handleFrame(o, data);
        });
        await withTimeout(o.cdp.send('Page.startScreencast', {
          format: 'jpeg', quality: 70,
          maxWidth: o.viewport.width, maxHeight: o.viewport.height, everyNthFrame: 1,
        }), 5000);
        console.log(`  stream[${o.id}]: CDP screencast (live)`);
        // First-frame guarantee: screencast only emits on repaint — a fully static
        // page would leave the pane blank until something moves.
        try { handleFrame(o, (await o.page.screenshot({ type: 'jpeg', quality: 70, scale: 'css' })).toString('base64')); } catch {}
        return;
      } catch (e) {
        console.error(`  ! screencast[${o.id}] attempt ${attempt}/3 — ${String(e).split('\n')[0].slice(0, 90)}`);
        try { o.cdp?.removeAllListeners(); await o.cdp?.detach(); } catch {}
        o.cdp = null;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  console.log(`  stream[${o.id}]: FALLBACK mode — one frame per second${FORCE_FALLBACK ? ' (UISIGHT_FALLBACK=1)' : ''}`);
  o.fallbackTimer = setInterval(async () => {
    if (!o.page) return;
    try { handleFrame(o, (await o.page.screenshot({ type: 'jpeg', quality: 70, scale: 'css' })).toString('base64')); } catch {}
  }, 1000);
}

function handleFrame(o, b64) {
  o.lastFrame = b64;
  o.lastFrameAt = Date.now();   // yasini bilmeden tazeligine guvenemeyiz
  broadcast('frame', { session: o.id, img: b64 });
  const t = Date.now();
  if (t - o.lastWrite > 1000) {
    o.lastWrite = t;
    try { writeFileSync(join(LIVE_DIR, `last-${o.id}.jpg`), Buffer.from(b64, 'base64')); } catch {}
  }
}

// --- Eylemler ---
const normalizeUrl = (u) => (/^https?:\/\//.test(u) ? u : 'http://' + u);

/** Target session for click/type/scroll; defaults to mobile, then to the first session. */
const targetSession = (g) => sessions.get(g.session) || sessions.get('mobile') || [...sessions.values()][0];

async function applyAction(g) {
  if (!sessions.size) return { ok: false, message: 'no session ready yet' };

  switch (g.type) {
    case 'goto': {
      state.url = normalizeUrl(g.url);
      for (const o of sessions.values()) {
        await o.page.goto(state.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
          .catch((e) => addRecord(o.id, 'page', String(e).split('\n')[0]));
      }
      return { ok: true };
    }
    case 'back': for (const o of sessions.values()) await o.page.goBack().catch(() => {}); return { ok: true };
    case 'forward': for (const o of sessions.values()) await o.page.goForward().catch(() => {}); return { ok: true };
    case 'reload': for (const o of sessions.values()) await o.page.reload().catch(() => {}); return { ok: true };

    case 'click': {
      const o = targetSession(g);
      if (g.selector) { await o.page.click(g.selector, { timeout: 5000 }); return { ok: true, session: o.id }; }
      if (o.profile.mobile !== false) await o.page.touchscreen.tap(g.x, g.y);
      else await o.page.mouse.click(g.x, g.y);
      return { ok: true, session: o.id };
    }
    case 'scroll': {
      const o = targetSession(g);
      await o.page.mouse.move(o.viewport.width / 2, o.viewport.height / 2);
      await o.page.mouse.wheel(0, g.dy);
      return { ok: true, session: o.id };
    }
    case 'press': {
      const o = targetSession(g);
      if (g.key) await o.page.keyboard.press(g.key);
      else if (g.text) await o.page.keyboard.type(g.text);
      return { ok: true, session: o.id };
    }

    case 'device': {
      // {session, device} changes that session's profile; {theme} without a session rebuilds ALL sessions in the new theme.
      // The session id ends up in a filename (last-<id>.jpg) -> stop path traversal right here.
      if (g.session && !/^[a-zA-Z0-9_-]{1,32}$/.test(String(g.session))) {
        return { ok: false, message: 'invalid session id' };
      }
      // When a theme applies to a SINGLE session, leave the global field alone: the panel/status
      // used to say "dark" while an untouched session was still light (a lying state).
      if (g.theme && !g.session) state.theme = g.theme;
      if (g.session && g.device) {
        const existed = sessions.get(g.session);
        await openSession(g.session, g.device, g.theme || state.theme);
        if (!existed) addRecord(g.session, 'session', `new session: ${g.device}`);
      } else {
        for (const o of [...sessions.values()]) await openSession(o.id, g.device || o.deviceKey, state.theme);
      }
      return { ok: true };
    }

    case 'keyboard': {
      const targets = g.session ? [sessions.get(g.session)].filter(Boolean) : [...sessions.values()];
      for (const o of targets) await applyKeyboard(o, !!g.open, true);
      return { ok: true };
    }

    // Internet gidince ne oluyor: bir aciklama mi, sonsuz donen bir cember mi?
    //
    // Bu statik olarak olculemez — aginin gercekten kesilmesi gerekir. Once
    // kesilir, sayfa yenilenir, sonra sayfanin durumu SOYLEYIP soylemedigine
    // bakilir. Baglanti her kosulda geri acilir (hata da olsa), yoksa oturum
    // cevrimdisi kilitli kalir.
    case 'offline-audit': {
      const targets = g.session ? [sessions.get(g.session)].filter(Boolean) : [...sessions.values()];
      const results = [];
      for (const o of targets) {
        const before = o.page.url();
        let findings = [];
        try {
          // Sayfanin kendi cevrimdisi tedbiri VAR MI: service worker yoksa
          // baglanti kesilince tarayicinin hata sayfasi cikar ve bu bir uygulama
          // hatasi degildir. "Cevrimdisi da calisir" diyen bir PWA icin ise
          // aynisi tam olarak hatadir. Ayrimi kurmadan verilen bulgu yaniltir.
          const hasWorker = await o.page.evaluate(async () => {
            try {
              if (!navigator.serviceWorker) return false;
              const regs = await navigator.serviceWorker.getRegistrations();
              return regs.length > 0;
            } catch { return false; }
          }).catch(() => false);

          // 🔴 Bir service worker KURULUR ama kurulduğu sayfayı KONTROL ETMEZ:
          // `navigator.serviceWorker.controller` ilk ziyarette null'dir, kontrol
          // ikinci ziyarette/reload'da baslar. Bunu beklemeden cevrimdisina
          // gecmek HER PWA'yi "cevrimdisinda bos" diye raporlar ve gercek
          // bozukluk ile normal davranis ayirt edilemez hale gelir.
          //
          // Bir kullanici SW'sini duzeltti, arac hala "blank" dedi; sebep buydu.
          if (hasWorker) {
            const kontrolde = await o.page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false);
            if (!kontrolde) {
              await o.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
              await o.page.waitForFunction(
                () => navigator.serviceWorker && navigator.serviceWorker.controller != null,
                { timeout: 15000 },
              ).catch(() => {});   // devralmadiysa yine olc; sonuc yine de bilgi
            }
          }

          await o.ctx.setOffline(true);
          let navFailed = false;
          await o.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 })
            .catch(() => { navFailed = true; });
          await o.page.waitForTimeout(2500);

          const state = await o.page.evaluate(() => ({
            url: location.href,
            text: ((document.body && document.body.innerText) || '').trim(),
          })).catch(() => ({ url: '', text: '' }));

          // Tarayicinin kendi hata sayfasi: govdesi otomasyonda BOS gelir, yani
          // "ekran bos" demek yanlis olur — sayfa hic yuklenmedi.
          const browserError = navFailed || state.url.startsWith('chrome-error');

          if (browserError) {
            findings = [{
              kind: hasWorker ? 'worker-serves-nothing' : 'no-offline-fallback',
              note: hasWorker
                ? 'offline: a service worker is registered but served nothing — the browser error page appeared'
                : 'offline: nothing cached, the page did not load at all (expected without a service worker)',
              expected: !hasWorker,
            }];
          } else {
            findings = await o.page.evaluate(() => {
              const text = ((document.body && document.body.innerText) || '');
              const fold = text.replace(/[\u00e7\u011f\u0131\u00f6\u015f\u00fc]/g, (c) =>
                ({ '\u00e7': 'c', '\u011f': 'g', '\u0131': 'i', '\u00f6': 'o', '\u015f': 's', '\u00fc': 'u' }[c] || c));
              const says = /(internet|baglant|cevrimdisi|offline|no connection|network|tekrar dene|try again|yeniden dene)/i.test(fold);
              const retry = [...document.querySelectorAll('button, a[href]')]
                .some((el) => /tekrar|yeniden|retry|try again|reload/i.test((el.innerText || '')));
              if (says || retry) return [];

              // Donen cember tek basina, bu kontrolun var olma sebebidir: hicbir
              // sey gelmiyorken bir sey geliyormus gibi soz verir.
              const spinner = [...document.querySelectorAll('[class*="spin" i],[class*="load" i],[role="progressbar"],svg animate,svg animateTransform')]
                .some((el) => el.getBoundingClientRect().width > 0);
              if (spinner) return [{ kind: 'spinner-forever', note: 'offline: a spinner and nothing else' }];
              if (fold.trim().length < 20) return [{ kind: 'blank', note: 'offline: the app rendered an empty screen' }];
              return [{ kind: 'silent', note: 'offline: the app never mentions the connection' }];
            });
          }
        } catch (e) {
          findings = [{ kind: 'error', note: String(e).split('\n')[0].slice(0, 120) }];
        } finally {
          // Her kosulda geri ac.
          try { await o.ctx.setOffline(false); } catch {}
          await o.page.goto(before, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }
        results.push({ session: o.id, url: before, findings });
      }
      return { ok: true, results };
    }

    // Geri tusu bir onceki ekrana donmeli, uygulamayi kapatmamali.
    //
    // Olculen sey: ic bir baglantiya gidip geri dondugunde ADRES basladigi yere
    // donuyor mu ve ekranda hala bir sey var mi. Cikilan yerin bos donmesi,
    // kullanicinin "geri" deyince uygulamadan dusmesi demektir.
    case 'back-audit': {
      const targets = g.session ? [sessions.get(g.session)].filter(Boolean) : [...sessions.values()];
      const results = [];
      for (const o of targets) {
        const start = o.page.url();
        const root = new URL(start).origin;
        const findings = [];
        try {
          const link = await o.page.evaluate((r) => {
            const a = [...document.querySelectorAll('a[href]')]
              .map((x) => x.href)
              .find((h) => h.startsWith(r) && h !== location.href && !h.includes('#'));
            return a || null;
          }, root);
          if (!link) {
            results.push({ session: o.id, url: start, findings: [], note: 'no internal link to follow' });
            continue;
          }
          await o.page.goto(link, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await o.page.waitForTimeout(1200);
          await o.page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await o.page.waitForTimeout(1500);

          const back = o.page.url();
          const body = await o.page.evaluate(() => ((document.body && document.body.innerText) || '').trim().length);
          if (back.replace(/\/$/, '') !== start.replace(/\/$/, '')) {
            findings.push({ kind: 'wrong-page', note: `back landed on ${back}, expected ${start}` });
          } else if (body < 20) {
            findings.push({ kind: 'blank', note: 'back returned to the right address but an empty screen' });
          }
        } catch (e) {
          findings.push({ kind: 'error', note: String(e).split('\n')[0].slice(0, 120) });
        } finally {
          await o.page.goto(start, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }
        results.push({ session: o.id, url: start, findings });
      }
      return { ok: true, results };
    }

    // Olculen seyin KIMLIGI. Bayat bir dev sunucusu diskteki degisiklige ragmen
    // eski CSS'i servis edebiliyor — ve dosya adi bile degismiyor, yani ad
    // karsilastiran hicbir kontrol yakalayamaz. Bir kullanici yarim saatini
    // ONCEDEN duzeltilmis bir hatayi duzeltmeye harcadi.
    //
    // Bu dogrudan fark moduna dokunuyor: sunucu bayatsa "hicbir sey degismedi"
    // DOGRU GORUNEN YANLIS cevaptir.
    case 'build-id': {
      const o = targetSession(g);
      if (!o) return { ok: false, message: 'no such session' };
      const kimlik = await o.page.evaluate(() => {
        const al = (s) => document.querySelector(s)?.getAttribute('content') || null;
        let next = null;
        try { next = window.__NEXT_DATA__?.buildId || null; } catch { /* yok */ }
        // Stil sayfalarinin adresleri: hash'liyse degisiklik burada gorunur.
        const css = [...document.styleSheets]
          .map((s) => s.href).filter(Boolean).map((h) => h.split('/').pop()).sort().join(',');
        return {
          buildId: next,
          version: al('meta[name="version"]') || al('meta[name="build"]'),
          css: css.slice(0, 300),
          scripts: [...document.scripts].map((s) => s.src).filter(Boolean)
            .map((h) => h.split('/').pop()).sort().join(',').slice(0, 300),
        };
      }).catch(() => null);
      return { ok: true, url: o.page.url(), identity: kimlik };
    }

    case 'keyboard-audit': {
      // Two different failures, and one model cannot see both. Both verified on a
      // real device:
      //
      //   a focused field  — Chrome scrolls it ABOVE the keyboard, so it is NOT a
      //                      bug. Measure by shrinking the viewport, letting the
      //                      browser reflow and scroll, and only then looking.
      //   a fixed bottom bar — stays pinned to the LAYOUT bottom and vanishes
      //                      behind the keyboard. Shrinking moves it up and HIDES
      //                      the bug, so measure it against a band instead.
      const targets = g.session ? [sessions.get(g.session)].filter(Boolean) : [...sessions.values()];
      const results = [];
      for (const o of targets) {
        if (!o || o.profile.mobile === false) continue;
        const was = o.keyboard;
        await applyKeyboard(o, false, true);
        o.auditing = true;
        const findings = [];
        try {
          const fields = await o.page.$$('input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=range]):not([type=file]), textarea, [contenteditable="true"]');
          for (const el of fields.slice(0, 15)) {
            let name = '(unnamed)';
            try {
              name = await el.evaluate((e) => e.getAttribute('aria-label') || e.placeholder || e.name || e.id || e.tagName.toLowerCase());
            } catch { /* keep the fallback */ }
            try {
              await el.scrollIntoViewIfNeeded({ timeout: 3000 });
              await el.focus({ timeout: 3000 });
            } catch { continue; }
            await applyKeyboard(o, true, true);
            await new Promise((r) => setTimeout(r, 500));
            await el.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
            await new Promise((r) => setTimeout(r, 250));
            const m = await el.evaluate((e) => {
              const r = e.getBoundingClientRect();
              return { top: r.top, bottom: r.bottom, height: r.height, screen: innerHeight };
            }).catch(() => null);
            if (!m) continue;
            const shown = Math.max(0, Math.min(m.bottom, m.screen) - Math.max(m.top, 0));
            const ratio = m.height > 0 ? shown / m.height : 1;
            if (ratio < 0.6) {
              findings.push({
                field: String(name).slice(0, 40), visiblePercent: Math.round(ratio * 100),
                position: Math.round(m.top) + '-' + Math.round(m.bottom) + 'px',
                screen: m.screen, kind: 'field',
              });
            }
          }
        } catch (e) {
          findings.push({ error: String(e).split(String.fromCharCode(10))[0].slice(0, 120) });
        }

        try {
          await applyKeyboard(o, false, true);
          await new Promise((r) => setTimeout(r, 300));
          const bars = await o.page.evaluate((share) => {
            const c = [];
            for (const el of document.querySelectorAll('button, a[href], input[type=submit]')) {
              let pinned = false;
              for (let n = el; n && n !== document.body; n = n.parentElement) {
                const s = getComputedStyle(n);
                if (s.position === 'fixed' || s.position === 'sticky') { pinned = true; break; }
              }
              if (!pinned || getComputedStyle(el).display === 'none') continue;
              const r = el.getBoundingClientRect();
              if (r.width < 40 || r.height < 20) continue;

              // A floating chat/help button sitting behind the keyboard is normal —
              // nearly every app has one, and reporting all of them is noise. What
              // actually blocks a person is an ACTION BAR: a wide button, or a
              // submit, that they cannot reach to finish the form.
              const wide = r.width >= innerWidth * 0.4;
              const submits = el.type === 'submit' || /submit/i.test(el.getAttribute('type') || '');
              if (!wide && !submits) continue;

              // 🔴 `interactive-widget=resizes-content` klavye acilinca DUZEN gorus
              // alanini da kucultur; yapiskan cubuk klavyenin USTUNE cikar ve sorun
              // biter. Band modeli bunu bilmedigi icin, calisan bir duzeltmeden
              // SONRA ayni bulguyu ayni sayiyla veriyordu — bir kullanici bu yuzden
              // dogru duzeltmesini neredeyse geri aliyordu.
              //
              // Araci "duzeltmen tutmadi" dedirten hata, hic bulmayan hatadan kotudur.
              const meta = document.querySelector('meta[name="viewport"]');
              const icerikKuculuyor = /interactive-widget\s*=\s*resizes-content/i
                .test(meta ? meta.getAttribute('content') || '' : '');
              if (icerikKuculuyor) continue;   // cubuk klavyenin ustune cikar

              const band = innerHeight * (1 - share);
              const shown = Math.max(0, Math.min(r.bottom, band) - Math.max(r.top, 0));
              if (shown / r.height < 0.5) {
                c.push({
                  field: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 40) || '(no text)',
                  visiblePercent: Math.round((shown / r.height) * 100),
                  position: Math.round(r.top) + '-' + Math.round(r.bottom) + 'px',
                  screen: innerHeight, keyboardFreeBand: Math.round(band), kind: 'pinned-control',
                });
              }
            }
            return c.slice(0, 6);
          }, KEYBOARD_SHARE);
          findings.push(...bars);
        } catch { /* the page may have navigated */ }

        o.auditing = false;
        await applyKeyboard(o, was, true);
        results.push({ session: o.id, device: o.deviceKey, findings });
        addRecord(o.id, 'keyboard', `audit: ${findings.length} under the keyboard`);
      }
      return { ok: true, results };
    }

    case 'login': {
      // Lets the audit reach past the sign-in wall. Recipes in ~/.uisight/accounts.json.
      const o = targetSession(g);
      const recipe = g.recipe || recipeFor(state.url, g.account || null);
      if (!recipe) {
        return { ok: false, message: `no recipe for this host — add it to ~/.uisight/accounts.json: ${new URL(state.url).host}` };
      }
      addRecord(o.id, 'login', `account: ${g.account || recipe.name || '(default)'}`);
      const s = await signIn(o.page, recipe, (m) => addRecord(o.id, 'login', m));
      addRecord(o.id, 'login', s.ok ? `signed in (${s.route}) -> ${s.message}` : `failed [${s.step}]: ${s.message}`);
      if (s.ok) { state.url = o.page.url(); broadcast('state', publicState()); }
      return { ok: s.ok, result: s };
    }

    case 'role': {
      const o = targetSession(g);
      const recipe = recipeFor(state.url, g.account || null);
      if (!recipe) return { ok: false, message: 'no recipe for this host' };
      const s = await switchRole(o.page, recipe, g.role, (m) => addRecord(o.id, 'role', m));
      if (s.ok) { state.url = o.page.url(); broadcast('state', publicState()); }
      else addRecord(o.id, 'role', 'failed: ' + s.message);
      return s;
    }

    case 'links': {
      // Routes come from the app's OWN links, not from memory — a hand-guessed
      // path was a 404 while the real one sat one link away.
      const o = targetSession(g);
      const root = g.root || new URL(state.url).origin;
      const list = await o.page.evaluate((r) => [...new Set(
        [...document.querySelectorAll('a[href]')].map((a) => a.href)
          .filter((h) => h.startsWith(r))
          .map((h) => { const u = new URL(h); return u.origin + u.pathname; })
      )], root).catch(() => []);
      return { ok: true, links: list.slice(0, 40) };
    }

    case 'inspect': {
      const results = [];
      const targets = g.session ? [sessions.get(g.session)].filter(Boolean) : [...sessions.values()];
      for (const o of targets) {
        try {
          // Timeout: a blocking native dialog on the target page would otherwise leave evaluate hanging forever.
          o.page.setDefaultTimeout(20000);
          const d = await o.page.evaluate(INSPECTION_SCRIPT, { mobile: o.profile.mobile !== false, theme: state.theme });
          results.push({ session: o.id, device: o.deviceKey, label: o.profile.label, theme: state.theme, url: state.url, inspection: d });
        } catch (e) {
          results.push({ session: o.id, device: o.deviceKey, error: String(e).slice(0, 200) });
        }
      }
      writeFileSync(join(LIVE_DIR, 'inspect.json'), JSON.stringify(results, null, 2), 'utf8');
      return { ok: true, results };
    }

    case 'mark': {
      // Human -> AI: the note + the current frame go into the queue.
      const o = targetSession(g);
      const ts = Date.now();
      const imageName = `${ts}-${o.id}.jpg`;
      // With an area, crop to it. Sending the whole screen is the weakest way to
      // say "the problem is here" — the AI has to guess where to look.
      const area = g.area && g.area.width > 4 && g.area.height > 4 ? g.area : null;
      try {
        const buf = area
          ? await o.page.screenshot({ type: 'jpeg', quality: 90, scale: 'css', clip: area })
          : (o.lastFrame ? Buffer.from(o.lastFrame, 'base64')
                         : await o.page.screenshot({ type: 'jpeg', quality: 85, scale: 'css' }));
        writeFileSync(join(MARKS_DIR, imageName), buf);
      } catch {}
      const record = {
        time: new Date(ts).toISOString(), session: o.id, device: o.deviceKey, label: o.profile.label,
        theme: state.theme, url: state.url, note: String(g.note || '').slice(0, 500), image: imageName,
        area: area || null,
      };
      writeFileSync(join(MARKS_DIR, `${ts}.json`), JSON.stringify(record, null, 2), 'utf8');
      addRecord(o.id, 'mark', record.note || '(mark without note)');
      return { ok: true, record };
    }

    case 'save': {
      const paths = {};
      const targets = g.session ? [sessions.get(g.session)].filter(Boolean) : [...sessions.values()];
      for (const o of targets) {
        const path = join(LIVE_DIR, `last-${o.id}.jpg`);
        await o.page.screenshot({ path: path, type: 'jpeg', quality: 90, scale: 'css', fullPage: !!g.full });
        paths[o.id] = path;
      }
      return { ok: true, paths };
    }

    default: return { ok: false, message: 'unknown action' };
  }
}

/** Returns pending marks; with clear=1 they are moved under read/. */
function readMarks(clear) {
  const files = readdirSync(MARKS_DIR).filter((f) => f.endsWith('.json')).sort();
  const list = [];
  for (const f of files) {
    try {
      const k = JSON.parse(readFileSync(join(MARKS_DIR, f), 'utf8'));
      k.imagePath = join(MARKS_DIR, k.image);
      list.push(k);
      if (clear) {
        renameSync(join(MARKS_DIR, f), join(READ_DIR, f));
        try { renameSync(join(MARKS_DIR, k.image), join(READ_DIR, k.image)); k.imagePath = join(READ_DIR, k.image); } catch {}
      }
    } catch {}
  }
  return list;
}

// --- HTTP ---
// 1 MB cap: unbounded accumulation was an open door to memory exhaustion.
const MAX_BODY = 1024 * 1024;
const readBody = (req) => new Promise((c) => {
  let s = '';
  req.on('data', (d) => {
    s += d;
    if (s.length > MAX_BODY) { s = ''; req.destroy(); c({}); }
  });
  req.on('end', () => { try { c(JSON.parse(s || '{}')); } catch { c({}); } });
  req.on('error', () => c({}));
});

const handleRequest = async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // DNS-rebinding guard: even if an attacker's domain resolves to loopback, the Host header will not match.
  if (!hostAllowed(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden host');
  }

  // The token is REQUIRED on mutating endpoints (CSRF guard). The panel sends it in a
  // header; cross-site requests cannot add custom headers, so they never get this far.
  const MUTATING = new Set(['/action']);
  if (MUTATING.has(u.pathname) && req.headers['x-uisight-token'] !== TOKEN) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, message: 'invalid or missing token' }));
  }

  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PANEL_HTML_SABLON.replace('__TOKEN__', TOKEN));
  }

  if (u.pathname === '/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    res.on('error', () => clients.delete(res));
    req.on('error', () => clients.delete(res));
    req.on('close', () => clients.delete(res));
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    for (const o of sessions.values()) {
      if (o.lastFrame) res.write(`event: frame\ndata: ${JSON.stringify({ session: o.id, img: o.lastFrame })}\n\n`);
    }
    return;
  }

  if (u.pathname === '/action' && req.method === 'POST') {
    const g = await readBody(req);
    let result;
    try { result = await applyAction(g); } catch (e) { result = { ok: false, message: String(e).slice(0, 200) }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(result));
  }

  if (u.pathname === '/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(publicState()));
  }

  if (u.pathname === '/frame') {
    const o = sessions.get(u.searchParams.get('session')) || targetSession({});
    if (!o) { res.writeHead(404); return res.end('no such session'); }

    // An image costs the model about width*height/750 tokens, and it is not paid
    // once: it stays in the conversation and is re-sent on every later turn.
    //
    // Measured on a real page, rather than assumed: at 0.75 the same screen is
    // indistinguishable — small print included — for 44% less. At 0.5 the layout
    // and every meaningful label still read; only the smallest legal text goes
    // soft, for a quarter of the price. So 0.75 is the default, and detail is
    // one parameter away.
    const scale = Math.min(1, Math.max(0.25, Number(u.searchParams.get('scale')) || DEFAULT_FRAME_SCALE));
    const full = u.searchParams.get('full') === '1';

    try {
      let buf = null;
      let clipped = null;
      let size = null;
      let frameAge = null;

      if (full) {
        // A long page has no ceiling: 10,500px is ~5,800 tokens at full size and
        // a 20,000px one is ~11,000. Scaling stretches the budget rather than
        // replacing it — the height is still capped, and the response says what
        // was left out instead of silently spending or silently truncating.
        size = await o.page.evaluate(() => ({
          w: Math.ceil(document.documentElement.scrollWidth),
          h: Math.ceil(document.documentElement.scrollHeight),
        }));
        const maxH = Math.max(
          1,
          Math.floor((MAX_IMAGE_TOKENS * 750) / Math.max(1, size.w * scale * scale)),
        );
        const h = Math.min(size.h, maxH);
        if (h < size.h) clipped = `${h}/${size.h}`;
        buf = await captureScaled(o, { x: 0, y: 0, width: size.w, height: h }, scale);
      } else {
        size = o.page.viewportSize() || { w: 0, h: 0 };
        const w = size.width || size.w;
        const hh = size.height || size.h;
        if (scale < 1 && w && hh) {
          buf = await captureScaled(o, { x: 0, y: 0, width: w, height: hh }, scale);
        }
        // Scale 1, or no CDP: the cached screencast frame is already the cheapest
        // path — no extra capture at all.
        // Onbellekli screencast karesi ucuzdur ama DOGRU olmasi screencast'in
        // ayak uydurmasina baglidir. Uyduramadiginda — durmus akis, mesgul sayfa,
        // yedek yola dusme — ajan sessizce ESKI ekrani gorur ve "layout bozuldu"
        // gibi bir sonuca varir. Sahadan boyle bir bildirim geldi; burada
        // tekrarlanamadi ama hata yapisal olarak mumkun ve sonucu agir.
        //
        // Cozum yasa bakmak: taze kare varsa onu kullan (bedava), yaslanmissa
        // yeniden yakala (olculdu: 35ms). Screencast durursa kendiliginden
        // duzelir ve x-frame-age basligi ne oldugunu soyler.
        const yas = o.lastFrameAt ? Date.now() - o.lastFrameAt : Infinity;
        frameAge = yas;
        if (!buf) {
          buf = (o.lastFrame && yas < 250)
            ? Buffer.from(o.lastFrame, 'base64')
            : await o.page.screenshot({ type: 'jpeg', quality: 85, scale: 'css' });
        }
      }

      const head = { 'content-type': 'image/jpeg', 'x-session': o.id, 'x-scale': String(scale) };
      if (clipped) head['x-clipped'] = clipped;
      if (frameAge != null) head['x-frame-age'] = String(Math.round(frameAge));
      res.writeHead(200, head);
      return res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: String(e).slice(0, 200) }));
    }
  }

  if (u.pathname === '/marks') {
    const list = readMarks(u.searchParams.get('clear') === '1');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ marks: list }));
  }

  res.writeHead(404); res.end('not found');
};

// A throw inside a handler used to destroy the connection with no reply, which
// reads to every caller as "nothing is running there". An endpoint may fail;
// the panel must still answer.
const server = createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.error('  ! request failed:', String(e).split('\n')[0].slice(0, 160));
    try {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: String(e).slice(0, 200) }));
    } catch {}
  });
});

// --- Panel ---
const PANEL_HTML_SABLON = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>uisight — Live Panel</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#1e1f22; color:#dfe1e5; font:13px/1.5 "Segoe UI",system-ui,sans-serif; display:flex; flex-direction:column; height:100vh; }
  .ust { background:#2b2d30; border-bottom:1px solid #393b40; padding:8px 12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  button, select, input { background:#3c3f43; color:#dfe1e5; border:1px solid #4c5054; border-radius:6px; padding:5px 10px; font:inherit; cursor:pointer; }
  button:hover { background:#4a4e53; }
  input { cursor:text; }
  #url { flex:1; min-width:160px; }
  #toastLine { min-width:170px; }
  .gov { flex:1; display:flex; gap:14px; padding:14px; overflow:auto; align-items:flex-start; }
  .ekranlar { display:flex; gap:14px; align-items:flex-start; flex-wrap:wrap; }
  .tel { background:#111214; border:2px solid #45474d; border-radius:16px; padding:8px; }
  .tel.aktif { border-color:#4c6fd6; }
  .tel header { display:flex; gap:6px; align-items:center; padding:2px 4px 8px; font-size:11px; color:#9da0a8; }
  .tel header select { font-size:11px; padding:2px 6px; }
  .tel header .pin { padding:2px 8px; }
  .tel img { display:block; border-radius:10px; background:#000; cursor:default; max-height:74vh; width:auto; max-width:46vw; }
  /* Crosshair only while selecting. A permanent one made simply looking at the
     panel feel like something was being demanded of you. */
  .tel.picking img { cursor:crosshair; }
  .tel { position:relative; }
  .pickBox { position:absolute; border:2px solid #4c6fd6; background:#4c6fd633; pointer-events:none; display:none; }
  .pickHint { position:absolute; left:8px; right:8px; top:8px; z-index:3; text-align:center;
    background:#1e1f22e6; border:1px solid #4c6fd6; border-radius:6px; padding:6px 8px; font-size:12px; display:none; }
  .tel.picking .pickHint { display:block; }
  .yan { flex:1; min-width:230px; display:flex; flex-direction:column; gap:10px; }

  /* Dar mod (?narrow=1) — IDE kenar cubugu icin.
     Kenar cubugu ~300px; iki ekran YAN YANA sigmaz — telefon cercevesi tek
     basina 412px. Ilk cozum masaustu oturumunu gizlemekti, ve o yanlisti:
     "telefon ve masaustu birlikte" bu aracin butun tezi, ve gizlemek onu tam
     da insanin bakmayi aliskanlik ettigi yerden cikariyor. Yan yana sigmayan
     sey alt alta siger. Masaustu ustte, kucuk: 1440px'i 284px'e indirince
     yazi okunmaz ama duzenin bozulup bozulmadigi gorunur, ve okumak icin
     zaten Inspect var. */
  body.narrow .gov { flex-direction:column; padding:8px; gap:8px; }
  body.narrow .ekranlar { flex-direction:column; max-width:100%; }
  body.narrow .tel[data-session="web"] { order:-1; }
  /* Kart genisligini goruntu belirler ve goruntu genisligini kart belirler:
     dairesel. Acik bir tavan olmadan kart dogal boyutuna acilir ve kenar
     cubugundan tasar — bu yuzden kart da goruntu de kaba zorlanir. */
  body.narrow .tel { padding:4px; border-radius:10px; width:100%; max-width:100%; box-sizing:border-box; }
  body.narrow .tel img { width:100%; max-width:min(100%, var(--vp, 100%)); max-height:none; height:auto; margin:0 auto; display:block; }
  body.narrow .yan { min-width:0; max-width:100%; }
  body.narrow .ust { padding:6px 8px; gap:6px; }
  /* Baslik dar alanda uc satira boluniyor ve igneyi kenardan kirpiyordu:
     etiket tek satirda kisalir, secici kalani alir, igne hep gorunur. */
  body.narrow .tel header { gap:4px; font-size:10px; flex-wrap:nowrap; max-width:100%; }
  body.narrow .tel header > b {
    flex:0 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  }
  /* Secici de kisalabilmeli: flex:1 sabit taban genisligiyle birlesince kart
     genisligini iceriden itiyor ve igneyi kenardan disari atiyordu. */
  body.narrow .tel header select { flex:1 1 0; min-width:0; width:0; }
  body.narrow .tel header .pin { flex:0 0 auto; }
  .kutu { background:#2b2d30; border:1px solid #393b40; border-radius:8px; padding:10px; }
  .kutu h3 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#9da0a8; }
  #record { font-family:ui-monospace,Consolas,monospace; font-size:11px; max-height:170px; overflow:auto; }
  #record div { padding:2px 0; border-bottom:1px solid #33363b; }
  .k { color:#ffb4ab; } .u { color:#ffd77a; } .i { color:#8ab4f8; }
  #finding { font-size:12px; max-height:34vh; overflow:auto; }
  #finding ul { margin:4px 0 10px; padding-left:16px; }
  #finding h4 { margin:8px 0 2px; font-size:12px; color:#c3c6cc; }
  .badges { display:inline-block; font-size:11px; padding:1px 7px; border-radius:9px; margin:2px 3px 2px 0; }
  .statusLine { font-size:11px; color:#9da0a8; }
</style></head><body>
<div class="ust">
  <button onclick="act({type:'back'})">◀</button>
  <button onclick="act({type:'forward'})">▶</button>
  <button onclick="act({type:'reload'})">⟳</button>
  <input id="url" onkeydown="if(event.key==='Enter')act({type:'goto',url:this.value})" placeholder="http://localhost:3000">
  <button onclick="act({type:'goto',url:document.getElementById('url').value})">Go</button>
  <select id="theme" onchange="act({type:'device',theme:this.value})">
    <option value="light">light</option><option value="dark">dark</option>
  </select>
  <button onclick="denetle()">Inspect</button>
  <input id="note" placeholder="mark note (goes to your AI)">
  <span class="statusLine" id="statusLine"></span>
</div>
<div class="gov">
  <div class="ekranlar" id="ekranlar"></div>
  <div class="yan">
    <div class="kutu"><h3>Inspection</h3><div id="finding" class="statusLine">"Inspect" runs color/theme/button checks on every screen; findings come back per device.</div></div>
    <div class="kutu"><h3>Live log (console · network · marks)</h3><div id="record"></div></div>
    <div class="kutu statusLine">Click a screen = tap on that device · wheel = scroll · click first to type.<br>📌 = drops your note + the current frame into the AI queue (MCP <code>marks</code>).</div>
  </div>
</div>
<script>
  const vp = {}; // session -> viewport
  let deviceList = [];
  let activeSession = 'mobile';

  // The token is what stops a web page you happen to be visiting from driving
  // your browser session: it travels in a custom header, so a cross-origin
  // caller cannot send it, and cannot read it either, because this response
  // carries no CORS headers. It was reachable by name as
  // window.__UISIGHT_TOKEN, which is a needless global for a secret -- the
  // closure keeps it out of every other script's reach. (The panel's own
  // functions stay global on purpose: the markup uses inline handlers.)
  const act = (() => {
    const token = '__TOKEN__';
    return (g) => fetch('/action', { method:'POST', headers:{'content-type':'application/json','x-uisight-token':token}, body: JSON.stringify(g) }).then(r=>r.json());
  })();
  const toast = (m) => { document.getElementById('statusLine').textContent = m; setTimeout(()=>{document.getElementById('statusLine').textContent='';}, 4000); };

  function paneOlustur(o) {
    const d = document.createElement('div');
    d.className = 'tel';
    d.dataset.session = o.id;
    d.innerHTML = '<header><b>' + o.id + '</b>' +
      '<select class="cihazSec"></select>' +
      '<button class="pin" title="Pin note + frame for your AI">📌</button>' +
      '</header><div class="pickHint">Drag the problem area &middot; one tap = whole screen &middot; Esc cancels</div><img tabindex="0" alt="' + o.id + '"><div class="pickBox"></div>';
    const img = d.querySelector('img');
    const sel = d.querySelector('select');

    const box = d.querySelector('.pickBox');
    // Screen pixel -> page CSS pixel. Clicking already did this conversion; the
    // selection must use the SAME scale or the crop lands somewhere else.
    const toPage = (e) => {
      const r = img.getBoundingClientRect();
      const v = vp[o.id] || { width: r.width, height: r.height };
      return { x: (e.clientX - r.left) * (v.width / r.width), y: (e.clientY - r.top) * (v.height / r.height) };
    };

    let start = null;
    img.addEventListener('pointerdown', (e) => {
      activeSession = o.id; highlight();
      if (!d.classList.contains('picking')) return;
      e.preventDefault();
      start = { screen: { x: e.clientX, y: e.clientY }, page: toPage(e) };
      const dr = d.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = (e.clientX - dr.left) + 'px';
      box.style.top = (e.clientY - dr.top) + 'px';
      box.style.width = '0px'; box.style.height = '0px';
      img.setPointerCapture(e.pointerId);
    });
    img.addEventListener('pointermove', (e) => {
      if (!start) return;
      const dr = d.getBoundingClientRect();
      box.style.left = (Math.min(start.screen.x, e.clientX) - dr.left) + 'px';
      box.style.top = (Math.min(start.screen.y, e.clientY) - dr.top) + 'px';
      box.style.width = Math.abs(e.clientX - start.screen.x) + 'px';
      box.style.height = Math.abs(e.clientY - start.screen.y) + 'px';
    });
    img.addEventListener('pointerup', async (e) => {
      if (!start) return;
      const s = start; start = null;
      box.style.display = 'none';
      d.classList.remove('picking');
      const end = toPage(e);
      const area = {
        x: Math.round(Math.min(s.page.x, end.x)), y: Math.round(Math.min(s.page.y, end.y)),
        width: Math.round(Math.abs(end.x - s.page.x)), height: Math.round(Math.abs(end.y - s.page.y)),
      };
      const body = { type:'mark', session:o.id, note: document.getElementById('note').value };
      if (area.width > 12 && area.height > 12) body.area = area;   // one tap = whole screen
      const r = await act(body);
      if (r.ok) {
        document.getElementById('note').value = '';
        toast(body.area ? ('area marked (' + area.width + '×' + area.height + ')') : 'whole screen marked');
      }
    });
    img.addEventListener('click', (e) => {
      activeSession = o.id; highlight();
      if (d.classList.contains('picking')) return;
      const p = toPage(e);
      act({ type:'click', session:o.id, x: Math.round(p.x), y: Math.round(p.y) });
      img.focus();
    });
    img.addEventListener('wheel', (e) => { e.preventDefault(); act({ type:'scroll', session:o.id, dy: e.deltaY }); }, { passive:false });
    img.addEventListener('keydown', (e) => {
      const specialKeys = ['Enter','Backspace','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Escape','Delete'];
      if (specialKeys.includes(e.key)) { e.preventDefault(); act({ type:'press', session:o.id, key: e.key }); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); act({ type:'press', session:o.id, text: e.key }); }
    });
    sel.addEventListener('change', () => act({ type:'device', session:o.id, device: sel.value }));
    d.querySelector('.pin').addEventListener('click', () => {
      activeSession = o.id; highlight();
      d.classList.toggle('picking');
      toast(d.classList.contains('picking')
        ? 'drag the problem area (one tap = whole screen, Esc cancels)'
        : 'selection cancelled');
    });
    return d;
  }

  function highlight() {
    document.querySelectorAll('.tel').forEach((t) => t.classList.toggle('aktif', t.dataset.session === activeSession));
  }

  function panelleriGuncelle(d) {
    const kap = document.getElementById('ekranlar');
    for (const o of d.sessions) {
      vp[o.id] = o.viewport;
      let pane = kap.querySelector('[data-session="' + o.id + '"]');
      if (!pane) { pane = paneOlustur(o); kap.appendChild(pane); }
      // Life size, and never past it. The frame is captured below 1:1 to keep
      // its token cost down, so filling the card would blow a 320px capture up
      // to whatever the side bar is wide -- measured at 2.5x, which makes a
      // 44px touch target look like 110px. Judging a phone layout from that is
      // worse than not seeing it.
      if (o.viewport && o.viewport.width) pane.style.setProperty('--vp', o.viewport.width + 'px');
      const sel = pane.querySelector('select');
      if (!sel.options.length && deviceList.length) {
        for (const c of deviceList) { const op = document.createElement('option'); op.value = c.k; op.textContent = c.label; sel.appendChild(op); }
      }
      sel.value = o.device;
      pane.querySelector('header b').textContent = o.id + ' · ' + o.label.split('—')[0].trim();
    }
    highlight();
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.tel.picking');
    if (open) { open.classList.remove('picking'); toast('selection cancelled'); }
  });

  // Kenar cubugu dar; eklenti paneli ?narrow=1 ile acar. ?dar=1 eski eklenti
  // surumlerinden geliyor — kabul ediliyor, cunku sessizce genis acmak tam da
  // kullanicinin sikayet ettigi sey.
  {
    const q = new URLSearchParams(location.search);
    if (q.has('narrow') || q.has('dar')) document.body.classList.add('narrow');
  }

  const es = new EventSource('/stream');
  es.addEventListener('frame', (e) => {
    const d = JSON.parse(e.data);
    const img = document.querySelector('[data-session="' + d.session + '"] img');
    if (img) img.src = 'data:image/jpeg;base64,' + d.img;
  });
  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    deviceList = d.devices || deviceList;
    // An error page's address never lands in the box: users could otherwise walk back
    // into the failing address with Go/Back without noticing (hit during the Aug 17 test).
    if (d.url && !d.url.startsWith('chrome-error')) document.getElementById('url').value = d.url;
    document.getElementById('theme').value = d.theme;
    panelleriGuncelle(d);
    if (d.error) record('k', 'PAGE: ' + d.error);
  });
  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    record(d.type === 'mark' ? 'i' : (d.type === 'console' ? 'u' : 'k'), '[' + d.session + '] ' + d.type + ': ' + d.message);
  });

  function record(className, text) {
    const k = document.getElementById('record');
    const d = document.createElement('div'); d.className = className; d.textContent = text;
    k.prepend(d); while (k.children.length > 80) k.lastChild.remove();
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  async function denetle() {
    toast('inspecting...');
    const r = await act({ type:'inspect' });
    if (!r.ok) { toast('inspection failed'); return; }
    const parts = [];
    for (const s of r.results) {
      const d = s.inspection || {};
      const rz = (color, m) => '<span class="badges" style="background:' + color + '">' + m + '</span>';
      const p = [];
      if (d.horizontalOverflow) p.push(rz('#5c2b2b','overflow'));
      if (d.invisibleText?.length) p.push(rz('#5c2b2b','invisible text ' + d.invisibleText.length));
      if (d.buttonIssues?.length) p.push(rz('#5a4a1f','buttons ' + d.buttonIssues.length));
      if (d.lowContrast?.length) p.push(rz('#5a4a1f','contrast ' + d.lowContrast.length));
      if (d.smallTargets?.length) p.push(rz('#5a4a1f','under 44px ' + d.smallTargets.length));
      if (d.tinyText?.length) p.push(rz('#33383e','under 12px ' + d.tinyText.length));
      if (!p.length) p.push(rz('#264d2c','clean'));
      const li = [];
      // Finding text comes from the INSPECTED page's DOM, so escaping is mandatory:
      // otherwise that page could run script on the panel's origin (stored XSS).
      for (const x of (d.invisibleText||[])) li.push('<li class="k">INVISIBLE ' + esc(x.ratio) + ':1 — "' + esc(x.text) + '"</li>');
      for (const x of (d.buttonIssues||[]).slice(0,5)) li.push('<li class="u">BUTTON "' + esc(x.text) + '" → ' + esc(x.issues.join(' · ')) + '</li>');
      for (const x of (d.lowContrast||[]).slice(0,5)) li.push('<li class="u">contrast ' + esc(x.ratio) + ':1 — "' + esc(x.text) + '"</li>');
      parts.push('<h4>' + esc(s.label || s.session) + '</h4>' + p.join('') + (li.length ? '<ul>' + li.join('') + '</ul>' : ''));
    }
    document.getElementById('finding').innerHTML = parts.join('');
    toast('done — live/inspect.json updated');
  }
</script></body></html>`;

// --- Baslat ---
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`  ! ${PORT} already in use — a panel may already be running. Try: --port 5056`);
    process.exit(2);
  }
  console.error('  ! server error:', e.message);
});

// Loopback ONLY: without a host argument Node binds every interface (0.0.0.0/::) and
// anyone on the same network could drive the browser session.
server.listen(PORT, '127.0.0.1', () => {
  try { writeFileSync(TOKEN_FILE, TOKEN, { mode: 0o600 }); } catch {}
  const address = `http://localhost:${PORT}`;
  console.log(`\n  Live panel : ${address}`);
  console.log(`  Target      : ${state.url}  (theme: ${state.theme})`);
  console.log(`  AI access   : MCP tools (see_screen/inspect/marks) or ${join(LIVE_DIR, 'last-mobile.jpg')}`);
  console.log(`  Antigravity/VS Code: Ctrl+Shift+P -> "Simple Browser: Show" -> ${address}\n`);
  if (!NO_OPEN) openInBrowser(address);
});

// The same first-run wall as the CLI. Only asked where there is a terminal to
// answer in: the extension and MCP hosts start this with no stdin attached, and
// a question nobody can see would look like a hang.
await offerInstall(['chromium'], { chromium });

// Browser sessions are separate: even if this throws, the server stays up and the panel shows the error.
try {
  // Parallel setup: waiting in sequence made the total the SUM of both sessions, which
  // could blow past the MCP client's 30s readiness budget.
  await Promise.all([
    SINGLE ? null : openSession('web', arg('--desktop', 'desktop'), state.theme),
    openSession('mobile', arg('--device', 'pixel'), state.theme),
  ].filter(Boolean));
} catch (e) {
  // missingBrowser() answers with the fix on its second line, and keeping only
  // the first threw that away -- which is the whole message for someone who
  // just installed this and has no browser downloaded yet.
  state.error = String(e.message || e).slice(0, 400);
  console.error('  ! session setup failed:', state.error);
}

// The panel stays open all day: one stray exception must not take the server down.
process.on('unhandledRejection', (e) => console.error('  ! unhandled rejection:', String(e).split('\n')[0].slice(0, 160)));
process.on('uncaughtException', (e) => console.error('  ! uncaught exception:', String(e).split('\n')[0].slice(0, 160)));
server.on('clientError', (e, soket) => { try { soket.destroy(); } catch {} });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { try { await browser?.close(); } catch {} process.exit(0); });
}
