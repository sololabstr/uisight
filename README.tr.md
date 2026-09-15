# uisight (Türkçe özet)

**AI ekranı zaten görüyor. Ölçemiyor.**

Ekran görüntüsü ajana *tahmin* ettirir: "şu başlık biraz soluk duruyor." uisight **bildirir**:

```diff
- ekran goruntusunden:  "baslik biraz soluk gorunuyor, rengi ayarlasak?"
+ uisight'tan:          GORUNMEZ METIN 1.04:1 — span.bg-gradient-to-r "basligin"
+                       (metin rgba(255,255,255,.5) / zemin rgb(247,247,248))
```

Biri izlenim, diğeri seçicisi elinde bir ölçüm — ajan aramadan doğrudan o elemanı düzeltiyor.

uisight, **web ve responsive arayüzler** için bir MCP sunucusu (Claude Code, Cursor, Antigravity — MCP konuşan her araç): yan yana canlı mobil + masaüstü oturumları, ölçüm motoru ve insanla ajanın aynı ekranı paylaştığı panel.

## "Ajanım zaten yapıyor"

Kısmen doğru — computer use, tarayıcı araçları ve çoğu ajan iskeleti sayfayı açıp ekran görüntüsü alabiliyor. uisight o kısmın yerine geçmeye çalışmıyor. Eksik kalan üç şey var:

**1. Bakmak ölçmek değil.** Görüntüye bakan bir model kontrast oranı söyleyemez; 4,6:1 (geçer) ile 4,3:1'i (AA'da kalır) ayırt edemez — gözle aynı görünürler. Dokunma hedefinin 44 değil 41px olduğunu ya da bir elemanın açık/koyu temada aynı kaldığını (rengi sabit-kodlu) fark etmez. uisight bunları canlı DOM'dan hesaplar: alfa-harmanlı zeminler, gradient yazı, `oklch()` renkler dahil.

**2. Aynı paraya çok daha fazlası.** Ölçtük: bir mobil kare ~460 token, karşılığı olan `inspect` çıktısı ~570. Yani ucuz olduğu için değil — **aynı fiyata, görüntünün söyleyemeyeceği şeyi söylediği için** kullanılıyor. Asıl tasarruf başka yerde: `uisight <adres>` koşup raporu okutmak ~800 token, tek sefer; MCP araçlarını ekran ekran sürmek ise her adımda tüm sohbeti yeniden gönderir.

**3. Kimse seninle birlikte bakmıyor.** Alışıldık kurulumda ajan sayfaya tek başına bakıp rapor eder. Burada aynı canlı oturumu ikiniz izlersiniz; bir sorun gördüğünde 📌 ile alanı seçip not bırakırsın, ajan notunu ve o kırpılmış kareyi okur.

