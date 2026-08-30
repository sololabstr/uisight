#!/usr/bin/env node
/**
 * uisight — LIVE PANEL (multi-session, synchronised).
 *
 * Web + mobile side by side at the same time: each session gets its own Playwright
 * context and streams live over CDP screencast. You click and type in the panel ->
 * ilgili oturuma gider. Adres cubugu TUM oturumlara gider (URL-senkron).
 * AI ayni oturumlari MCP uzerinden gorur/olcer/eller (mcp.mjs).
 *
 * Kullanim:
 *   node server.mjs http://localhost:3000                  # web(masaustu) + mobile(pixel)
 *   node server.mjs <url> --device iphone-se --web laptop   # profillleri sel
 *   node server.mjs <url> --single                         # mobile session only
 *   UISIGHT_FALLBACK=1 node server.mjs <url>               # fallback stream instead of screencast (testing)
 *
 * Human -> AI channel: the panel's "Mark" button queues a note + the current frame
 * under live/marks/;
 * AI bunlari MCP `marks` araciyla okur.
 */

import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PROFILES, deviceSettings, INSPECTION_SCRIPT } from './cli.mjs';


// Live artifacts live under the user's home — never inside the package (npx → node_modules).
const LIVE_DIR = join(homedir(), '.uisight', 'live');
const MARKS_DIR = join(LIVE_DIR, 'marks');
const READ_DIR = join(MARKS_DIR, 'read');
for (const d of [LIVE_DIR, MARKS_DIR, READ_DIR]) mkdirSync(d, { recursive: true });

