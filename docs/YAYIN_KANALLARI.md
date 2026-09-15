# uisight — nerede yayında

Son güncelleme: 15 Eylül 2026

## Paketler ve mağazalar

| Kanal | Kimlik | Adres |
|---|---|---|
| npm (ana paket) | `uisight` | https://www.npmjs.com/package/uisight |
| npm (sarmalayıcı) | `uisight-mcp` | https://www.npmjs.com/package/uisight-mcp |
| npm (sarmalayıcı) | `uisight-panel` | https://www.npmjs.com/package/uisight-panel |
| npm (sarmalayıcı) | `uisight-audit` | https://www.npmjs.com/package/uisight-audit |
| MCP resmi kaydı | `io.github.yusufcemres/uisight` | https://registry.modelcontextprotocol.io |
| Open VSX (Antigravity, Cursor, VSCodium, Windsurf) | `sololabstr.uisight` | https://open-vsx.org/extension/sololabstr/uisight |
| VS Code Marketplace | `sololabstr.uisight` | https://marketplace.visualstudio.com/items?itemName=sololabstr.uisight |
| Kaynak | `sololabstr/uisight` (MIT) | https://github.com/sololabstr/uisight |

Uzantı kimliği iki mağazada da `sololabstr.uisight` — kurulum sayıları ve
yorumlar ayrışmıyor.

## Yayın komutları

npm oturumu arada düşüyor. Önce kontrol et; düşmüşse `npm login`'i **tek başına** çalıştır:

```powershell
npm whoami        # "sololabs" yazmalı; E401 ise önce: npm login
```

Yayın — **tek satır olarak** yapıştır:

```powershell
cd c:\dev\uisight; npm publish; if ($?) { .\.tools\mcp-publisher.exe login github; if ($?) { .\.tools\mcp-publisher.exe publish } }
```

