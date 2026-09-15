#!/usr/bin/env node
/**
 * uisight — MCP server (the AI's doorway).
 *
 * Lets Claude Code / Cursor / Antigravity SEE the live sessions (see_screen),
 * MEASURE them (inspect: contrast, touch targets, overflow — returned as text),
 * DRIVE them (goto/tap/type_text/scroll) and READ the user's pinned marks
 * from the panel (marks — the human→AI channel).
 *
 * Starts the panel server (server.mjs) automatically if it is not running.
 *
 * Register (Claude Code):
 *   claude mcp add --scope user uisight -- npx -y -p uisight@latest uisight-mcp
 *
 * Env: UISIGHT_PORT (default 5055) · UISIGHT_URL (initial target, default http://localhost:3000)
 *      UISIGHT_LANG=tr → tool names/descriptions in Turkish (ekrani_gor, denetle, ...)
 *
 * NOTE: stdio transport — stdout belongs to JSON-RPC; all logging goes to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPort } from './login.mjs';
import { checkForUpdate, agentUpdateNotice, currentVersion, latestVersion } from './update-check.mjs';
import { fingerprint, fingerprints } from './findings.mjs';

// A person who types `uisight-mcp --help` otherwise gets a stdio server sitting
// silently on their terminal waiting for JSON-RPC. Printing here is safe: this
// only runs on an explicit flag, and it exits before the transport opens.
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`uisight-mcp - the MCP server your agent connects to.

Not usually run by hand. Register it instead:

  claude mcp add --scope user uisight -- npx -y -p uisight@latest uisight-mcp

or, for other hosts:

  { "command": "npx", "args": ["-y", "-p", "uisight", "uisight-mcp"] }

  UISIGHT_PORT   panel port (default: derived from the working directory)
  UISIGHT_URL    page the sessions open on first
  UISIGHT_TOOLS  comma-separated subset of tools, to spend fewer tokens
  UISIGHT_LANG   tr for Turkish tool names`);
  process.exit(0);
}

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
/**
 * Proje basina ayri port — yapilandirma olmadan.
 *
 * Herkes 5055'i paylasinca dort projede paralel calisan dort ajan ayni panele
 * baglaniyordu: biri digerinin sayfasini olcuyor, `goto` diyen digerlerinin
 * panelini kendi adresine cekiyordu. Hata vermiyor, sadece yanlis cevap
 * veriyordu.
 *
 * Calisma dizininden turetilen port bunu kendiliginden cozer: her proje kendi
 * portunu alir, ayni proje her acilista AYNI portu alir. UISIGHT_PORT verilmisse
 * o kazanir.
 */
// Ayni hesap eklentide de var (extension/extension.js). Iki taraf ayni sayiyi
// bulmak ZORUNDA: bulamazlarsa kenar cubugu, ajanin olctugunden BASKA bir
// uygulamayi gosterir. Bu yuzden sabitler ikisinde de duz yazili — test iki
// dosyayi metin olarak karsilastirabilsin diye.
const BLOCKED_PORTS = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
function portForProject() {
  let h = 2166136261;                       // FNV-1a
  for (const c of process.cwd().toLowerCase()) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < 120; i++) {
    const p = 5055 + ((Math.abs(h) + i) % 120);
    if (!BLOCKED_PORTS.has(p)) return p;
  }
  return 5055;
}
const PORT = Number(process.env.UISIGHT_PORT || process.env.MOBILQA_PORT || portForProject());
checkPort(PORT);
const BASE = `http://127.0.0.1:${PORT}`;
const TR = (process.env.UISIGHT_LANG || '').toLowerCase() === 'tr';
const log = (...a) => console.error('[uisight-mcp]', ...a);

// Public session names → server-internal ids.
const SESSION_MAP = { desktop: 'web', mobile: 'mobile', web: 'web' };
const sid = (s) => SESSION_MAP[s] || 'mobile';

// --- HTTP helpers ---
async function req(path, opts = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(BASE + path, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}
const getStatus = async (ms = 2000) => (await req('/state', {}, ms)).json();

// The panel demands a token on mutating endpoints (CSRF guard). It lives in a per-port
// local file and is re-read on every call (it changes when the panel restarts).
const tokenOku = () => {
  try { return readFileSync(join(homedir(), '.uisight', 'live', `token-${PORT}`), 'utf8').trim(); } catch { return ''; }
};
async function action(body) {
  const r = await req('/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-uisight-token': tokenOku() },
    body: JSON.stringify(body),
  }, 30000);
  return r.json();
}