// --- Argumanlar ---
const argv = process.argv.slice(2);
const arg = (ad, vars) => { const i = argv.indexOf(ad); return i >= 0 && argv[i + 1] ? argv[i + 1] : vars; };
const FLAGS_WITH_VALUE = new Set(['--device', '--desktop', '--theme', '--port']);
let targetUrl = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (FLAGS_WITH_VALUE.has(a)) { i++; continue; }
  if (a.startsWith('--')) continue;
  if (!targetUrl) targetUrl = a;
}
targetUrl = targetUrl || 'http://localhost:3000';
if (!/^https?:\/\//.test(targetUrl)) targetUrl = 'http://' + targetUrl;

const PORT = Number(process.env.UISIGHT_PORT || process.env.MOBILQA_PORT || arg('--port', 5055));
const NO_OPEN = argv.includes('--no-open');
const SINGLE = argv.includes('--single');
const FORCE_FALLBACK = (process.env.UISIGHT_FALLBACK || process.env.MOBILQA_YEDEK) === '1';

// --- Security: this tool is a local server that DRIVES a browser session. Two layers:
//   (1) bind to loopback only (cuts off LAN access) — see listen() below.
//   (2) Host allowlist (DNS-rebinding guard, ALL endpoints) + an action token (CSRF guard, mutating endpoints).
// The panel sends the token in a header when it fetches its own origin; a malicious
// tab (POSTing to localhost from the same machine) cannot know it, and the text/plain form trick
// custom header EKLEYEMEZ → reddedilir.
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

// --- Genel state ---
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

// --- Yardimcilar ---
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
    id: o.id, device: o.deviceKey, label: o.profile.label, viewport: o.viewport, mobile: o.profile.mobile !== false,
  })),
  devices: Object.entries(PROFILES).map(([k, v]) => ({ k, label: v.label, mobile: v.mobile !== false })),
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
  if (!browser) browser = await chromium.launch();

  const ctx = await browser.newContext({ ...settings, colorScheme: theme, locale: 'tr-TR' });
  const page = await ctx.newPage();
  const o = {
    id, deviceKey, profile, ctx, page, cdp: null, fallbackTimer: null,
    viewport: settings.viewport, lastFrame: null, lastWrite: 0,
  };
  // Register in the map only AFTER the first goto completes: otherwise the setup goto and an
  // gelen `git` eylemi ayni sayfada yarisirsa Chromium gec kalan navigasyonu
  // chrome-error olarak commit edebiliyor (17 Agu MCP live testinde yasandi).

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

  sessions.set(id, o); // page oturdu — artik eylemlere acik
  await startStream(o);
  broadcast('state', publicState());
  return o;
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

    case 'inspect': {
      const results = [];
      const targets = g.session ? [sessions.get(g.session)].filter(Boolean) : [...sessions.values()];
      for (const o of targets) {
        try {
          // Timeout: target sayfada engelleyici bir native dialog varsa evaluate suresiz asili kalirdi.
          o.page.setDefaultTimeout(20000);
          const d = await o.page.evaluate(INSPECTION_SCRIPT, { mobile: o.profile.mobile !== false });
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
      try {
        const buf = o.lastFrame
          ? Buffer.from(o.lastFrame, 'base64')
          : await o.page.screenshot({ type: 'jpeg', quality: 85, scale: 'css' });
        writeFileSync(join(MARKS_DIR, imageName), buf);
      } catch {}
      const record = {
        time: new Date(ts).toISOString(), session: o.id, device: o.deviceKey, label: o.profile.label,
        theme: state.theme, url: state.url, note: String(g.note || '').slice(0, 500), image: imageName,
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

const server = createServer(async (req, res) => {
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
    try {
      const buf = u.searchParams.get('full') === '1'
        ? await o.page.screenshot({ type: 'jpeg', quality: 85, scale: 'css', fullPage: true })
        : (o.lastFrame ? Buffer.from(o.lastFrame, 'base64') : await o.page.screenshot({ type: 'jpeg', quality: 85, scale: 'css' }));
      res.writeHead(200, { 'content-type': 'image/jpeg', 'x-session': o.id });
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
  .tel img { display:block; border-radius:10px; background:#000; cursor:crosshair; max-height:74vh; width:auto; max-width:46vw; }
  .yan { flex:1; min-width:230px; display:flex; flex-direction:column; gap:10px; }
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
  <button onclick="act({type:'goto',url:document.getElementById('url').value})">Git</button>
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
  window.__UISIGHT_TOKEN = '__TOKEN__';
  const vp = {}; // session -> viewport
  let deviceList = [];
  let aktifOturum = 'mobile';

  const act = (g) => fetch('/action', { method:'POST', headers:{'content-type':'application/json','x-uisight-token':window.__UISIGHT_TOKEN}, body: JSON.stringify(g) }).then(r=>r.json());
  const toast = (m) => { document.getElementById('statusLine').textContent = m; setTimeout(()=>{document.getElementById('statusLine').textContent='';}, 4000); };

  function paneOlustur(o) {
    const d = document.createElement('div');
    d.className = 'tel'; d.dataset.session = o.id;
    d.innerHTML = '<header><b>' + o.id + '</b>' +
      '<select class="cihazSec"></select>' +
      '<button class="pin" title="Pin note + frame for your AI">📌</button>' +
      '</header><img tabindex="0" alt="' + o.id + '">';
    const img = d.querySelector('img');
    const sel = d.querySelector('select');

    img.addEventListener('click', (e) => {
      aktifOturum = o.id; vurgula();
      const r = img.getBoundingClientRect();
      const v = vp[o.id] || { width: r.width, height: r.height };
      act({ type:'click', session:o.id, x: Math.round((e.clientX-r.left)*(v.width/r.width)), y: Math.round((e.clientY-r.top)*(v.height/r.height)) });
      img.focus();
    });
    img.addEventListener('wheel', (e) => { e.preventDefault(); act({ type:'scroll', session:o.id, dy: e.deltaY }); }, { passive:false });
    img.addEventListener('keydown', (e) => {
      const specialKeys = ['Enter','Backspace','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Escape','Delete'];
      if (specialKeys.includes(e.key)) { e.preventDefault(); act({ type:'press', session:o.id, key: e.key }); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); act({ type:'press', session:o.id, text: e.key }); }
    });
    sel.addEventListener('change', () => act({ type:'device', session:o.id, device: sel.value }));
    d.querySelector('.pin').addEventListener('click', async () => {
      const n = document.getElementById('note').value;
      const r = await act({ type:'mark', session:o.id, note: n });
      if (r.ok) { document.getElementById('note').value=''; toast('mark queued — your AI can read it'); }
    });
    return d;
  }

  function vurgula() {
    document.querySelectorAll('.tel').forEach((t) => t.classList.toggle('aktif', t.dataset.session === aktifOturum));
  }

  function panelleriGuncelle(d) {
    const kap = document.getElementById('ekranlar');
    for (const o of d.sessions) {
      vp[o.id] = o.viewport;
      let pane = kap.querySelector('[data-session="' + o.id + '"]');
      if (!pane) { pane = paneOlustur(o); kap.appendChild(pane); }
      const sel = pane.querySelector('select');
      if (!sel.options.length && deviceList.length) {
        for (const c of deviceList) { const op = document.createElement('option'); op.value = c.k; op.textContent = c.label; sel.appendChild(op); }
      }
      sel.value = o.device;
      pane.querySelector('header b').textContent = o.id + ' · ' + o.label.split('—')[0].trim();
    }
    vurgula();
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
      // Bulgu metinleri DENETLENEN sayfanin DOM'undan gelir → escape ZORUNLU,
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

// Browser sessions are separate: even if this throws, the server stays up and the panel shows the error.
try {
  // Parallel setup: waiting in sequence made the total the SUM of both sessions, and
  // MCP'nin 30sn hazir-olma butcesini asabiliyordu.
  await Promise.all([
    SINGLE ? null : openSession('web', arg('--desktop', 'desktop'), state.theme),
    openSession('mobile', arg('--device', 'pixel'), state.theme),
  ].filter(Boolean));
} catch (e) {
  state.error = String(e).split('\n')[0].slice(0, 200);
  console.error('  ! session setup failed:', state.error);
}

// The panel stays open all day: one stray exception must not take the server down.
process.on('unhandledRejection', (e) => console.error('  ! unhandled rejection:', String(e).split('\n')[0].slice(0, 160)));
process.on('uncaughtException', (e) => console.error('  ! uncaught exception:', String(e).split('\n')[0].slice(0, 160)));
server.on('clientError', (e, soket) => { try { soket.destroy(); } catch {} });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { try { await browser?.close(); } catch {} process.exit(0); });
}