Üç tuzak (14 Eyl 2026'da üçüne de düşüldü):

- **Komutları alt alta ayrı satırlar hâlinde yapıştırma.** `npm login` / `npm publish` "Press ENTER" diye
  beklerken yapıştırılan bir sonraki satır o soruya cevap olarak gidiyor: npm `cd c:\dev\uisight` satırını
  kullanıcı adı sanıp girişi iptal etti, ardından `whoami` 401, `publish` 404 zincirleme geldi. Tek satırda
  `;` ile zincirlenince arada basılan ENTER doğrudan npm'e gider, `if ($?)` de npm başarısızsa MCP'yi atlar.
- **MCP adımı 400 "version '0.x.y' was not found" verirse kod hatası değil.** Kayıt npm'i yayından hemen sonra
  doğruluyor, npm ise "birkaç dakika sürebilir" diyor. Bir dakika bekleyip yalnız
  `.\.tools\mcp-publisher.exe publish` yeterli — giriş token'ı yerinde, yeniden `login` gerekmez.
- **MCP token'ı bir saat kadar sonra düşüyor;** uzun aradan sonra `login` komutun içinde olmalı, yoksa 401.

Ajan kabuğundan: `npm publish` yapılamıyor — 2FA bağlantısı araç çıktısında `***` olarak gizleniyor ve npm,
etkileşimsiz kabukta onay beklemeden EOTP ile çıkıyor. MCP `publish` ise kullanıcı `login` olduktan sonra
ajan kabuğundan çalışıyor (token makinede).

Open VSX (bu makineden yapılabiliyor, token dosyada):

```bash
cd /c/dev/uisight/extension
npx @vscode/vsce package --no-dependencies --allow-missing-repository
export OVSX_PAT=$(cat /c/dev/AGENTS/.credentials/tokens/ovsx.txt)
npx ovsx publish uisight-<sürüm>.vsix
```

Yayından sonra kayıtta görünmesi ~2 dakika sürüyor; o aralıkta yeniden
yayımlamak "already published, but currently isn't active" diyor — kalıcı hata
değil, beklemek yeter.

VS Code Marketplace: **elle yükleme**. `vsce package` ile `.vsix` üret,
https://marketplace.visualstudio.com/manage/publishers/sololabstr adresinde
"New extension → Visual Studio Code" ile yükle. Doğrulama ~5 dakika. Otomatik
yayın için Personal Access Token gerekiyor ama bu makinede Azure DevOps
organizasyonu açılamadı, ve PAT'lar 1 Aralık 2026'da emekli oluyor — yerine
gelen Entra ID yolu CI için tasarlanmış. Elle yükleme resmi belgede geçerli bir
yol olarak sayılıyor.

## Henüz kayıtlı olmadığımız yerler

- **mcp.so** — gönderildi 5 Eyl: https://github.com/chatmcp/mcpso/issues/3955
  (şablon yok, serbest biçim; kabul görmüş bir gönderi örnek alındı). 14 Eyl
  itibarıyla hâlâ AÇIK, yorum yok.
- **Smithery** — güncel belgelerde `smithery.yaml` HİÇ geçmiyor; üç yayın türü var: hosted,
  external (URL) ve stdio için **MCPB paketi**. Paket artık var (alttaki madde) → sıradaki adım
  Smithery'ye MCPB ile başvurmak, kullanıcı hesabıyla. Depodaki eski `startCommand` dosyası
  silinmedi, içine not yazıldı.
- ✅ **MCPB paketi ÜRETİLİYOR — 0.34.0, 16 Eyl.** `node scripts/build-mcpb.mjs` →
  `dist/uisight-<sürüm>.mcpb`: **7,4 MB** paket, 27,7 MB açılmış (tahmin 12-15 MB'dı). Manifest
  `mcpb/manifest.json`, kilidi `test/mcpb-manifest.test.mjs` (araç listesi + ayarlar + sürüm kodla
  aynı kalmak zorunda). Kurulum ekranı üç şey soruyor: adres, araç seti, ilk kullanımda tarayıcı
  indirilsin mi.
  🔑 **Tek tık YALNIZ Claude Desktop** (macOS + Windows). Resmî belge Claude Code demiyor; buradaki
  eski "Claude Code / MCP for Windows" iddiası doğrulanmamıştı, kaldırıldı.
  Doğrulandı (16 Eyl): paket açılıp Claude Desktop'un yaptığı gibi `node src/mcp.mjs` ile koşturuldu
  → 9 araç, `status` ve `inspect` gerçek ölçüm, MCP kanalına karışan çıktı yok; tarayıcısız ortamda
  otomatik indirme 61 saniyede bitip oturumlar açıldı. `mcpb pack` 1.284 dosyayı eliyor (`.d.ts`,
  `.map`, lint ayarları) — çalışma kodu değil.
  🔴 Dağıtım: GitHub **Release varlığı** olarak yüklenecek; depoda henüz HİÇ release yok ve README
  `releases/latest` bağlantısı veriyor. İmzasız (`mcpb sign` sertifika ister). Sürümle otomatik
  üretim, org Actions ödemesi çözülünce.
- `punkpeye/awesome-mcp-servers` (PR) — 15 Eyl'de listede YOK doğrulandı (ham README 1,6 MB;
  GitHub contents API 1 MB üstünü boş döndürür, oradan "yok" okunmaz). Hedef bölüm **Browser
  Automation**, `softvoyagers/pageshot-api` ile `SolveGate/solvegate-mcp` arası; satır biçimi
  `- [owner/repo](github) [![glama rozeti](…/badges/score.svg)](glama) 📇 🏠 - açıklama`. Ajan
  PR'ı başlık sonuna `🤖🤖🤖` ekleyince hızlı birleştiriliyor (CONTRIBUTING). 🟡 **16 Eyl gönderildi:**
  [#14476](https://github.com/punkpeye/awesome-mcp-servers/pull/14476) (fork `yusufcemres/awesome-mcp-servers`,
  dal `add-uisight`; tek commit, README +1/-0). Fork eski çıktı (`e7e8756`) → önce `gh repo sync`, sonra ekleme.
- ✅ **glama.ai/mcp** — ayrıca kayıt gerekmedi, GitHub'dan kendiliğinden dizinlenmiş:
  https://glama.ai/mcp/servers/sololabstr/uisight (15 Eyl: not B, rozet çalışıyor).

## Kapananlar

- ✅ **Open VSX doğrulama rozeti** — namespace `sololabstr` artık `verified:true`; talep
  [#13032](https://github.com/EclipseFdn/open-vsx.org/issues/13032) KAPANDI (14 Eyl'de görüldü). Option 1
  kanıtıyla açılmıştı: Marketplace yayıncısı ve `package.json`'ın işaret ettiği depo aynı organizasyonda.
  Şablonun "talep eden hesapta 12 ay kamuya açık geçmiş" kutusu işaretlenmemişti (`yusufcemres` 25 Mart 2026
  açılışlı); gerekçe issue'da açıkça yazılmıştı ve engel olmadı.

## Dış katkılar

| Tarih | Katkıcı | PR | Durum |
|---|---|---|---|
| 15 Eyl 2026 | [@0fakaza](https://github.com/0fakaza) (commit adı `0xkyouma`) | #7 MCP paneli `--port` vermeden başlatıyordu: `UISIGHT_PORT` yoksa otomatik başlatma hiç çalışmıyordu · #4 panel başına iki tarayıcı · #5 izleyen yokken kare kodlama (boşta çekirdeğin %64'ü) · #8 gizli yazıya "12px altı" | ✅ Birleşti, **0.32.1** (16 Eyl; npm + MCP kaydı) |
| 15 Eyl 2026 | aynı | #6 panelde iPhone profilleri WebKit ile | ✅ **#9 ile 0.33.0** (16 Eyl). İki commit'i yazar adıyla korunarak main'e taşındı; üstüne bizim commit: kurulum önerisi açılan profillerin motorlarından · "hiç indirilmemiş" oturumda bir kez not + komut, "kurulu ama açılmıyor" her karede WARNING · Chromium yedekte etiket "stand-in" · `stopStream` `streamGen`'i artırır · testi Windows'ta `pathToFileURL`. #6 kapatıldı, #9'a yönlendirildi |

Dış PR'da izlenen yol (15 Eyl): kodu oku ve riskli kalıp tara (ağ, `child_process`, `package.json`, CI dosyaları) → her
PR'ı ayrı koştur, yeni testi düzeltmesiz main kaynağına karşı da koştur (düşmeli) → yerel entegrasyon dalında sırayla
birleştirip tam test → GitHub'da `--match-head-commit <TAM sha>` ile birleştir → sürüm commit'ini birleşmiş main'in
ağacı yereldekiyle aynıysa ekle. Bu PR'larda CI hiç koşmadı (fork + org Actions ödeme sorunu); yeşil işaret beklenmez.

## Duyurular

| Tarih | Kanal | Ne | Not |
|---|---|---|---|
| 5 Eyl 2026 | dev.to (`yusufcemres`) | "I pointed my UI-auditing tool at three sites… all seven bugs were its own" | Kaynağı `docs/blog/2026-09-05-seven-bugs.md`. İlk yayın "110px" diyordu; doğrusu 85px (telefon 1,9 kat çiziliyordu). Depo kopyası `3baaf5a`'da, dev.to'daki metin 15 Eyl'de elle düzeltildi. |
| 15 Eyl 2026 | LinkedIn (kişisel profil) | SoloLabs ürün tanıtım serisi: "Yapay zekâ ekranı görür. uisight ölçer." | Görsel `docs/assets/social/uisight-linkedin-urun.png` (kokart.app canlı panel ölçümü). Bağlantılar ilk yorumda: Marketplace, Open VSX, GitHub, dev.to. |
| 15 Eyl 2026 01:30 | Reddit r/mcp | "I built an MCP server that measures UI instead of guessing from screenshots. The first seven bugs it found were its own." — https://www.reddit.com/r/mcp/comments/1wgidpu/ | 🔴 **"Reddit'teki filtreler tarafından kaldırıldı"** (paylaşımdan hemen sonra). Mod'lara mesaj da gitmedi: "You can't message that user" → hesap düzeyi kısıt (yeni/az karma/e-posta doğrulanmamış). Gönderi SİLİNMEDİ, mod kuyruğunda bekliyor. |

Reddit taslakları: `docs/duyurular/reddit/` (r-mcp, r-claudeai, r-vscode; görsel yerleri `>>> [GÖRSEL n] <<<` satırlarında; kopyası `Desktop\uisight-reddit\`). Yapıştırma: Markdown düzenleyici + satırı silip görsel simgesiyle yükle.

**15 Eyl 16:40 durum:** gönderi 15 saat sonra hâlâ "filtreler tarafından kaldırıldı", mod onayı yok. Profil: **karma 1 · Reddit yaşı 1 hafta** → sebep kesin hesap güveni. Buradan otomatik okunamıyor (Reddit girişsiz 403; agent-reach Windows Uygulama Denetimi'nde engelli) — durum kullanıcının ekranından okunur.

✅ **glama.ai zaten dizinde:** https://glama.ai/mcp/servers/sololabstr/uisight (GitHub'dan kendiliğinden, lisans notu A). Ayrı kayıt gerekmiyor.

### ⏭️ Bakılacaklar (16 Eyl'den itibaren)

1. r/mcp gönderisi onaylandı mı (bağlantıyı aç; "kaldırıldı" yazısı kalktı mı).
2. Reddit hesabı: e-posta doğrulandı mı (Ayarlar → Hesap) · karma ve hesap yaşı (profil). Kısıt buysa r/ClaudeAI ve r/vscode'a **gönderme**; önce bir-iki hafta ilgili topluluklarda bağlantısız, gerçek yardım yorumu. Aynı gönderiyi yeniden atma, yeni hesap açma.
3. Reddit'ten bağımsız vitrinler: glama.ai ✅ zaten dizinde. **punkpeye/awesome-mcp-servers** PR'ı [#14476](https://github.com/punkpeye/awesome-mcp-servers/pull/14476) 16 Eyl'de açıldı → birleşti mi bak (taslak `docs/duyurular/awesome-mcp-servers.md`) (u/punkpeye aynı zamanda r/mcp modu; PR'ı Reddit onayı için arka kapı olarak KULLANMA).
4. Reddit hesabı (15 Eyl: karma 1, 1 haftalık): r/mcp, r/ClaudeAI, r/ClaudeCode, r/PWA gibi yerlerde bağlantısız, gerçek yardım yorumu. Karma birkaç düzineyi, hesap 2-4 haftayı bulunca r/ClaudeAI taslağıyla yeniden dene.

Sıra (değişmedi): r/mcp → r/ClaudeAI → r/vscode → Show HN en son. Dış gönderim her biri için ayrı onayla.

`docs/assets/social/uisight-linkedin-olcek.png` — önce/sonra (412 → 792 px, "1,9 katı") karşılaştırması; ikinci görsel ya da ayrı gönderi için hazır.

## Sayılar

16 Eylül 2026 — sürümler: npm + MCP kaydı **0.33.0** (npm paketi `b9c0b481…`, 13 dosya git `7ff228c` ile içerik aynı; dosyalar CRLF, önceki sürümler de öyle), Open VSX + VS Code Marketplace **1.7.2** (eklenti motoru `npx uisight@latest` ile çektiği için motor düzeltmesinde eklenti sürümü gerekmez). Sayı tablosu 14 Eyl'in.

| Kanal | 14 Eyl | 5 Eyl |
|---|---|---|
| npm `uisight` | haftalık 1.134 · aylık 4.097 | haftalık 168 |
| npm sarmalayıcılar (aylık) | mcp 177 · panel 153 · audit 129 | — |
| Open VSX | 1.674 indirme · yorum 0 | 1.130 |
| VS Code Marketplace | 7 kurulum · 1 puan (5★) | — |
| GitHub | 127 yıldız · 10 fork · 0 açık issue | 102 yıldız |
| dev.to yazısı | 0 tepki · 0 yorum | — |

🔴 npm sayısını dış kullanım sanma: `/app-hazirlik` her projede `npx uisight` koşuyor ve sarmalayıcı kurulumları
ana paketi ikinci kez sayıyor. Dış kullanımın daha temiz sinyali Open VSX indirmesi ile GitHub yıldızı.