// --- Engine lifecycle: ready = server responds AND at least one session is up ---
let child = null;
/**
 * Hedefi bu projenin hedefiyle uyusuyor mu diye sorar.
 *
 * Ayni porta baska bir projenin paneli oturmussa, ona baglanmak sessizce YANLIS
 * uygulamayi olcmek demektir. Sessiz yanlis cevap, gurultulu hatadan kotudur.
 */
async function panelMatchesTarget() {
  const want = process.env.UISIGHT_URL || process.env.MOBILQA_URL;
  if (!want) return true;                     // hedef belirtilmemis: karisma
  try {
    const d = await getStatus();
    if (!d || !d.url) return true;
    return new URL(d.url).host === new URL(want).host;
  } catch { return true; }                    // okuyamiyorsak engelleme
}

/**
 * What the panel is doing instead of having sessions, when that is worth saying.
 *
 * A panel downloading its browser (an MCPB bundle's first run) is up but has no
 * sessions, and the download takes a minute or two -- longer than the wait in
 * ensureEngine. Without this, that wait timed out into "panel server did not
 * start" about a panel that was busy doing exactly what it should. And a panel
 * whose sessions failed with nothing retrying them (a browser nobody agreed to
 * download) has its own error, which carries the fix; waiting 30 seconds to
 * replace it with a vaguer one helped nobody.
 */
function notReadyBecause(d) {
  if (d?.installing) {
    return Object.assign(new Error(
      `uisight is downloading ${d.installing}; this happens once. `
      + 'It takes a minute or two -- call this tool again shortly.',
    ), { report: true });
  }
  if (!d?.sessions?.length && d?.error) return Object.assign(new Error(d.error), { report: true });
  return null;
}

async function ensureEngine() {
  try {
    const d = await getStatus(1500);
    const neden = notReadyBecause(d);
    if (neden) throw neden;
    if (d?.sessions?.length) {
      if (!(await panelMatchesTarget())) {
        throw Object.assign(new Error(
          `port ${PORT} is serving a different app (${d?.url}). Another project's panel is on this port. `
          + `Set UISIGHT_PORT to a free port for this project, or stop that panel.`,
        ), { report: true });
      }
      return;
    }
  } catch (e) {
    if (e.report) throw e;
  }
  // Restart the panel if it went away: a one-shot flag used to leave the tool permanently
  // dead after a crash. No shell:true — the argv array is passed through safely by Node
  // (a shell would turn UISIGHT_URL into an injection surface).
  if (!child || child.exitCode !== null || child.killed) {
    const url = process.env.UISIGHT_URL || process.env.MOBILQA_URL || 'http://localhost:3000';
    log(`panel not running on ${PORT} — starting (${url})`);
    // --port is not optional here. PORT is derived from the PROJECT's cwd by
    // portForProject(), but server.mjs knows nothing about that function: with
    // no --port and no UISIGHT_PORT in the environment it falls back to its own
    // default, 5055. So the panel bound one port while this process polled
    // another, and the wait below could only ever time out -- "panel server did
    // not start" about a panel that had started perfectly well, on 5055.
    //
    // It leaked as well as failed: nothing can reach that panel afterwards, so
    // it sits there holding a browser open until the machine is restarted.
    child = spawn(process.execPath, [join(ROOT, 'server.mjs'), url, '--no-open', '--port', String(PORT)], {
      cwd: ROOT, windowsHide: true, detached: true, stdio: 'ignore',
    });
    child.on('error', (e) => log(`spawn failed: ${e.message}`));
    child.unref();
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const d = await getStatus(1500);
      const neden = notReadyBecause(d);
      if (neden) throw neden;
      if (d?.sessions?.length) return;
    } catch (e) {
      if (e.report) throw e;   // not up yet is expected here; a stated reason is not
    }
  }
  throw new Error(`panel server did not start on port ${PORT} — try manually: node ${join(ROOT, 'server.mjs')} <url>`);
}

const text = (s) => ({ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) });
const image = (b64) => ({ type: 'image', data: b64, mimeType: 'image/jpeg' });

