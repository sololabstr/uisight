#!/usr/bin/env node
/**
 * SoloLabs mobil QA — CANLI PANEL (cok oturumlu, senkron).
 *
 * Web + mobil AYNI ANDA yan yana: her oturum kendi Playwright baglami,
 * ekranlar CDP screencast ile canli akar. Panelde tiklarsin/yazarsin ->
 * ilgili oturuma gider. Adres cubugu TUM oturumlara gider (URL-senkron).
 * AI ayni oturumlari MCP uzerinden gorur/olcer/eller (mcp.mjs).
 *
 * Kullanim:
 *   node sunucu.mjs http://localhost:3000                  # web(masaustu) + mobil(pixel)
 *   node sunucu.mjs <url> --cihaz iphone-se --web laptop   # profillleri sec
 *   node sunucu.mjs <url> --tek                            # yalniz mobil oturum
 *   MOBILQA_YEDEK=1 node sunucu.mjs <url>                  # screencast yerine yedek akis (test)
 *
 * Insan -> AI kanali: paneldeki "Isaretle" not+kareyi canli/isaretler/ kuyruguna yazar;
 * AI bunlari MCP `isaretler` araciyla okur.
 */

import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PROFILLER, cihazAyari, DENETIM_KODU } from './cli.mjs';


// Live artifacts live under the user's home — never inside the package (npx → node_modules).
const CANLI_DIR = join(homedir(), '.uisight', 'live');
const ISARET_DIR = join(CANLI_DIR, 'marks');
const OKUNDU_DIR = join(ISARET_DIR, 'read');
for (const d of [CANLI_DIR, ISARET_DIR, OKUNDU_DIR]) mkdirSync(d, { recursive: true });

