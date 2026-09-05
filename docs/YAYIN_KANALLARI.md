# uisight — nerede yayında

Son güncelleme: 5 Eylül 2026

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

```powershell
cd c:\dev\uisight
npm publish                                    # 2FA tarayıcıda onaylanır
.\.tools\mcp-publisher.exe login github; if ($?) { .\.tools\mcp-publisher.exe publish }
```

MCP kaydının token'ı bir saat kadar sonra düşüyor; `login` her seferinde
komutun içinde olmalı, ayrı çalıştırılırsa ikinci kez 401 alınır.

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

- **Open VSX doğrulama rozeti** — namespace `sololabstr` var, PAT yayımlayabiliyor
  (erişim var) ama `verified:false` (sahiplik yok). Talep AÇILDI 5 Eyl:
  https://github.com/EclipseFdn/open-vsx.org/issues/13032 — Option 1 kanıtıyla
  (Marketplace yayıncısı + package.json'ın işaret ettiği depo aynı organizasyona
  ait). 🔴 Şablon talebi yapan hesapta 12 ay kamuya açık geçmiş istiyor;
  `yusufcemres` 25 Mart 2026 açılışlı, yani 5,4 aylık. O kutu işaretlenmedi,
  gerekçe issue'da açıkça yazıldı. Reddedilirse Mart 2027'de tekrar.
- **mcp.so** — gönderildi 5 Eyl: https://github.com/chatmcp/mcpso/issues/3955
  (şablon yok, serbest biçim; kabul görmüş bir gönderi örnek alındı).
- **Smithery** — güncel belgelerde `smithery.yaml` HİÇ geçmiyor; üç yayın türü
  var: hosted, external (URL) ve stdio için **MCPB paketi**. Depodaki dosya eski
  `startCommand` biçiminde, çalışıp çalışmadığı doğrulanmadı — silinmedi ama
  içine bu not yazıldı.
- 🔑 **MCPB paketi — asıl fırsat, ayrı iş.** `.mcpb` artık resmi MCP paket biçimi
  (modelcontextprotocol/mcpb). Yerel sunucuyu ZIP + manifest.json olarak
  paketliyor ve Claude Desktop / Claude Code / MCP for Windows'ta **tek tıkla
  kurulum** veriyor — yani her yeni kullanıcının JSON düzenleme adımı kalkıyor.
  Smithery'nin stdio kaydı da bunu istiyor. Üretim bağımlılıkları ~31 MB
  (playwright-core 14M + zod 5.9M + sdk 5.7M + playwright 5M), sıkıştırılmış
  paket 12-15 MB civarı beklenir; tarayıcılar dahil değil, ilk çalıştırma
  indirmesi yine geçerli. Tahmini yarım gün: manifest, `mcpb` CLI ile paketleme,
  gerçek bir kurulum denemesi, sürümde üreten CI adımı.
- **glama.ai/mcp** ve `punkpeye/awesome-mcp-servers` (PR) — düşük maliyetli iki
  vitrin daha, henüz yapılmadı.

## Sayılar (5 Eylül 2026)

Open VSX 1.130 indirme · npm haftalık 168 · GitHub 102 yıldız · yorum 0.