/** Compact text rendering of inspection results — the heart of token savings. */
/** Width and height straight out of the JPEG header — no decoder needed. */
function jpegSize(buf) {
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Aynı kök nedenden doğan bulgulari tek satirda topla.
 *
 * Olculdu: bir sayfadaki 12 kontrast bulgusunun ARKASINDA 7 renk cifti vardi ve
 * altisi tek bir cifti tekrarliyordu. Yani ekranda 12 sorun degil, degistirilecek
 * tek bir CSS degiskeni var. Gruplamak hem her turda yeniden gonderilen metni
 * kisaltiyor hem de dogru olani soyluyor: semptomlari degil kaynagi.
 */
function group(list, keyOf, render) {
  const m = new Map();
  for (const x of list || []) {
    const k = keyOf(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return [...m.values()].sort((a, b) => b.length - a.length).map(render);
}

/** "a", "b" +3 — iki ornek, gerisi sayi. Uc ornek okuyani ikna etmiyor, sadece uzatiyor. */
const examples = (g, pick, len = 28) => {
  const s = g.slice(0, 2).map((y) => `"${String(pick(y)).slice(0, len)}"`).join(', ');
  return g.length > 2 ? `${s} +${g.length - 2}` : s;
};



/**
 * Son olcum, oturum+adres basina. Yalniz bellekte: kalicilastirmak, sunucu
 * yeniden basladiginda yanlis bir "degismedi" uretme riski getirir.
 *
 * Sebebi maliyet: duzelt-olc dongusunde ikinci olcum, degismeyen her seyi
 * yeniden gonderiyor ve o metin sonraki HER turda tekrar gidiyor. Olculdu:
 * alti turluk bir dongude 8.673 token yerine 3.378 (%61 az).
 *
 * Ve aslinda daha iyi bilgi: ikinci olcumde ajanin sordugu soru "sayfada ne var"
 * degil, "duzeltmem tuttu mu".
 */
const lastSeen = new Map();
/** Son olculen yapinin imzasi — bayat sunucuyu ayirt etmek icin. */
const lastBuild = new Map();

function inspectionText(results) {
  const out = [];
  for (const s of results) {
    if (s.error) { out.push(`[${s.session}] INSPECTION ERROR: ${s.error}`); continue; }
    const d = s.inspection || {};
    out.push(`\n[${s.session} · ${s.label} · ${s.theme}] ${s.url}`);
    if (d.horizontalOverflow) {
      out.push(`  HORIZONTAL OVERFLOW: page ${d.horizontalOverflow.pageWidth}px / viewport ${d.horizontalOverflow.viewportWidth}px`);
      for (const x of (d.horizontalOverflow.overflowing || []).slice(0, 4)) out.push(`    <${x.label} class="${x.className}"> right edge ${x.right}px`);
    }
    for (const x of d.invisibleText || []) out.push(`  INVISIBLE TEXT ${x.ratio}:1 — ${x.sel} "${x.text}" (text ${x.color} / bg ${x.bg})`);
    // Renk cifti basina tek satir: 12 bulgu 7 cifte, cogu zaman tek degiskene iner.
    out.push(...group(d.lowContrast, (x) => `${x.color}|${x.bg}`, (g) => {
      const x = g[0];
      const n = g.length > 1 ? ` x${g.length}` : '';
      return `  low contrast ${x.ratio}:1 (needs ${x.threshold})${n} — ${x.color} on ${x.bg} — ${examples(g, (y) => y.text)}`;
    }));
    out.push(...group(d.buttonIssues, (x) => x.issues.join('|'), (g) => {
      const n = g.length > 1 ? ` x${g.length}` : '';
      return `  BUTTON${n} ${g[0].issues.join(' · ')} — ${examples(g, (y) => y.text, 20)}`;
    }));
    for (const x of d.coveredControls || []) out.push(`  COVERED ${x.sel} "${x.text}" ${x.size} — ${x.percent}% under ${x.coveredBy} "${x.coveredByText}"`);
    for (const x of d.coveredByFixed || []) out.push(`  UNDER FIXED BAR ${x.sel} "${x.text}" — ${x.percent}% behind ${x.bar}`);
    for (const x of d.clippedContainer || []) out.push(`  CLIPPED, NO SCROLL ${x.hiddenPx}px in ${x.sel} — "${x.text}"`);
    for (const x of d.textUnderControl || []) out.push(`  TEXT BEHIND A CONTROL — "${x.text}" behind "${x.controlText}"`);
    for (const x of d.loadingButEmpty || []) out.push(`  EMPTY WHILE STILL LOADING — "${x.text}"`);
    for (const x of d.clippedText || []) out.push(`  CLIPPED ${x.sel} "${x.text}" — ${x.hiddenPx}px hidden (${x.axis})`);
    // Ayni olcu tekrar tekrar cikar (bir satirdaki dort ikon ayni kutuyu paylasir);
    // olcu basina tek satir hem kisa hem daha dogru okunuyor.
    out.push(...group(d.smallTargets, (x) => x.size, (g) => {
      const n = g.length > 1 ? ` x${g.length}` : '';
      return `  touch target below 44px${n} ${g[0].size} — ${examples(g, (y) => y.text, 20)}`;
    }));
    if (d.tinyText?.length) out.push(`  text below 12px (${d.tinyText.length}): ` + d.tinyText.map((m) => `${m.fontSize} "${m.text}"`).join(' · '));
    if (d.imagesWithoutAlt) out.push(`  images without alt: ${d.imagesWithoutAlt}`);
    // A "clean" claim must cover EVERY finding type. When a new check is added and
    // this list is not, the tool prints "clean" directly under its own findings.
    const clean = !d.horizontalOverflow && !d.invisibleText?.length && !d.lowContrast?.length
      && !d.buttonIssues?.length && !d.smallTargets?.length && !d.tinyText?.length
      && !d.coveredControls?.length && !d.clippedText?.length && !d.coveredByFixed?.length;
    if (clean) out.push('  automated checks clean (use see_screen for design issues the numbers cannot catch)');
  }
  return out.join('\n');
}

// --- Server + bilingual tool registration ---
// Read the version from package.json — a hard-coded value went stale on every release.
const SURUM = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, '..', 'package.json'), 'utf8')).version; } catch { return '0.0.0'; }
})();
const server = new McpServer({ name: 'uisight', version: SURUM });