// --- Argumanlar ---
const argv = process.argv.slice(2);
const arg = (ad, vars) => { const i = argv.indexOf(ad); return i >= 0 && argv[i + 1] ? argv[i + 1] : vars; };
const DEGER_ALAN = new Set(['--device', '--desktop', '--theme', '--port']);
let hedefUrl = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (DEGER_ALAN.has(a)) { i++; continue; }
  if (a.startsWith('--')) continue;
  if (!hedefUrl) hedefUrl = a;
}
hedefUrl = hedefUrl || 'http://localhost:3000';
if (!/^https?:\/\//.test(hedefUrl)) hedefUrl = 'http://' + hedefUrl;

const PORT = Number(process.env.UISIGHT_PORT || process.env.MOBILQA_PORT || arg('--port', 5055));
const ACMA = argv.includes('--no-open');
const TEK = argv.includes('--single');
const ZORLA_YEDEK = (process.env.UISIGHT_FALLBACK || process.env.MOBILQA_YEDEK) === '1';

// --- Guvenlik: bu araç bir tarayici oturumunu SÜREN yerel bir sunucu. Iki katman:
//   (1) yalniz loopback'e bind (LAN erisimini keser) — bkz. listen() asagida.
//   (2) Host allowlist (DNS-rebinding kesici, TÜM uclar) + eylem token (CSRF kesici, mutasyon uclari).
// Panel kendi origin'inden fetch ederken token'i header'da yollar; kotu niyetli baska
// bir sekme (ayni makinede localhost'a POST) token'i bilemez ve text/plain-form hilesi
// custom header EKLEYEMEZ → reddedilir.
const TOKEN = randomUUID();
// Token'i port basina yerel dosyaya yaz: MCP sunucusu (ayri surec, ayni makine)
// bunu okuyup header'da gonderir. Capraz-site bir sayfa bu dosyayi OKUYAMAZ.
const TOKEN_DOSYA = join(CANLI_DIR, `token-${PORT}`);

/** Platforma gore tarayici acar. `start` yalniz Windows'ta var; macOS/Linux'ta
 *  sessizce basarisiz oluyordu (exec callback'siz → hicbir iz yok). */
export function tarayicidaAc(adres) {
  const p = platform();
  const komut = p === 'win32' ? `start "" "${adres}"` : p === 'darwin' ? `open "${adres}"` : `xdg-open "${adres}"`;
  exec(komut, p === 'win32' ? { shell: 'cmd.exe' } : {}, (e) => {
    if (e) console.error(`  ! could not open browser (${p}) — open manually: ${adres}`);
  });
}
function hostGuvenli(req) {
  const h = String(req.headers.host || '');
  const port = h.split(':')[1] || '';
  const ana = h.split(':')[0].toLowerCase();
  return (ana === 'localhost' || ana === '127.0.0.1' || ana === '[::1]' || ana === '::1')
    && (port === '' || port === String(PORT));
}

// --- Genel durum ---
const durum = {
  url: hedefUrl,
  tema: arg('--theme', 'light'),
  hata: null,
  kayitlar: [], // son 100 konsol/ag kaydi (ring)
};

/** id -> oturum. Sabit kimlikler: 'web' (masaustu sinifi), 'mobil' (telefon sinifi). */
const oturumlar = new Map();
let tarayici = null;
const istemciler = new Set(); // SSE

// --- Yardimcilar ---
function yayinla(olay, veri) {
  const paket = `event: ${olay}\ndata: ${JSON.stringify(veri)}\n\n`;
  for (const r of istemciler) { try { r.write(paket); } catch { istemciler.delete(r); } }
}

function kayitEkle(oturumId, tip, mesaj) {
  const k = { zaman: new Date().toISOString(), oturum: oturumId, tip, mesaj: String(mesaj).slice(0, 200) };
  durum.kayitlar.push(k);
  if (durum.kayitlar.length > 100) durum.kayitlar.shift();
  yayinla('log', k);
}

const kamuDurum = () => ({
  url: durum.url,
  tema: durum.tema,
  hata: durum.hata,
  oturumlar: [...oturumlar.values()].map((o) => ({
    id: o.id, cihaz: o.cihazKey, etiket: o.profil.etiket, viewport: o.viewport, mobil: o.profil.mobil !== false,
  })),
  cihazlar: Object.entries(PROFILLER).map(([k, v]) => ({ k, etiket: v.etiket, mobil: v.mobil !== false })),
  kayitlar: durum.kayitlar.slice(-30),
});

// --- Oturum yasam dongusu ---
async function oturumKapat(o) {
  if (!o) return;
  if (o.yedekZamanlayici) { clearInterval(o.yedekZamanlayici); o.yedekZamanlayici = null; }
  if (o.cdp) { try { o.cdp.removeAllListeners(); await o.cdp.detach(); } catch {} o.cdp = null; }
  if (o.ctx) { try { await o.ctx.close(); } catch {} o.ctx = null; }
}

async function oturumKur(id, cihazKey, tema) {
  await oturumKapat(oturumlar.get(id));
  oturumlar.delete(id); // yeniden kurulum bitene dek eylemler bu oturumu gormesin

  const profil = PROFILLER[cihazKey] || PROFILLER[id === 'web' ? 'desktop' : 'pixel'];
  const ayar = cihazAyari(profil.pw);
  if (!tarayici) tarayici = await chromium.launch();

  const ctx = await tarayici.newContext({ ...ayar, colorScheme: tema, locale: 'tr-TR' });
  const sayfa = await ctx.newPage();
  const o = {
    id, cihazKey, profil, ctx, sayfa, cdp: null, yedekZamanlayici: null,
    viewport: ayar.viewport, sonKare: null, sonYazma: 0,
  };
  // Map'e kayit ILK goto tamamlandiktan SONRA yapilir: kurulum goto'su ile disaridan
  // gelen `git` eylemi ayni sayfada yarisirsa Chromium gec kalan navigasyonu
  // chrome-error olarak commit edebiliyor (17 Agu MCP canli testinde yasandi).

  sayfa.on('pageerror', (e) => kayitEkle(id, 'js-hata', e));
  sayfa.on('console', (m) => { if (m.type() === 'error') kayitEkle(id, 'konsol', m.text()); });
  sayfa.on('response', (r) => { if (r.status() >= 400) kayitEkle(id, 'ag', `${r.status()} ${r.url().slice(0, 120)}`); });
  sayfa.on('framenavigated', (f) => {
    if (f === sayfa.mainFrame()) { durum.url = f.url(); yayinla('durum', kamuDurum()); }
  });

  try {
    await sayfa.goto(durum.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    durum.hata = null;
  } catch (e) {
    durum.hata = String(e).split('\n')[0].slice(0, 160);
    kayitEkle(id, 'sayfa', durum.hata);
  }

  oturumlar.set(id, o); // sayfa oturdu — artik eylemlere acik
  await akisBaslat(o);
  yayinla('durum', kamuDurum());
  return o;
}

/** Kare akisi: once CDP screencast (3 deneme), olmazsa saniyede-bir goruntuye duser.
 *  Screencast tek basina kritik degil — patlarsa panel yine calisir. */
async function akisBaslat(o) {
  if (o.yedekZamanlayici) { clearInterval(o.yedekZamanlayici); o.yedekZamanlayici = null; }

  // CDP setup can silently hang on a second context — cap every attempt at 5s
  // and fall through to the screenshot-interval fallback (seen 2026-08-19).
  const zamanli = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error(`timeout ${ms}ms`)), ms))]);

  if (!ZORLA_YEDEK) {
    for (let deneme = 1; deneme <= 3; deneme++) {
      try {
        o.cdp = await zamanli(o.ctx.newCDPSession(o.sayfa), 5000);
        o.cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
          try { await o.cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
          kareIsle(o, data);
        });
        await zamanli(o.cdp.send('Page.startScreencast', {
          format: 'jpeg', quality: 70,
          maxWidth: o.viewport.width, maxHeight: o.viewport.height, everyNthFrame: 1,
        }), 5000);
        console.log(`  stream[${o.id}]: CDP screencast (live)`);
        // First-frame guarantee: screencast only emits on repaint — a fully static
        // page would leave the pane blank until something moves.
        try { kareIsle(o, (await o.sayfa.screenshot({ type: 'jpeg', quality: 70, scale: 'css' })).toString('base64')); } catch {}
        return;
      } catch (e) {
        console.error(`  ! screencast[${o.id}] attempt ${deneme}/3 — ${String(e).split('\n')[0].slice(0, 90)}`);
        try { o.cdp?.removeAllListeners(); await o.cdp?.detach(); } catch {}
        o.cdp = null;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  console.log(`  stream[${o.id}]: FALLBACK mode — one frame per second${ZORLA_YEDEK ? ' (UISIGHT_FALLBACK=1)' : ''}`);
  o.yedekZamanlayici = setInterval(async () => {
    if (!o.sayfa) return;
    try { kareIsle(o, (await o.sayfa.screenshot({ type: 'jpeg', quality: 70, scale: 'css' })).toString('base64')); } catch {}
  }, 1000);
}

function kareIsle(o, b64) {
  o.sonKare = b64;
  yayinla('kare', { oturum: o.id, img: b64 });
  const t = Date.now();
  if (t - o.sonYazma > 1000) {
    o.sonYazma = t;
    try { writeFileSync(join(CANLI_DIR, `last-${o.id}.jpg`), Buffer.from(b64, 'base64')); } catch {}
  }
}

// --- Eylemler ---
const normUrl = (u) => (/^https?:\/\//.test(u) ? u : 'http://' + u);

/** tikla/yaz/kaydir icin hedef oturum; belirtilmemisse mobil, o da yoksa ilk oturum. */
const hedefOturum = (g) => oturumlar.get(g.oturum) || oturumlar.get('mobil') || [...oturumlar.values()][0];

async function eylemUygula(g) {
  if (!oturumlar.size) return { ok: false, mesaj: 'no session ready yet' };

  switch (g.tip) {
    case 'git': {
      durum.url = normUrl(g.url);
      for (const o of oturumlar.values()) {
        await o.sayfa.goto(durum.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
          .catch((e) => kayitEkle(o.id, 'sayfa', String(e).split('\n')[0]));
      }
      return { ok: true };
    }
    case 'geri': for (const o of oturumlar.values()) await o.sayfa.goBack().catch(() => {}); return { ok: true };
    case 'ileri': for (const o of oturumlar.values()) await o.sayfa.goForward().catch(() => {}); return { ok: true };
    case 'yenile': for (const o of oturumlar.values()) await o.sayfa.reload().catch(() => {}); return { ok: true };

    case 'tikla': {
      const o = hedefOturum(g);
      if (g.secici) { await o.sayfa.click(g.secici, { timeout: 5000 }); return { ok: true, oturum: o.id }; }
      if (o.profil.mobil !== false) await o.sayfa.touchscreen.tap(g.x, g.y);
      else await o.sayfa.mouse.click(g.x, g.y);
      return { ok: true, oturum: o.id };
    }
    case 'kaydir': {
      const o = hedefOturum(g);
      await o.sayfa.mouse.move(o.viewport.width / 2, o.viewport.height / 2);
      await o.sayfa.mouse.wheel(0, g.dy);
      return { ok: true, oturum: o.id };
    }
    case 'tus': {
      const o = hedefOturum(g);
      if (g.key) await o.sayfa.keyboard.press(g.key);
      else if (g.text) await o.sayfa.keyboard.type(g.text);
      return { ok: true, oturum: o.id };
    }

    case 'cihaz': {
      // {oturum, cihaz} -> o oturumun profili degisir; {tema} oturumsuz -> TUM oturumlar yeni temayla kurulur.
      // Oturum id'si dosya adina giriyor (last-<id>.jpg) → path-traversal'i burada kes.
      if (g.oturum && !/^[a-zA-Z0-9_-]{1,32}$/.test(String(g.oturum))) {
        return { ok: false, mesaj: 'invalid session id' };
      }
      // Tema TEK oturuma uygulanacaksa global alani degistirme: panel/status
      // "dark" derken dokunulmayan oturum hala light kalabiliyordu (yalan durum).
      if (g.tema && !g.oturum) durum.tema = g.tema;
      if (g.oturum && g.cihaz) {
        const mevcut = oturumlar.get(g.oturum);
        await oturumKur(g.oturum, g.cihaz, g.tema || durum.tema);
        if (!mevcut) kayitEkle(g.oturum, 'oturum', `yeni oturum: ${g.cihaz}`);
      } else {
        for (const o of [...oturumlar.values()]) await oturumKur(o.id, g.cihaz || o.cihazKey, durum.tema);
      }
      return { ok: true };
    }

    case 'denetle': {
      const sonuclar = [];
      const hedefler = g.oturum ? [oturumlar.get(g.oturum)].filter(Boolean) : [...oturumlar.values()];
      for (const o of hedefler) {
        try {
          // Timeout: hedef sayfada engelleyici bir native dialog varsa evaluate suresiz asili kalirdi.
          o.sayfa.setDefaultTimeout(20000);
          const d = await o.sayfa.evaluate(DENETIM_KODU, { mobil: o.profil.mobil !== false });
          sonuclar.push({ oturum: o.id, cihaz: o.cihazKey, etiket: o.profil.etiket, tema: durum.tema, url: durum.url, denetim: d });
        } catch (e) {
          sonuclar.push({ oturum: o.id, cihaz: o.cihazKey, hata: String(e).slice(0, 200) });
        }
      }
      writeFileSync(join(CANLI_DIR, 'inspect.json'), JSON.stringify(sonuclar, null, 2), 'utf8');
      return { ok: true, sonuclar };
    }

    case 'isaret': {
      // Insan -> AI: not + o anki kare kuyruga.
      const o = hedefOturum(g);
      const ts = Date.now();
      const gorselAd = `${ts}-${o.id}.jpg`;
      try {
        const buf = o.sonKare
          ? Buffer.from(o.sonKare, 'base64')
          : await o.sayfa.screenshot({ type: 'jpeg', quality: 85, scale: 'css' });
        writeFileSync(join(ISARET_DIR, gorselAd), buf);
      } catch {}
      const kayit = {
        zaman: new Date(ts).toISOString(), oturum: o.id, cihaz: o.cihazKey, etiket: o.profil.etiket,
        tema: durum.tema, url: durum.url, not: String(g.not || '').slice(0, 500), gorsel: gorselAd,
      };
      writeFileSync(join(ISARET_DIR, `${ts}.json`), JSON.stringify(kayit, null, 2), 'utf8');
      kayitEkle(o.id, 'isaret', kayit.not || '(mark without note)');
      return { ok: true, kayit };
    }

    case 'kaydet': {
      const yollar = {};
      const hedefler = g.oturum ? [oturumlar.get(g.oturum)].filter(Boolean) : [...oturumlar.values()];
      for (const o of hedefler) {
        const yol = join(CANLI_DIR, `last-${o.id}.jpg`);
        await o.sayfa.screenshot({ path: yol, type: 'jpeg', quality: 90, scale: 'css', fullPage: !!g.tam });
        yollar[o.id] = yol;
      }
      return { ok: true, yollar };
    }

    default: return { ok: false, mesaj: 'unknown action' };
  }
}

/** Bekleyen isaretleri dondurur; temizle=1 ise okundu/ altina tasir. */
function isaretleriOku(temizle) {
  const dosyalar = readdirSync(ISARET_DIR).filter((f) => f.endsWith('.json')).sort();
  const liste = [];
  for (const f of dosyalar) {
    try {
      const k = JSON.parse(readFileSync(join(ISARET_DIR, f), 'utf8'));
      k.gorselYol = join(ISARET_DIR, k.gorsel);
      liste.push(k);
      if (temizle) {
        renameSync(join(ISARET_DIR, f), join(OKUNDU_DIR, f));
        try { renameSync(join(ISARET_DIR, k.gorsel), join(OKUNDU_DIR, k.gorsel)); k.gorselYol = join(OKUNDU_DIR, k.gorsel); } catch {}
      }
    } catch {}
  }
  return liste;
}

// --- HTTP ---
// 1 MB tavan: sinirsiz birikim bellek tuketimine acik kapi birakiyordu.
const GOVDE_TAVAN = 1024 * 1024;
const govdeOku = (req) => new Promise((c) => {
  let s = '';
  req.on('data', (d) => {
    s += d;
    if (s.length > GOVDE_TAVAN) { s = ''; req.destroy(); c({}); }
  });
  req.on('end', () => { try { c(JSON.parse(s || '{}')); } catch { c({}); } });
  req.on('error', () => c({}));
});

const sunucu = createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // DNS-rebinding kesici: saldirgan alan adi loopback'e cozulse bile Host basligi tutmaz.
  if (!hostGuvenli(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden host');
  }

  // Mutasyon uclarinda token ZORUNLU (CSRF kesici). Panel bunu header'da yollar;
  // capraz-site istekler custom header ekleyemedigi icin buraya hic gelemez.
  const MUTASYON = new Set(['/eylem']);
  if (MUTASYON.has(u.pathname) && req.headers['x-uisight-token'] !== TOKEN) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, mesaj: 'invalid or missing token' }));
  }

  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PANEL_HTML_SABLON.replace('__TOKEN__', TOKEN));
  }

  if (u.pathname === '/akis') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    istemciler.add(res);
    res.on('error', () => istemciler.delete(res));
    req.on('error', () => istemciler.delete(res));
    req.on('close', () => istemciler.delete(res));
    res.write(`event: durum\ndata: ${JSON.stringify(kamuDurum())}\n\n`);
    for (const o of oturumlar.values()) {
      if (o.sonKare) res.write(`event: kare\ndata: ${JSON.stringify({ oturum: o.id, img: o.sonKare })}\n\n`);
    }
    return;
  }

  if (u.pathname === '/eylem' && req.method === 'POST') {
    const g = await govdeOku(req);
    let sonuc;
    try { sonuc = await eylemUygula(g); } catch (e) { sonuc = { ok: false, mesaj: String(e).slice(0, 200) }; }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(sonuc));
  }

  if (u.pathname === '/durum') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(kamuDurum()));
  }

  if (u.pathname === '/kare') {
    const o = oturumlar.get(u.searchParams.get('oturum')) || hedefOturum({});
    if (!o) { res.writeHead(404); return res.end('oturum yok'); }
    try {
      const buf = u.searchParams.get('tam') === '1'
        ? await o.sayfa.screenshot({ type: 'jpeg', quality: 85, scale: 'css', fullPage: true })
        : (o.sonKare ? Buffer.from(o.sonKare, 'base64') : await o.sayfa.screenshot({ type: 'jpeg', quality: 85, scale: 'css' }));
      res.writeHead(200, { 'content-type': 'image/jpeg', 'x-oturum': o.id });
      return res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ hata: String(e).slice(0, 200) }));
    }
  }

  if (u.pathname === '/isaretler') {
    const liste = isaretleriOku(u.searchParams.get('temizle') === '1');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ isaretler: liste }));
  }

  res.writeHead(404); res.end('yok');
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
  #not { min-width:170px; }
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
  #kayit { font-family:ui-monospace,Consolas,monospace; font-size:11px; max-height:170px; overflow:auto; }
  #kayit div { padding:2px 0; border-bottom:1px solid #33363b; }
  .k { color:#ffb4ab; } .u { color:#ffd77a; } .i { color:#8ab4f8; }
  #bulgu { font-size:12px; max-height:34vh; overflow:auto; }
  #bulgu ul { margin:4px 0 10px; padding-left:16px; }
  #bulgu h4 { margin:8px 0 2px; font-size:12px; color:#c3c6cc; }
  .rozet { display:inline-block; font-size:11px; padding:1px 7px; border-radius:9px; margin:2px 3px 2px 0; }
  .durumcu { font-size:11px; color:#9da0a8; }
</style></head><body>
<div class="ust">
  <button onclick="ey({tip:'geri'})">◀</button>
  <button onclick="ey({tip:'ileri'})">▶</button>
  <button onclick="ey({tip:'yenile'})">⟳</button>
  <input id="url" onkeydown="if(event.key==='Enter')ey({tip:'git',url:this.value})" placeholder="http://localhost:3000">
  <button onclick="ey({tip:'git',url:document.getElementById('url').value})">Git</button>
  <select id="tema" onchange="ey({tip:'cihaz',tema:this.value})">
    <option value="light">light</option><option value="dark">dark</option>
  </select>
  <button onclick="denetle()">Inspect</button>
  <input id="not" placeholder="mark note (goes to your AI)">
  <span class="durumcu" id="durumcu"></span>
</div>
<div class="gov">
  <div class="ekranlar" id="ekranlar"></div>
  <div class="yan">
    <div class="kutu"><h3>Inspection</h3><div id="bulgu" class="durumcu">"Inspect" runs color/theme/button checks on every screen; findings come back per device.</div></div>
    <div class="kutu"><h3>Live log (console · network · marks)</h3><div id="kayit"></div></div>
    <div class="kutu durumcu">Click a screen = tap on that device · wheel = scroll · click first to type.<br>📌 = drops your note + the current frame into the AI queue (MCP <code>marks</code>).</div>
  </div>
</div>
<script>
  const uisightToken = '__TOKEN__';
  const vp = {}; // oturum -> viewport
  let cihazListesi = [];
  let aktifOturum = 'mobil';

  const ey = (g) => fetch('/eylem', { method:'POST', headers:{'content-type':'application/json','x-uisight-token':uisightToken}, body: JSON.stringify(g) }).then(r=>r.json());
  const not = (m) => { document.getElementById('durumcu').textContent = m; setTimeout(()=>{document.getElementById('durumcu').textContent='';}, 4000); };

  function paneOlustur(o) {
    const d = document.createElement('div');
    d.className = 'tel'; d.dataset.oturum = o.id;
    d.innerHTML = '<header><b>' + o.id + '</b>' +
      '<select class="cihazSec"></select>' +
      '<button class="pin" title="Pin note + frame for your AI">📌</button>' +
      '</header><img tabindex="0" alt="' + o.id + '">';
    const img = d.querySelector('img');
    const sec = d.querySelector('select');

    img.addEventListener('click', (e) => {
      aktifOturum = o.id; vurgula();
      const r = img.getBoundingClientRect();
      const v = vp[o.id] || { width: r.width, height: r.height };
      ey({ tip:'tikla', oturum:o.id, x: Math.round((e.clientX-r.left)*(v.width/r.width)), y: Math.round((e.clientY-r.top)*(v.height/r.height)) });
      img.focus();
    });
    img.addEventListener('wheel', (e) => { e.preventDefault(); ey({ tip:'kaydir', oturum:o.id, dy: e.deltaY }); }, { passive:false });
    img.addEventListener('keydown', (e) => {
      const ozel = ['Enter','Backspace','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Escape','Delete'];
      if (ozel.includes(e.key)) { e.preventDefault(); ey({ tip:'tus', oturum:o.id, key: e.key }); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) { e.preventDefault(); ey({ tip:'tus', oturum:o.id, text: e.key }); }
    });
    sec.addEventListener('change', () => ey({ tip:'cihaz', oturum:o.id, cihaz: sec.value }));
    d.querySelector('.pin').addEventListener('click', async () => {
      const n = document.getElementById('not').value;
      const r = await ey({ tip:'isaret', oturum:o.id, not: n });
      if (r.ok) { document.getElementById('not').value=''; not('mark queued — your AI can read it'); }
    });
    return d;
  }

  function vurgula() {
    document.querySelectorAll('.tel').forEach((t) => t.classList.toggle('aktif', t.dataset.oturum === aktifOturum));
  }

  function panelleriGuncelle(d) {
    const kap = document.getElementById('ekranlar');
    for (const o of d.oturumlar) {
      vp[o.id] = o.viewport;
      let pane = kap.querySelector('[data-oturum="' + o.id + '"]');
      if (!pane) { pane = paneOlustur(o); kap.appendChild(pane); }
      const sec = pane.querySelector('select');
      if (!sec.options.length && cihazListesi.length) {
        for (const c of cihazListesi) { const op = document.createElement('option'); op.value = c.k; op.textContent = c.etiket; sec.appendChild(op); }
      }
      sec.value = o.cihaz;
      pane.querySelector('header b').textContent = o.id + ' · ' + o.etiket.split('—')[0].trim();
    }
    vurgula();
  }

  const es = new EventSource('/akis');
  es.addEventListener('kare', (e) => {
    const d = JSON.parse(e.data);
    const img = document.querySelector('[data-oturum="' + d.oturum + '"] img');
    if (img) img.src = 'data:image/jpeg;base64,' + d.img;
  });
  es.addEventListener('durum', (e) => {
    const d = JSON.parse(e.data);
    cihazListesi = d.cihazlar || cihazListesi;
    // Hata sayfasinin adresi kutuya yazilmaz: kullanici fark etmeden Git/geri ile
    // hata adresine geri donebiliyordu (17 Agu isaret testinde yasandi).
    if (d.url && !d.url.startsWith('chrome-error')) document.getElementById('url').value = d.url;
    document.getElementById('tema').value = d.tema;
    panelleriGuncelle(d);
    if (d.hata) kayit('k', 'PAGE: ' + d.hata);
  });
  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    kayit(d.tip === 'isaret' ? 'i' : (d.tip === 'konsol' ? 'u' : 'k'), '[' + d.oturum + '] ' + d.tip + ': ' + d.mesaj);
  });

  function kayit(sinif, metin) {
    const k = document.getElementById('kayit');
    const d = document.createElement('div'); d.className = sinif; d.textContent = metin;
    k.prepend(d); while (k.children.length > 80) k.lastChild.remove();
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  async function denetle() {
    not('inspecting...');
    const r = await ey({ tip:'denetle' });
    if (!r.ok) { not('inspection failed'); return; }
    const parcalar = [];
    for (const s of r.sonuclar) {
      const d = s.denetim || {};
      const rz = (renk, m) => '<span class="rozet" style="background:' + renk + '">' + m + '</span>';
      const p = [];
      if (d.yatayTasma) p.push(rz('#5c2b2b','overflow'));
      if (d.gorunmezMetin?.length) p.push(rz('#5c2b2b','invisible text ' + d.gorunmezMetin.length));
      if (d.butonSorun?.length) p.push(rz('#5a4a1f','buttons ' + d.butonSorun.length));
      if (d.dusukKontrast?.length) p.push(rz('#5a4a1f','contrast ' + d.dusukKontrast.length));
      if (d.kucukHedefler?.length) p.push(rz('#5a4a1f','under 44px ' + d.kucukHedefler.length));
      if (d.minikYazi?.length) p.push(rz('#33383e','under 12px ' + d.minikYazi.length));
      if (!p.length) p.push(rz('#264d2c','clean'));
      const li = [];
      // Bulgu metinleri DENETLENEN sayfanin DOM'undan gelir → escape ZORUNLU,
      // yoksa o sayfa panelin origin'inde script calistirabilir (stored XSS).
      for (const x of (d.gorunmezMetin||[])) li.push('<li class="k">INVISIBLE ' + esc(x.oran) + ':1 — "' + esc(x.metin) + '"</li>');
      for (const x of (d.butonSorun||[]).slice(0,5)) li.push('<li class="u">BUTTON "' + esc(x.metin) + '" → ' + esc(x.sorunlar.join(' · ')) + '</li>');
      for (const x of (d.dusukKontrast||[]).slice(0,5)) li.push('<li class="u">contrast ' + esc(x.oran) + ':1 — "' + esc(x.metin) + '"</li>');
      parcalar.push('<h4>' + esc(s.etiket || s.oturum) + '</h4>' + p.join('') + (li.length ? '<ul>' + li.join('') + '</ul>' : ''));
    }
    document.getElementById('bulgu').innerHTML = parcalar.join('');
    not('done — live/inspect.json updated');
  }
</script></body></html>`;

// --- Baslat ---
sunucu.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`  ! ${PORT} already in use — a panel may already be running. Try: --port 5056`);
    process.exit(2);
  }
  console.error('  ! server error:', e.message);
});

// YALNIZ loopback: host argumani verilmezse Node tum arayuzlere (0.0.0.0/::) baglar
// ve ayni agdaki herkes tarayici oturumunu surebilirdi.
sunucu.listen(PORT, '127.0.0.1', () => {
  try { writeFileSync(TOKEN_DOSYA, TOKEN, { mode: 0o600 }); } catch {}
  const adres = `http://localhost:${PORT}`;
  console.log(`\n  Live panel : ${adres}`);
  console.log(`  Target      : ${durum.url}  (theme: ${durum.tema})`);
  console.log(`  AI access   : MCP tools (see_screen/inspect/marks) or ${join(CANLI_DIR, 'last-mobil.jpg')}`);
  console.log(`  Antigravity/VS Code: Ctrl+Shift+P -> "Simple Browser: Show" -> ${adres}\n`);
  if (!ACMA) tarayicidaAc(adres);
});

// Tarayici oturumlari ayri: burada patlasa bile sunucu ayakta kalir, panel hatayi gosterir.
try {
  // Paralel kurulum: sirali beklemede toplam sure iki oturumun TOPLAMIYDI ve
  // MCP'nin 30sn hazir-olma butcesini asabiliyordu.
  await Promise.all([
    TEK ? null : oturumKur('web', arg('--desktop', 'desktop'), durum.tema),
    oturumKur('mobil', arg('--device', 'pixel'), durum.tema),
  ].filter(Boolean));
} catch (e) {
  durum.hata = String(e).split('\n')[0].slice(0, 200);
  console.error('  ! session setup failed:', durum.hata);
}

// Panel gun boyu acik kalir: tek bir istisna sunucuyu dusurmesin.
process.on('unhandledRejection', (e) => console.error('  ! unhandled rejection:', String(e).split('\n')[0].slice(0, 160)));
process.on('uncaughtException', (e) => console.error('  ! uncaught exception:', String(e).split('\n')[0].slice(0, 160)));
sunucu.on('clientError', (e, soket) => { try { soket.destroy(); } catch {} });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { try { await tarayici?.close(); } catch {} process.exit(0); });
}