Kapsam notu: uisight **web/responsive** içindir. Native iOS/Android uygulama kontrolü için [Argent](https://github.com/software-mansion/argent) çok daha kapsamlıdır.

## Hızlı başlangıç

```bash
npx uisight https://siteniz.com --theme both     # tek seferlik denetim: PNG + galeri + rapor
npx -y -p uisight uisight-panel http://localhost:3000   # canlı panel: sen gez, AI izlesin (ve tersi)
npx -y -p uisight uisight-audit                  # giriş yapıp her rolü gezer
```

**İlk çalıştırma.** Playwright sürücüsünü npm ile getirir ama tarayıcıları ayrı
indirir; yani ilk çalıştırmada sürülecek bir şey yoktur. Terminaldeyseniz uisight
gerekeni indirmeyi teklif eder (Chromium diskte ~700 MB, bir kez) ve indirmeyi gösterir. Cevap
verecek kimse yoksa — CI, ya da editörün/ajan sunucusunun başlattığı bir panel —
ne sorar ne indirir; komutu söyler. `UISIGHT_NO_INSTALL=1` teklifi tamamen kapatır:

```bash
npx playwright install chromium        # gerçek iOS Safari motoru için webkit ekleyin
```

MCP kaydı (Claude Code): `claude mcp add --scope user uisight -- npx -y -p uisight@latest uisight-mcp`

Claude Desktop'ta tek tıkla kurulum: [son sürümden](https://github.com/sololabstr/uisight/releases/latest)
`uisight-<sürüm>.mcpb` dosyasını indirip açın. Claude Desktop kurar ve üç şey sorar:
açılacak adres, araç seti (`all` ya da `core`), ilk kullanımda tarayıcıyı indirsin mi.
JSON düzenlemek gerekmez.

Türkçe araç adları için: `UISIGHT_LANG=tr` (`ekrani_gor`, `denetle`, `git`, `tikla`, `yaz`, `kaydir`, `cihaz_degistir`, `durum`, `isaretler`).

Araç tanımları her istekte gönderilir (~1.065 token). Yalnız ölçüm yapan bir oturum için `UISIGHT_TOOLS=core` bunu ~419'a indirir.

## Editör eklentisi (terminal istemeyenler için)

Antigravity, Cursor ve VSCodium'da eklenti panelinden `uisight` aratıp kurun — kenar çubuğunda kendi ikonu olur, panel editörün içinde açılır. Node.js dışında bir şey gerekmez; motoru kendisi `npx uisight@latest` ile çeker, yani **kurduktan sonra kendini günceller**.

[open-vsx.org/extension/sololabstr/uisight](https://open-vsx.org/extension/sololabstr/uisight)

## Ne ölçer

**Okunuyor mu** — görünmez metin, WCAG AA kontrast ihlalleri (alfa-harmanlı zemin, gradient yazı, `oklab()`/`oklch()` dahil), 12px altı yazı, kabına sığmayıp kırpılan metin.

**Ulaşılıyor mu** — 44px altı dokunma hedefleri, üstüne başka bir şey binen kontroller (geometriyle değil `elementFromPoint` ile doğrulanır), sabit çubuk ya da **ekran klavyesi** altında kalanlar, çentik/ev çubuğu altına düşen sabit çubuklar, yatay taşma.

**Mantıklı mı** — hepsi aynı görünen eylem grubu (hangisi ana eylem belli değil), karanlık modda kalan açık alanlar, aynı ekranda iki dil, ABD tarih biçimi, hiçbir şey söylemeyen hata mesajı, sayfada hiç onay adımı olmadan duran silme düğmesi, gerekçesiz izin isteği.

**Bakarak ölçülemeyenler** — ağ gerçekten kesilir (`offline-audit`: açıklama mı, sonsuz dönen çember mi?) ve geri tuşuna gerçekten basılır (`back-audit`).

Ayrıca: **tema kayması** (iki temada da aynı kalan = sabit-kodlu renk) · cihaz başına konsol/ağ hataları.

Her kontrolün iki testi var: yakaladığını gösteren ve **doğru davranışta sustuğunu** gösteren. İkincisi daha önemli — her alt gezinme çubuğunda öten bir kontrol, kimsenin okumadığı bir kontroldür.

## Giriş arkası

Elle bulunan dört gerçek hatanın üçü girişin arkasındaydı, biri yalnız tek bir rolde görünüyordu. `uisight-audit` giriş yapar, uygulamanın kendi rol değiştirme ucunu kullanır ve hiçbir rolde ölçülmemiş sayfaları öne alır. Hesaplar `~/.uisight/accounts.json` içinde.

Panelde 📌: alanı sürükle, not yaz — AI notunu ve o kırpılmış kareyi `marks`/`isaretler` aracıyla okur. "Ekran görüntüsü atayım da bak" devri kapanır.

Her şey lokal çalışır — bulut yok, hesap yok. Ayrıntı: [README.md](README.md) (İngilizce).

MIT © [SoloLabs](https://sololabs.com.tr)