// Bu aciklama DOKUZ araca da kopyalanir; kisa olmasi dokuz kat kazandirir.
const SESSION = z.enum(['desktop', 'mobile']).optional().describe('Default: mobile');

/** Registers a tool under its EN name, or TR name when UISIGHT_LANG=tr. */
/**
 * Which tools this server exposes.
 *
 * Tool schemas are a FIXED cost: the whole set is sent with every request in the
 * conversation, not once. Nine tools cost about 1,050 tokens per request, and a
 * session that only measures pages never calls six of them.
 *
 *   UISIGHT_TOOLS=core   goto + inspect + see_screen + status  (~410 tokens)
 *   UISIGHT_TOOLS=goto,inspect        an explicit list
 *   unset                everything (default)
 *
 * Names are the English ones even when UISIGHT_LANG=tr, so a config file does
 * not change meaning with the language.
 */
const CORE = ['goto', 'inspect', 'see_screen', 'status'];
const WANTED = (() => {
  const raw = (process.env.UISIGHT_TOOLS || '').trim().toLowerCase();
  if (!raw || raw === 'all') return null;                 // null = hepsi
  if (raw === 'core') return new Set(CORE);
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
})();

function tool(enName, trName, enDesc, trDesc, schema, handler) {
  if (WANTED && !WANTED.has(enName)) return;
  server.registerTool(TR ? trName : enName, { description: TR ? trDesc : enDesc, inputSchema: schema }, handler);
}

/** Sessions already told their iPhone profile is a chromium stand-in (id:device). */
const notedStandIns = new Set();

