const vscode = require('vscode');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

let serverProcess = null;
let panel = null;
let statusItem = null;

const config = () => vscode.workspace.getConfiguration('uisight');
/**
 * Proje basina ayri port — MCP ile AYNI hesap.
 *
 * Sabit 5055'te dort proje ayni panele bakiyordu: kenar cubugunda hangi
 * uygulamayi gordugun, o an hangi projenin panelinin once actigina kaliyordu.
 * Calisma alani klasorunden turetilen port her projeye kendi panelini verir ve
 * ayni proje her acilista ayni portu alir.
 *
 * Ayarda bir deger varsa o kazanir (0 = otomatik).
 */
const BLOCKED_PORTS = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697]);
function derivedPort() {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || process.cwd();
  let h = 2166136261;                       // FNV-1a, MCP tarafiyla birebir ayni
  for (const c of folder.toLowerCase()) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < 120; i++) {
    const p = 5055 + ((Math.abs(h) + i) % 120);
    if (!BLOCKED_PORTS.has(p)) return p;
  }
  return 5055;
}
const port = () => config().get('port', 0) || derivedPort();

/**
 * Calisan panelleri bul.
 *
 * Proje-basina port cakismayi cozdu ama yeni bir bosluk acti: turetme yalniz
 * ajan ile editorun AYNI klasorde olmasi halinde tutuyor. Ajan bir klasorden
 * calisip baska bir uygulamayi hedeflediginde — ki sik olan bu — kenar cubugu
 * bos bir porta bakiyor ve insan ajanin ne yaptigini goremiyor. Oysa bu aracin
 * butun tezi ikisinin AYNI ekrani paylasmasi.
 *
 * Cozum tahmin degil kesif: araligi tara, ne varsa goster.
 */
async function discoverPanels(timeoutMs = 400) {
  const adaylar = [];
  for (let p = 5055; p < 5175; p++) if (!BLOCKED_PORTS.has(p)) adaylar.push(p);

  const dene = (p) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: p, path: '/state', method: 'GET', timeout: timeoutMs },
      (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => {
          try {
            const d = JSON.parse(s);
            resolve(d && d.sessions ? { port: p, url: d.url } : null);
          } catch { resolve(null); }
        });
      });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
    r.end();
  });

  const sonuc = await Promise.all(adaylar.map(dene));
  return sonuc.filter(Boolean);
}
const toolPath = () => config().get('toolPath', '');

// --- Sunucu ile konusma ---
/**
 * The panel refuses a POST without its token, so every command has to carry it.
 * The server writes the token to ~/.uisight/live/token-<port> on startup; it is
 * read per request because restarting the panel mints a new one.
 *
 * Reading it fresh each time also means a stale token never silently turns every
 * command into a 403 — the failure people describe as "the buttons do nothing".
 */
function token() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.uisight', 'live', `token-${port()}`), 'utf8').trim();
  } catch { return ''; }
}

function request(route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-uisight-token': token() }
      : {};
    const r = http.request(
      { host: '127.0.0.1', port: port(), path: route, method: data ? 'POST' : 'GET', headers, timeout: 120000 },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => {
          if (res.statusCode === 403) return reject(new Error('the panel rejected the token — restart it from the side panel'));
          try { resolve(JSON.parse(s)); } catch { resolve(null); }
        });
      }
    );
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timed out')); });
    if (data) r.write(data);
    r.end();
  });
}

const isServerUp = () => request('/state').then((d) => !!d).catch(() => false);