tool('see_screen', 'ekrani_gor',
  'Screenshot of the live session (~260 tokens at the default scale). Prefer inspect for measurable problems.',
  'Canli oturumun ekran goruntusu (varsayilan olcekte ~260 token). Olculebilir sorunlar icin inspect.',
  { session: SESSION,
    full: z.boolean().optional().describe('Full page: costlier, capped and reported'),
    scale: z.number().optional().describe('0.25-1, default 0.75. Cost falls with the SQUARE: 0.5 is a quarter the price and still readable. Use 1 only when small print matters.') },
  async ({ session, full, scale }) => {
    await ensureEngine();
    const q = [`session=${sid(session)}`];
    if (full) q.push('full=1');
    if (scale) q.push(`scale=${scale}`);
    const r = await req(`/frame?${q.join('&')}`, {}, 30000);
    if (!r.ok) return { content: [text(`could not capture frame: HTTP ${r.status}`)], isError: true };
    const bytes = Buffer.from(await r.arrayBuffer());
    const b64 = bytes.toString('base64');
    const d = await getStatus().catch(() => null);
    const o = d?.sessions?.find((x) => x.id === sid(session));

    // An image stays in the conversation and is re-sent on every later turn, so
    // its price is paid many times over. Saying what it cost is the same idea as
    // the rest of this tool: measure it instead of guessing.
    const dim = jpegSize(bytes);
    const cost = dim ? ` · ~${Math.round((dim.w * dim.h) / 750)} tokens (${dim.w}x${dim.h})` : '';
    const cut = r.headers.get('x-clipped');
    const note = cut ? ` · showing the top ${cut}px — scroll and capture again for the rest` : '';
    // Name the engine. Without it a model can look at an `iphone-15` session,
    // see the label say "iOS Safari engine", and report "clean on iPhone" about
    // a screen webkit never rendered -- either because the profile ran on
    // chromium, or because webkit would not launch and we fell back.
    const engine = r.headers.get('x-engine') || o?.engine || 'chromium';
    // Two ways to be on chromium instead, and they are not the same event.
    // Never downloaded is the ordinary case -- the panel only offers the engines
    // it opens at startup, and a runtime set_device has nobody to ask -- so it is
    // said ONCE per session, with the fix. Tool text is re-sent on every later
    // turn; a warning on every frame would be paid for many times over. The
    // label below keeps saying it either way. Downloaded but refusing to launch
    // is a real failure and stays loud on every frame.
    let fellBack = '';
    if (o?.engineFellBack && o.engineReason === 'not-installed') {
      const key = `${o.id}:${o.device}`;
      if (!notedStandIns.has(key)) {
        notedStandIns.add(key);
        fellBack = ` · note: ${o.engineRequested} is not installed, so this runs on ${engine} and iOS-specific bugs will be missed — install once: npx playwright install ${o.engineRequested}`;
      }
    } else if (o?.engineFellBack) {
      fellBack = ` · WARNING: ${o.engineRequested} was asked for and would not launch, ${engine} is running — iOS-specific bugs WILL be missed`;
    }
    // Never let the label claim the iOS Safari engine while chromium renders.
    const label = o?.engineFellBack ? `${o.label.split('—')[0].trim()} — ${engine} stand-in` : o?.label;
    return { content: [image(b64), text(`${label || session || 'mobile'} · ${engine} · ${d?.theme} · ${d?.url}${cost}${note}${fellBack}`)] };
  });

tool('inspect', 'denetle',
  'Runs color/contrast/theme/button/overflow checks on the open page; returns MEASURED findings as text (cheaper and more precise than images). Without session, inspects ALL sessions.',
  'Acik sayfada color/contrast/theme/buton/tasma denetimi kosar; OLCULMUS bulgulari text olarak dondurur. session verilmezse TUM sessions denetlenir.',
  { session: SESSION,
    full: z.boolean().optional().describe('List everything. Without it, a second inspection of the same page reports only what CHANGED — which is what you want after a fix, and much cheaper.') },
  async ({ session, full }) => {
    await ensureEngine();
    const r = await action({ type: 'inspect', ...(session ? { session: sid(session) } : {}) });
    if (!r.ok) return { content: [text(`inspection failed: ${r.message}`)], isError: true };

    // Ayni adres ikinci kez olculuyorsa, degismeyeni tekrar gondermek hem pahali
    // hem konu disi. `full` ile tam liste her zaman istenebilir.
    const parcalar = [];
    for (const s of r.results) {
      const anahtar = `${s.session}|${s.url}`;
      const simdi = fingerprints(s.inspection);
      const once = lastSeen.get(anahtar);
      lastSeen.set(anahtar, simdi);

      // Yapinin kimligi HER olcumde alinir; yalniz karsilastirma aninda almak
      // ilk tekrari karsilastirilacak seyden yoksun birakir.
      const kimlik = await action({ type: 'build-id', session: s.session }).catch(() => null);
      const imza = kimlik?.identity ? JSON.stringify(kimlik.identity) : null;
      const oncekiImza = lastBuild.get(anahtar);
      if (imza) lastBuild.set(anahtar, imza);
      const ayniYapi = !!(imza && oncekiImza && imza === oncekiImza);

      if (full || !once) { parcalar.push(inspectionText([s])); continue; }

      const kapanan = [...once].filter((k) => !simdi.has(k));
      const yeni = [...simdi].filter((k) => !once.has(k));
      const ayni = simdi.size - yeni.length;

      if (!kapanan.length && !yeni.length) {
        // "Hicbir sey degismedi" iki sekilde dogru olabilir: gercekten degismedi,
        // ya da AYNI YAPIYI olcuyoruz. Ikincisi bir kullanicinin yarim saatini
        // yedi — bayat bir dev sunucusu diskteki degisiklige ragmen eski CSS'i
        // servis etti ve dosya adi bile ayni kaldi.
        parcalar.push(`\n[${s.session} · ${s.label} · ${s.theme}] ${s.url}\n`
          + `  no change since the last inspection (${ayni} finding${ayni === 1 ? '' : 's'} still open). `
          + `Pass full:true for the list.`
          + (ayniYapi
            ? `\n  NOTE: the page is byte-identical to last time (same build, same asset names). `
              + `If you changed something, the server is serving a stale build — restart it before `
              + `concluding the fix did not work.`
            : ''));
        continue;
      }

      const satirlar = [`\n[${s.session} · ${s.label} · ${s.theme}] ${s.url}  — since the last inspection:`];
      if (kapanan.length) satirlar.push(`  CLOSED ${kapanan.length}: ${kapanan.map((k) => k.split('|')[0]).join(', ')}`);
      if (yeni.length) {
        satirlar.push(`  NEW ${yeni.length}:`);
        // Yeni olanlari TAM goster: onlar zaten kullanicinin bilmedigi kisim.
        const yeniKume = new Set(yeni);
        const suz = (tur, liste) => (liste || []).filter((x) => yeniKume.has(fingerprint(tur, x)));
        const tek = {};
        for (const [tur, liste] of Object.entries(s.inspection || {})) {
          if (!Array.isArray(liste)) continue;
          const k = suz(tur, liste);
          if (k.length) tek[tur] = k;
        }
        satirlar.push(inspectionText([{ ...s, inspection: tek }]).split('\n').slice(2).join('\n'));
      }
      if (ayni) satirlar.push(`  ${ayni} unchanged (full:true to list)`);
      parcalar.push(satirlar.join('\n'));
    }
    return { content: [text(parcalar.join('\n'))] };
  });

tool('goto', 'git',
  'Navigates ALL sessions to the given URL (URL-synced). localhost included.',
  'TUM oturumlari verilen adrese goturur (URL-senkron). localhost dahil.',
  { url: z.string().describe('URL to open') },
  async ({ url }) => {
    await ensureEngine();
    const r = await action({ type: 'goto', url });
    const d = await getStatus().catch(() => null);
    return { content: [text(r.ok ? `navigated: ${d?.url || url}` : `error: ${r.message}`)], ...(r.ok ? {} : { isError: true }) };
  });

tool('tap', 'tikla',
  'Tap by CSS selector (preferred) or x/y CSS pixels.',
  'CSS secici (tercih) ya da x/y CSS pikseliyle dokunur.',
  { session: SESSION, selector: z.string().optional().describe('CSS selector'),
    x: z.number().optional().describe('CSS px, only without selector'),
    y: z.number().optional().describe('CSS px, only without selector') },
  async ({ session, selector, x, y }) => {
    await ensureEngine();
    const r = await action({ type: 'click', session: session ? sid(session) : undefined, selector: selector, x, y });
    return { content: [text(r.ok ? `tapped (${r.session})` : `error: ${r.message}`)], ...(r.ok ? {} : { isError: true }) };
  });

tool('type_text', 'yaz',
  'Type into the focused field, or press one key.',
  'Odaklanmis alana yazar ya da tek tusa basar.',
  { session: SESSION, text: z.string().optional().describe('Text to type'),
    key: z.string().optional().describe('Enter | Tab | Escape | Backspace | ArrowDown') },
  async ({ session, text: t, key }) => {
    await ensureEngine();
    const r = await action({ type: 'press', session: session ? sid(session) : undefined, text: t, key });
    return { content: [text(r.ok ? 'typed' : `error: ${r.message}`)], ...(r.ok ? {} : { isError: true }) };
  });