async function startServer(output) {
  if (await isServerUp()) return true; // bu portta zaten calisiyor

  // Bu portta yok ama BASKA bir portta olabilir: ajan baska bir klasorden
  // calisiyorsa turetilen port tutmaz. Varsa ona baglan, yenisini acma.
  const bulunan = await discoverPanels();
  if (bulunan.length === 1) {
    await config().update('port', bulunan[0].port, true);
    output.appendLine(`[bilgi] running panel found on ${bulunan[0].port} (${bulunan[0].url}) — attaching`);
    return true;
  }
  if (bulunan.length > 1) {
    const secim = await vscode.window.showQuickPick(
      bulunan.map((b) => ({ label: `port ${b.port}`, description: b.url, port: b.port })),
      { placeHolder: 'Several panels are running — which one?' },
    );
    if (secim) {
      await config().update('port', secim.port, true);
      output.appendLine(`[bilgi] attaching to ${secim.port}`);
      return true;
    }
  }

  const a = config();
  const common = [
    `"${a.get('url', 'http://localhost:3000')}"`,
    '--port', String(port()),
    '--device', a.get('device', 'pixel'),
    '--theme', a.get('theme', 'light'),
    '--no-open',                       // panel bu pencerede; harici tarayici acma
  ];

  // Iki yol, bu sirayla:
  //
  //   1. Ayarin gosterdigi yerel kopya — gelistirme icin, degisiklikler aninda.
  //   2. Yayinlanan paket, `npx -p uisight@latest` ile.
  //
  // Ikincisi eklentinin baska bir makinede calisabilmesinin TEK yolu: onceki
  // surumler `c:\dev\uisight` yoluna civiliydi, yani baskasina verilebilir bir
  // eklenti degildi. Ve `@latest` motoru kendiliginden guncel tutar — bir kez
  // kurulan eklenti yeni kontrolleri almaya devam eder.
  const root = toolPath();
  const entry = path.join(root, 'src', 'server.mjs');
  const local = fs.existsSync(entry);

  const nodeCommand = local ? a.get('nodePath', 'node') : 'npx';
  const args = local
    ? [`"${entry}"`, ...common]
    : ['-y', '-p', 'uisight@latest', 'uisight-panel', ...common];
  const cwd = local ? root : undefined;

  if (!local) {
    output.appendLine('[bilgi] yerel kopya yok -> yayinlanan paket (npx uisight@latest).');
    output.appendLine('[bilgi] ilk calistirma paketi ve tarayiciyi indirir, bir kereye mahsus birkac dakika surebilir.');
  }

  output.appendLine(`[baslatiliyor] ${nodeCommand} ${args.join(' ')}${cwd ? `  (cwd: ${cwd})` : ''}`);
  let spawnError = null;
  try {
    // shell:true -> Windows'ta "node" PATH uzerinden cozulur (spawn tek basina cozemeyebiliyor).
    serverProcess = spawn(nodeCommand, args, { cwd, windowsHide: true, shell: true });
  } catch (e) {
    spawnError = e.message;
  }

  if (serverProcess) {
    serverProcess.on('error', (e) => { spawnError = e.message; output.appendLine(`[spawn hatasi] ${e.message}`); });
    serverProcess.stdout?.on('data', (d) => output.append(String(d)));
    serverProcess.stderr?.on('data', (d) => output.append(String(d)));
    serverProcess.on('exit', (code) => { output.appendLine(`\n[panel sunucusu kapandi — code ${code}]`); serverProcess = null; refreshStatus(); });
  }

  // Playwright acilisi birkac saniye surer.
  for (let i = 0; i < 60; i++) {
    if (await isServerUp()) return true;
    if (spawnError) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const reason = spawnError
    ? `could not run node: ${spawnError} — put the full path to node.exe in "uisight.nodePath".`
    : 'sunucu 30 sn icinde response vermedi.';
  output.appendLine(`[HATA] ${reason}`);
  output.show(true);
  vscode.window.showErrorMessage(`uisight: panel baslamadi — ${reason}`);
  return false;
}

// --- Webview ---
/** Panel sunucusunu gomen iframe. Ayni HTML hem editor sekmesinde hem yan panelde. */
function gomuluHtml(p, dar, paneller = []) {
  // Birden fazla panel calisiyorsa hangisine baktigin ANLASILIR olmali ve
  // degistirmek icin komut paletine gitmek gerekmemeli: dort projeyi paralel
  // denetlerken bu, kenar cubugunun tek kullanisli halinden cok daha yakini.
  //
  // Anahtar paneli TASIYAN cerceveye ait, iceriginе degil — panelleri zaten
  // eklenti kesfediyor ve iframe'in kaynagini o degistirebiliyor.
  const hepsi = paneller.length ? paneller : [{ port: p, url: '' }];
  const kaynaklar = [...new Set(hepsi.map((x) => x.port).concat(p))]
    .map((q) => `http://localhost:${q} http://127.0.0.1:${q}`).join(' ');

  const kisalt = (u) => {
    if (!u) return '';
    try {
      const x = new URL(u);
      return (x.host + x.pathname).replace(/\/$/, '').slice(0, dar ? 22 : 46);
    } catch { return String(u).slice(0, 30); }
  };

  const secenekler = hepsi.map((x) =>
    `<option value="${x.port}"${x.port === p ? ' selected' : ''}>${x.port} · ${kisalt(x.url) || 'bos'}</option>`,
  ).join('');

  const cubuk = hepsi.length > 1 ? `
  <div class="sw">
    <select id="sec" title="Which running panel to show">${secenekler}</select>
    <button id="yenile" title="Look again for panels that started since this opened">Scan</button>
  </div>` : '';

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${kaynaklar}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  html,body{margin:0;padding:0;border:0;width:100%;height:100vh;
    background:var(--vscode-editor-background,#1e1f22);display:flex;flex-direction:column;}
  iframe{margin:0;padding:0;border:0;width:100%;flex:1;display:block;background:#1e1f22;}
  .sw{display:flex;gap:6px;align-items:center;padding:4px 6px;
    background:var(--vscode-sideBar-background,#2b2d30);
    border-bottom:1px solid var(--vscode-widget-border,#393b40);}
  .sw select{flex:0 1 auto;min-width:0;max-width:100%;
    background:var(--vscode-dropdown-background,#1e1f22);
    color:var(--vscode-dropdown-foreground,#dfe1e5);
    border:1px solid var(--vscode-dropdown-border,#45474d);border-radius:4px;
    padding:3px 6px;font:11px/1.4 var(--vscode-font-family,"Segoe UI",system-ui,sans-serif);}
  .sw button{background:var(--vscode-button-secondaryBackground,#1e1f22);
    color:var(--vscode-button-secondaryForeground,#dfe1e5);
    border:1px solid var(--vscode-dropdown-border,#45474d);border-radius:4px;cursor:pointer;
    padding:3px 8px;font-size:12px;line-height:1.4;}
  .sw button:hover{border-color:var(--vscode-focusBorder,#4c6fd6);}
</style>
</head><body>${cubuk}
<iframe src="http://localhost:${p}${dar ? '?narrow=1' : ''}" allow="clipboard-read; clipboard-write"></iframe>
<script>
  const vs = acquireVsCodeApi();
  const sec = document.getElementById('sec');
  if (sec) sec.addEventListener('change', () => vs.postMessage({ type: 'switch', port: Number(sec.value) }));
  const y = document.getElementById('yenile');
  if (y) y.addEventListener('click', () => vs.postMessage({ type: 'rescan' }));
</script>
</body></html>`;
}

const bilgiHtml = (m) => `<!doctype html><meta charset="utf-8">
<style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:18px;line-height:1.6}</style>
<body>${m}`;

/**
 * Sol etkinlik cubugundaki gorunum.
 *
 * Editor sekmesinden tek farki gorunurluk, ama asil mesele o: araci kullanacak
 * kisi komut paletinde "Mobil Panel: Ac" yazmayi hatirlamak zorunda kalmasin.
 * Ikona basinca eklenti uyanir ve sunucuyu gerekiyorsa kendisi baslatir.
 */
class SidePanelProvider {
  constructor(ctx, output) { this.ctx = ctx; this.output = output; }

  async resolveWebviewView(view) {
    this.view = view;
    view.webview.html = bilgiHtml('Panel baslatiliyor...');
    view.webview.onDidReceiveMessage(async (m) => {
      if (m.type === 'switch') {
        await config().update('port', m.port, true);
        await this.ciz(true);
      } else if (m.type === 'rescan') {
        await this.ciz(true);
      }
    });
    try {
      const ok = await startServer(this.output);
      if (!ok) {
        view.webview.html = bilgiHtml('Panel sunucusu baslamadi.<br><br>Cikti panelinde <b>uisight</b> kanalina bak.');
        return;
      }
      await this.ciz(false);
    } catch (e) {
      view.webview.html = bilgiHtml(`Panel acilamadi: ${String(e.message || e)}`);
    }
  }

  /** Kesfet, port eslemesini TUM panellere ac, cubukla birlikte ciz. */
  async ciz() {
    const view = this.view;
    if (!view) return;
    const p = port();
    const paneller = await discoverPanels();
    // Eslemede yalniz secili port olursa digerine gecince iframe bos kalir.
    const portlar = [...new Set(paneller.map((x) => x.port).concat(p))];
    view.webview.options = {
      enableScripts: true,
      portMapping: portlar.map((q) => ({ webviewPort: q, extensionHostPort: q })),
    };
    view.webview.html = gomuluHtml(p, true, paneller);
  }
}

function showPanel(ctx) {
  const p = port();
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }

  panel = vscode.window.createWebviewPanel('uisightPanel', 'uisight', vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
    portMapping: [{ webviewPort: p, extensionHostPort: p }],
  });
  panel.onDidDispose(() => { panel = null; refreshStatus(); }, null, ctx.subscriptions);

  const ciz = async () => {
    const q = port();
    const paneller = await discoverPanels();
    const portlar = [...new Set(paneller.map((x) => x.port).concat(q))];
    panel.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      portMapping: portlar.map((r) => ({ webviewPort: r, extensionHostPort: r })),
    };
    panel.webview.html = gomuluHtml(q, false, paneller);
  };

  panel.webview.onDidReceiveMessage(async (m) => {
    if (m.type === 'switch') { await config().update('port', m.port, true); await ciz(); }
    else if (m.type === 'rescan') await ciz();
  }, null, ctx.subscriptions);

  void ciz();
  refreshStatus();
}

function refreshStatus() {
  if (!statusItem) return;
  const isOpen = !!panel;
  statusItem.text = isOpen ? '$(device-mobile) uisight — open' : '$(device-mobile) uisight';
  statusItem.tooltip = isOpen ? 'Bring the panel forward / manage it' : 'Open the live mobile panel';
}

// --- Komutlar ---
async function act(type, extra) {
  try { return await request('/action', { type, ...extra }); }
  catch { vscode.window.showWarningMessage('uisight: the panel server is not answering — run "uisight: Open panel".'); return null; }
}

function activate(ctx) {
  const output = vscode.window.createOutputChannel('Mobil QA');
  ctx.subscriptions.push(output);

  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(
    'uisight.sidePanel',
    new SidePanelProvider(ctx, output),
    { webviewOptions: { retainContextWhenHidden: true } },
  ));

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'uisight.open';
  refreshStatus();
  statusItem.show();
  ctx.subscriptions.push(statusItem);

  const register = (ad, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(ad, fn));

  register('uisight.open', async () => {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting uisight…' },
      async () => { if (await startServer(output)) showPanel(ctx); });
  });

  register('uisight.stop', async () => {
    if (panel) { panel.dispose(); panel = null; }
    if (serverProcess) { serverProcess.kill(); serverProcess = null; }
    refreshStatus();
    vscode.window.showInformationMessage('Mobil panel durduruldu.');
  });

  register('uisight.device', async () => {
    const choice = await vscode.window.showQuickPick([
      { label: 'pixel', description: 'Pixel 7 — Android Chrome' },
      { label: 'iphone-15', description: 'iPhone 15 Pro' },
      { label: 'iphone-se', description: 'iPhone SE — 320px, the narrowest break point' },
      { label: 'galaxy', description: 'Galaxy S9+' },
      { label: 'ipad', description: 'iPad — tablet' },
    ], { placeHolder: 'Cihaz profili' });
    if (choice) { await act('device', { device: choice.label }); await config().update('device', choice.label, true); }
  });

  register('uisight.theme', async () => {
    const choice = await vscode.window.showQuickPick(['light', 'dark'], { placeHolder: 'Colour theme' });
    if (choice) { await act('device', { theme: choice }); await config().update('theme', choice, true); }
  });

  register('uisight.goto', async () => {
    const d = await request('/state').catch(() => null);
    const url = await vscode.window.showInputBox({ prompt: 'Address for the panel to open', value: d?.url || config().get('url') });
    if (url) { await act('goto', { url }); await config().update('url', url, true); }
  });

  register('uisight.attach', async () => {
    const bulunan = await discoverPanels();
    if (!bulunan.length) {
      vscode.window.showInformationMessage('uisight: no running panel found on 5055-5174.');
      return;
    }
    const secim = await vscode.window.showQuickPick(
      bulunan.map((b) => ({ label: `port ${b.port}`, description: b.url, port: b.port })),
      { placeHolder: 'Attach the side panel to a running session' },
    );
    if (!secim) return;
    await config().update('port', secim.port, true);
    showPanel(ctx);
    vscode.window.showInformationMessage(`uisight: attached to port ${secim.port}`);
  });

  register('uisight.inspect', async () => {
    const s = await act('inspect');
    // The engine answers { results: [ { inspection } ] } — one entry per session.
    const d = s?.results?.[0]?.inspection;
    if (!d) { vscode.window.showWarningMessage('uisight: the panel returned no measurement.'); return; }

    // Every category the engine reports. A check missing from this list is a
    // check whose findings never reach the person reading the panel — which is
    // how the old build showed "no findings" while the engine had plenty.
    const lines = [];
    const n = (a) => (a || []).length;
    if (d.horizontalOverflow) {
      lines.push(`SIDEWAYS SCROLL: page ${d.horizontalOverflow.pageWidth}px / screen ${d.horizontalOverflow.viewportWidth}px`);
    }
    for (const x of d.invisibleText || []) lines.push(`INVISIBLE TEXT ${x.ratio}:1 — ${x.sel} "${x.text}"`);
    for (const x of d.coveredControls || []) lines.push(`COVERED ${x.percent}% — "${x.text}" under "${x.coveredByText}"`);
    for (const x of d.coveredByFixed || []) lines.push(`UNDER A FIXED BAR ${x.percent}% — "${x.text}"`);
    for (const x of d.buttonIssues || []) lines.push(`BUTTON ${x.sel} "${x.text}" -> ${x.issues.join(' · ')}`);
    for (const x of d.sameLookingActions || []) lines.push(`NO PRIMARY ACTION — ${x.labels.join(' / ')}`);
    for (const x of d.lowContrast || []) lines.push(`contrast ${x.ratio}:1 (needs ${x.threshold}) — "${x.text}"`);
    for (const x of d.smallTargets || []) lines.push(`under 44px ${x.size} — "${x.text}"`);
    for (const x of d.tinyText || []) lines.push(`text below 12px (${x.fontSize}) — "${x.text}"`);
    for (const x of d.clippedText || []) lines.push(`CLIPPED — "${x.text}"`);
    for (const x of d.darkModeLightPatches || []) lines.push(`LIGHT PATCH IN DARK MODE ${x.size} (${x.share}% of the screen) — ${x.sel}`);
    for (const x of d.mixedLanguage || []) lines.push(`MIXED LANGUAGE — "${x.text}"`);
    for (const x of d.usDates || []) lines.push(`US DATE FORMAT — "${x.text}"`);
    for (const x of d.unsafeArea || []) lines.push(`UNDER THE NOTCH (${x.edge}) — "${x.text}"`);
    for (const x of d.clippedContainer || []) lines.push(`CLIPPED, NO SCROLL ${x.hiddenPx}px — "${x.text}"`);
    for (const x of d.textUnderControl || []) lines.push(`TEXT BEHIND A CONTROL — "${x.text}" behind "${x.controlText}"`);
    for (const x of d.loadingButEmpty || []) lines.push(`EMPTY WHILE LOADING — "${x.text}"`);
    for (const x of d.genericErrors || []) lines.push(`ERROR SAYS NOTHING — "${x.text}"`);
    for (const x of d.destructiveWithoutConfirm || []) lines.push(`NO CONFIRMATION — "${x.text}"`);
    for (const x of d.eagerPermissions || []) lines.push(`PERMISSION ASKED ON LOAD — ${x.api} at ${x.atMs}ms`);
    if (d.imagesWithoutAlt) lines.push(`${d.imagesWithoutAlt} image(s) with no alt text`);

    // A capped list hides how much was left out; say both numbers.
    const capped = Object.entries(d.totals || {})
      .filter(([k, v]) => v > n(d[k]))
      .map(([k, v]) => `${k} ${n(d[k])}/${v}`);

    output.clear();
    output.appendLine(`uisight — ${new Date().toLocaleString()}`);
    output.appendLine(lines.length ? lines.join('\n') : 'No findings from the automated checks — still look at the screen.');
    if (capped.length) output.appendLine(`\n(showing part of: ${capped.join(', ')})`);
    output.show(true);
    vscode.window.showInformationMessage(`uisight: ${lines.length} finding(s) — details in the Output panel.`);
  });

  register('uisight.send', async () => {
    const s = await act('save');
    const first = s?.paths && Object.values(s.paths)[0];
    if (first) vscode.window.showInformationMessage(`Screen saved: ${first} — your AI can read this file.`);
  });
}

function deactivate() {
  if (serverProcess) { try { serverProcess.kill(); } catch {} serverProcess = null; }
}

module.exports = { activate, deactivate };