tool('scroll', 'kaydir',
  'Scrolls the page vertically. dy>0 down, dy<0 up (pixels).',
  'Sayfayi dikey kaydirir. dy>0 asagi, dy<0 yukari (piksel).',
  { session: SESSION, dy: z.number().describe('Scroll amount in px') },
  async ({ session, dy }) => {
    await ensureEngine();
    const r = await action({ type: 'scroll', session: session ? sid(session) : undefined, dy });
    // `how` says which mechanism moved the page: mobile WebKit has no wheel, so
    // there the window is scrolled and a nested scroller under the pointer is NOT.
    const nasil = r.how === 'window' ? ' — window scrolled (no wheel on this engine; a scroller inside the page did not move)' : '';
    return { content: [text(r.ok ? `scrolled ${dy}px (${r.session})${nasil}` : `error: ${r.message}`)], ...(r.ok ? {} : { isError: true }) };
  });

tool('set_device', 'cihaz_degistir',
  "Changes a session's device profile and/or the color theme. Each profile runs on the engine it declares: iphone-15/iphone-se/ipad -> WebKit (the real iOS Safari engine), pixel/galaxy/desktop/laptop -> Chromium. Changing engine rebuilds the session. theme: light|dark (without session, theme applies to ALL sessions).",
  'Oturumun cihaz profilini ve/veya temayi degistirir.',
  { session: SESSION,
    device: z.string().optional().describe('iphone-15|iphone-se|pixel|galaxy|ipad|desktop|laptop'),
    theme: z.enum(['light', 'dark']).optional().describe('Without session: all') },
  async ({ session, device, theme }) => {
    await ensureEngine();
    const r = await action({ type: 'device', session: session ? sid(session) : undefined, device: device, theme: theme });
    const d = await getStatus().catch(() => null);
    return { content: [text(r.ok ? `done — sessions: ${d?.sessions?.map((o) => `${o.id}=${o.device}`).join(', ')} · theme=${d?.theme}` : `error: ${r.message}`)], ...(r.ok ? {} : { isError: true }) };
  });

tool('status', 'durum',
  'Returns the open URL, sessions (device+viewport) and recent console/network/mark records. FIRST tool to reach for when hunting a bug.',
  'Acik adresi, oturumlari ve son konsol/ag/isaret kayitlarini dondurur.',
  {},
  async () => {
    await ensureEngine();
    const d = await getStatus();
    const out = [`url: ${d.url}`, `theme: ${d.theme}${d.error ? `\nPAGE ERROR: ${d.error}` : ''}`];
    for (const o of d.sessions) {
      const fellBack = !o.engineFellBack ? ''
        : o.engineReason === 'not-installed'
          ? ` — ${o.engineRequested} not installed, chromium stand-in (npx playwright install ${o.engineRequested})`
          : ` — ${o.engineRequested} WAS ASKED FOR AND WOULD NOT LAUNCH`;
      out.push(`session ${o.id}: ${o.label} (${o.viewport.width}x${o.viewport.height}) [${o.engine || 'chromium'}${fellBack}]`);
    }
    const recs = (d.records || []).slice(-20);
    if (recs.length) {
      out.push('\nrecent records (console/network/marks):');
      for (const k of recs) out.push(`  [${k.session}] ${k.type}: ${k.message}`);
    } else out.push('no records (console/network clean)');

    // The cached daily answer; never a network wait on the hot path.
    const note = agentUpdateNotice(currentVersion(), await latestVersion().catch(() => null));
    if (note) out.push(note);

    return { content: [text(out.join('\n'))] };
  });

tool('marks', 'isaretler',
  'Notes the user pinned in the panel, with the frame at that moment.',
  'Kullanicinin panelde biraktigi notlar + o anki kare.',
  { clear: z.boolean().optional().describe('Drop returned marks from the queue (default true)') },
  async ({ clear }) => {
    await ensureEngine();
    const r = await req(`/marks${clear === false ? '' : '?clear=1'}`, {}, 10000);
    const { marks } = await r.json();
    if (!marks.length) return { content: [text('no pending marks')] };
    const content = [];
    const lines = [`${marks.length} mark(s):`];
    for (const i of marks) lines.push(`- [${i.time}] ${i.session}/${i.device} ${i.theme} ${i.url}\n  note: ${i.note || '(empty)'}`);
    content.push(text(lines.join('\n')));
    try {
      const last = marks[marks.length - 1];
      content.push(image(readFileSync(last.imagePath).toString('base64')));
    } catch {}
    return { content };
  });

// --- Start ---
checkForUpdate();            // stderr'e yazar; stdout JSON-RPC'nin
const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready — panel: ${BASE}${TR ? ' (lang=tr)' : ''}`);
