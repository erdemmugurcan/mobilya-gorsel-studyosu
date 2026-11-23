# Mobilya Görsel Stüdyosu

Ürün fotoğraflarınızı (arka planı silinmiş hâlde) güzel odalara yerleştirip sosyal medya için görsel üreten, kendi bilgisayarınızda çalışan bir uygulama. Görselleri Magnific üzerinden üretir.

Uygulama yalnızca bu bilgisayardan açılır; aynı ağdaki başka cihazlar erişemez.

## Gerekenler

- **macOS 13.5 veya üstü** ya da **64 bit Windows 10/11** yüklü bir bilgisayar.
- İlk açılış için **internet** ve yaklaşık **3,5 GB** boş disk alanı (fotoğraflarınız hariç).
- Bir **Magnific hesabı**. Görseller Magnific'in **Cinematic** modeliyle üretilir; API anahtarı gerekmez, yalnızca hesabınızla giriş yaparsınız (aşağıda "Magnific bağlantısı").

Uygulama ihtiyaç duyduğu Node.js'i kendi klasörüne indirir; bunun için yönetici izni istemez, bilgisayarınızın geri kalanına dokunmaz. Mac'te başka bir şey gerekmez.

**Windows'ta** arka plan silme için Microsoft'un ücretsiz **Visual C++** bileşeni de gerekir; çoğu bilgisayarda zaten vardır. Yoksa uygulama açılırken bunu söyler ve Enter'a basarsanız Microsoft'un resmî indirme bağlantısını tarayıcıda açar. Bileşeni siz kurarsınız; kurulumu yönetici onayı isteyebilir. Kurmazsanız uygulama yine açılır, ama arka plan silinemez ve yeni sürümler hazırlanamaz. Kurduktan sonra uygulamayı kapatıp yeniden açın.

## Kurulum

### Mac

1. Bu sayfanın üstündeki yeşil **Code** düğmesine, sonra **Download ZIP**'e basın.
2. İnen ZIP dosyasına çift tıklayıp açın. Çıkan klasörü **ev klasörünüze** (adınızın yazdığı klasör) taşıyın.
3. Klasördeki **Mobilya Stüdyo.command** dosyasına çift tıklayın.
4. Mac "açılamıyor" ya da "geliştirici doğrulanamadı" derse:
   - Dosyaya **sağ tıklayıp Aç**'ı seçin, gelen pencerede yine **Aç**'a basın.
   - Bu seçenek yoksa (macOS 15 ve sonrası) uyarıyı kapatın, **Sistem Ayarları → Gizlilik ve Güvenlik** bölümünü açın, en altta **Yine de Aç**'a basın ve parolanızı girin.

   Bunu yalnızca ilk seferde yaparsınız.

### Windows

1. Bu sayfanın üstündeki yeşil **Code** düğmesine, sonra **Download ZIP**'e basın.
2. İnen ZIP dosyasına sağ tıklayıp **Tümünü ayıkla**'yı seçin; dosyayı ZIP'in içinden çalıştırmayın. Windows çoğu zaman aynı adlı bir klasörün içine aynı adlı ikinci bir klasör açar. **Mobilya Stüdyo.bat** dosyasını doğrudan içeren klasörü **ev klasörünüze** (`C:\Users\adınız`) taşıyın.
3. Bu klasördeki **Mobilya Stüdyo.bat** dosyasına çift tıklayın.
4. Mavi "Windows bilgisayarınızı korudu" penceresi çıkarsa **Ek bilgi**'ye, sonra **Yine de çalıştır**'a basın. Bunu yalnızca ilk seferde yaparsınız.

> Uygulamayı **Masaüstü**, **Belgeler**, **iCloud Drive** ya da **OneDrive** içine koymayın. Bu klasörler çoğu zaman eşitlenir; binlerce küçük dosya eşitlemeyi yorar ve uygulamayı bozabilir.

### İlk açılış

İlk açılış internet hızınıza göre **birkaç dakika** sürer: uygulama önce gerekli parçaları indirir, sonra kendini hazırlar. Açılan pencereyi kapatmayın. Hazır olunca tarayıcınız **http://localhost:3000** adresinde kendiliğinden açılır. Sonraki açılışlar birkaç saniye sürer.

## Günlük kullanım

- **Açmak:** Mobilya Stüdyo dosyasına çift tıklayın. Uygulama zaten açıksa yalnızca tarayıcı açılır.
- **Kapatmak:** Açılan siyah pencerede `Ctrl + C` tuşlarına basın ya da pencereyi kapatın. Pencere açık kaldığı sürece uygulama çalışır.
- **Güncelleme:** Kendiliğinden olur, bir şey yapmanız gerekmez (aşağıda "Güncelleme nasıl çalışır?").

İlk ürün ayıklama yaklaşık **30 saniye** sürebilir (program ilk seferde kendini hazırlar). Sonraki seferler daha hızlıdır.

## Güncelleme nasıl çalışır?

1. Uygulama her zaman **önce mevcut sürümle hemen açılır**. Güncelleme açılışı hiçbir zaman bekletmez.
2. Uygulama açıldıktan sonra yeni sürüm olup olmadığına bakılır. Varsa **arka planda** ayrı bir klasöre hazırlanır; siz çalışmaya devam edersiniz. Bu birkaç dakika sürebilir.
3. Hazır olunca pencerede **"Yeni sürüm hazır; bir sonraki açılışta kullanılacak."** yazar. Uygulamayı kapatıp yeniden açtığınızda yeni sürüm devreye girer.

- **Fotoğraflarınız, geçmişiniz ve Magnific bağlantınız** `data/` klasöründedir; güncelleme bu klasöre dokunmaz.
- Yeni sürüm hazırlanamazsa mevcut sürümünüz **olduğu gibi** çalışmaya devam eder. Hazırlama **3 kez** başarısız olursa o sürüm **7 gün** denenmez; daha yeni bir sürüm çıkarsa o hemen denenir. İnternet kesintileri bu sayıya girmez.
- Güncellenmiş sürüm bir gün açılmazsa uygulama kendiliğinden **önceki sürümle** açılır ve bunu pencerede söyler.
- Hazırlanırken pencereyi kapatmak zarar vermez; sonraki açılışta yeniden denenir. Aynı sürüm için bu en çok **5 kez** olur, sonra daha yeni bir sürüm beklenir.
- Pencerede **"yeni zip indirin"** yazarsa, o sürüm bu başlatıcıyla kurulamıyor demektir. Uygulamanız çalışmaya devam eder; aşağıdaki "Güvenli yeniden kurulum" adımlarını uygulayın.
- **Disk:** Yan yana normalde iki sürüm saklanır (geçerli + önceki). Uygulama, fotoğraflarınız hariç yaklaşık **2,2 GB** yer kaplar; yeni sürüm hazırlanırken kısa süreliğine yaklaşık **3,2 GB**'a çıkar. Nadiren, bir okuma hatasından sonra üçüncü bir sürüm bir sonraki güncellemeye kadar kalabilir (yaklaşık **0,9 GB** daha). Diskte en az **3 GB** boş alan yoksa güncelleme başlamaz ve mevcut sürüm çalışmaya devam eder; yer açtığınızda sonraki açılışta denenir.

### Güvenli yeniden kurulum (verileriniz korunur)

1. Mobilya Stüdyo penceresini kapatın.
2. Bu sayfadan **Code → Download ZIP** ile uygulamayı indirip **yeni bir klasöre** açın.
3. Eski klasördeki **`data`** klasörünü yeni klasöre kopyalayın.
4. Yeni klasördeki Mobilya Stüdyo dosyasına çift tıklayın. İlk açılış birkaç dakika sürer.
5. Fotoğraflarınızı ve geçmişinizi gördükten sonra eski klasörü silebilirsiniz.

## Başka bir bilgisayara geçmek

1. Yeni bilgisayara uygulamayı yukarıdaki gibi kurup bir kez açın, sonra kapatın.
2. Eski bilgisayarda da uygulamayı kapatın.
3. Eski bilgisayardaki **`data`** klasörünü (USB bellek ya da harici diskle) yeni bilgisayardaki uygulama klasörüne kopyalayın, var olan `data` klasörünün yerine geçsin.

Yalnızca `data` klasörünü taşıyın. `node_modules`, `.next` ve `.runtime` her bilgisayara özeldir, kopyalamayın. Mac'te adı nokta ile başlayan klasörler gizlidir; bu normaldir.

`data` içindeki `magnific-auth.json` hesabınıza erişim sağlar. Bu klasörü kimseyle paylaşmayın ve iş bitince USB bellekten silin.

## Ürünler ve boyutlar

- **1 · Ürünler** adımında sahneye en fazla **4 ürün** eklersiniz (**+ Ürün ekle**). Her ürünün kısa bir adı olur (varsayılan "Ürün 1", "Ürün 2"…; en fazla 40 karakter, iki ürün aynı adı taşıyamaz). Ad, yönergede ve galeride kullanılır.
- Bir ürüne **1–6 fotoğraf** yükleyebilirsiniz: aynı ürünün farklı açıları (önden, yandan, yakın çekim). Birden çok dosyayı aynı anda sürükleyip bırakabilirsiniz; 6'yı aşan dosyalar eklenmez. İlk fotoğraf **Kapak**'tır.
- Her fotoğrafın arka planı yüklenir yüklenmez **kendiliğinden ayıklanır** (aynı anda en çok 2 fotoğraf). Bir fotoğrafa tıklayınca **Düzelt** (ürünün etrafına kutu çizip yeniden ayıkla), **sola/sağa taşı** ve **Kaldır** düğmeleri çıkar. Hata olursa **Tekrar dene**'ye basın.
- **Çıktı → Boyut**'ta 10 oran var: 1:1 Kare · 4:5 Instagram gönderisi · 9:16 Story / Reels · 3:4 Dikey · 2:3 Pinterest · 4:3 Yatay · 3:2 Fotoğraf · 5:4 Yatay kare · 16:9 Web / YouTube kapağı · 21:9 Geniş panorama. Boyut fiyatı değiştirmez.
- Görsel üretilirken her ürün, Magnific kütüphanenizde adı `mgs-` ile başlayan **geçici bir ürün** olarak kısa süre görünür. Uygulama üretim bitince bunu siler; silme başarısız olursa sonraki üretimlerde yeniden dener. Kütüphanede `mgs-…` ile başlayan bir kayıt kalmışsa elle silebilirsiniz, zararı olmaz.
- Galeriden bir üretimi açınca ürünler, adları ve fotoğraflarıyla forma geri gelir. Silinmiş bir fotoğraf varsa ekranda yazar; **Tekrar üret** eksik fotoğraf varken başlamaz.

## Magnific bağlantısı (Cinematic)

Görseller Magnific'in **Cinematic** modeliyle üretilir. Bunun için API anahtarı gerekmez; Magnific hesabınızı bir kez bağlamanız yeterli:

1. Uygulamayı açın, sağ üstteki **"Magnific ile bağlan"** düğmesine basın.
2. Magnific giriş sayfası açılır. Hesabınızla giriş yapıp izin verin.
3. Uygulamaya geri dönersiniz; sağ üstte yeşil noktalı **"Magnific bağlı"** yazar.

- Bağlantı bilgileri bu bilgisayarda `data/magnific-auth.json` dosyasında tutulur, tarayıcıya gönderilmez. Bu dosyayı kimseyle paylaşmayın.
- Üretim Magnific planınızın kredisinden düşer: **2K** görsel başına **75 kredi**, **4K** görsel başına **150 kredi**. ÜRET düğmesinin yanında seçiminize göre tahmini toplam yazar (ör. 3 görsel × 4K = 450 kredi).
- Ürün ve mekân fotoğrafları üretim için Magnific hesabınıza yüklenir (fotoğraflar kütüphanenizde görünmez; ürünler için "Ürünler ve boyutlar" bölümüne bakın). Üretilen görseller hesabınızdaki varsayılan klasöre de kaydedilir.
- **Çıktı** bölümünde boyutu, **görsel sayısını** (1–4) ve **çözünürlüğü** (2K / 4K) seçersiniz.
- **Sinematik ayarlar** bölümünde isteğe bağlı olarak kamera, lens, odak uzaklığı, diyafram, çekim açısı, film tipi, film görünümü, ışık, hareket bulanıklığı, gren, halation (ışık hâlesi) ve ton görünümü seçebilirsiniz. Varsayılan "Otomatik"tir (model kendisi seçer); **Tümünü sıfırla** hepsini Otomatik'e döndürür. Bu ayarlar fiyatı değiştirmez.
- Bağlantı koparsa (ör. uzun süre kullanılmadıysa) düğme yeniden "Magnific ile bağlan" olur; tekrar basmanız yeterli.

## Fotoğraflarınız nerede?

Yüklediğiniz tüm fotoğraflar, ayıklanmış ürünler, üretilen görseller ve geçmiş **`data/`** klasöründe tutulur. Bu klasörün yedeğini almak ya da silmek size aittir: silerseniz tüm geçmiş gider, yedeklemezseniz bilgisayar bozulduğunda geri getirilemez.

## HEIC fotoğraflar

iPhone'un varsayılan HEIC biçimini uygulama **kabul etmez**. İki çözüm var:

- iPhone'da **Ayarlar → Kamera → Formatlar → "En Uyumlu"** seçin; bundan sonra çekilen fotoğraflar JPEG olur.
- Mevcut bir fotoğrafı Mac'te **Önizleme**'de açıp **Dosya → Dışa Aktar** ile JPEG olarak kaydedin.

## Sorun giderme

| Ekranda gördüğünüz | Ne yapmalı |
| --- | --- |
| Magnific hesabı bağlı değil. Üstteki "Magnific ile bağlan" düğmesine basın. | Sağ üstteki düğmeye basıp Magnific hesabınızla giriş yapın. |
| Magnific bağlantısı kurulamadı. Lütfen tekrar deneyin. | "Magnific ile bağlan"a yeniden basın. Giriş sayfasında izin vermeyi atlamayın. |
| Magnific krediniz yetersiz. | magnific.com'da hesabınıza kredi ekleyin. |
| Magnific istek sınırına ulaşıldı, biraz sonra tekrar deneyin. | Birkaç dakika bekleyip yeniden deneyin. |
| Magnific'e bağlanılamadı, internet bağlantınızı kontrol edin. | İnternet bağlantınızı kontrol edin, sonra tekrar deneyin. |
| Magnific yanıt vermedi (zaman aşımı). | Biraz sonra tekrar deneyin. |
| Magnific üretimi başarısız oldu. | "Tekrar üret"e basın. Sürerse farklı bir fotoğraf ya da stil deneyin. |
| … Görsel Magnific kütüphanenizde olabilir; tekrar üretmeden önce oraya bakın. | Üretim Magnific'te başladı ve kredi düştü, ama görsel uygulamaya alınamadı. Tekrar üretmeden önce magnific.com'da kütüphanenize (varsayılan klasör) bakın; görsel oradaysa oradan indirin. Yoksa "Tekrar üret"e basın. |
| Kütüphanede `mgs-` ile başlayan ürünler kaldı. | Üretim sırasında oluşan geçici ürünlerdir; uygulama bitince siler, silemezse sonra tekrar dener. Kalanları Magnific kütüphanenizden elle silebilirsiniz, görsellerinize zarar vermez. |
| Magnific hatası: … | Magnific bir hata bildirdi. Biraz sonra "Tekrar üret"e basın. Sürerse yazan mesajı not alıp Magnific desteğine iletin. |
| Beklenmeyen bir hata oluştu. | Uygulamada beklenmedik bir sorun çıktı. "Tekrar üret"e basın; sürerse Mobilya Stüdyo penceresini kapatıp yeniden açın. |
| Görsel indirilemedi (HTTP …). "Tekrar üret"e basın. | Üretilen görsel Magnific'ten alınamadı. "Tekrar üret"e basın. |
| Magnific bağlantısı yalnızca uygulamanın kendi sayfasından başlatılabilir. | http://localhost:3000 adresini açıp sağ üstteki "Magnific ile bağlan" düğmesine basın. |
| HEIC desteklenmiyor, lütfen JPG veya PNG yükleyin. | Yukarıdaki "HEIC fotoğraflar" bölümüne bakın. |
| Bu ad zaten kullanılıyor. / Ad en fazla 40 karakter olabilir. | Ürünlere farklı ve kısa adlar verin. |
| Bu üretimin … ürün fotoğrafı artık yok, bu yüzden tekrar üretilmedi. | O fotoğraflar `data/` klasöründen silinmiş. Galeriden üretimi açın, eksik fotoğrafları yeniden yükleyip ÜRET'e basın. |
| Görsel okunamadı, lütfen JPG veya PNG yükleyin. | Fotoğrafı JPEG ya da PNG olarak yeniden kaydedip yükleyin. |
| Sunucuya ulaşılamadı. Uygulamanın çalıştığından emin olun. | Mobilya Stüdyo penceresi kapanmış olabilir. Mobilya Stüdyo dosyasına çift tıklayıp yeniden açın. |
| "3000 portunu başka bir program kullanıyor." | Uygulama 3000 numaralı kapıyı kullanır ve Magnific girişi yalnızca bu kapıyla çalışır. Bilgisayarı yeniden başlatmak çoğu zaman yeterlidir. |
| Üretim yarıda kaldı (uygulama yeniden başlatıldı). | Uygulama üretim sırasında kapanmış. "Tekrar üret"e basın. |

### Açılışta sorun çıkarsa

| Ne oluyor | Ne yapmalı |
| --- | --- |
| Mac "açılamıyor" diyor. | Yukarıdaki Mac kurulumunun 4. adımını uygulayın. |
| Windows "bilgisayarınızı korudu" diyor. | **Ek bilgi → Yine de çalıştır**. |
| "Node.js indirilemedi" ya da "Gerekli paketler kurulamadı". | İnternet bağlantınızı kontrol edip dosyaya yeniden çift tıklayın. Kaldığı yerden devam eder. |
| "Mobilya Stüdyo başka bir pencerede hazırlanıyor." | Dosyaya iki kez tıklanmış. Diğer pencere işini bitirince tarayıcı açılır, beklemeniz yeterli. |
| "Yeni sürüm hazırlanamadı; mevcut sürümle devam ediliyor." | Bir şey yapmanız gerekmez. Sonraki açılışta yeniden denenir; düzeltilmiş bir sürüm çıkınca kendiliğinden kurulur. |
| "Diskte yeterli boş alan olmadığı için güncelleme atlandı" | Uygulama mevcut sürümle çalışır. Diskte en az 3 GB yer açın; güncelleme sonraki açılışta denenir. |
| "Bu sürüm açılamadı, önceki sürümle açılıyor." | Uygulama önceki sürümle çalışır, verileriniz yerindedir. Sürekli görürseniz "Güvenli yeniden kurulum" adımlarını uygulayın. |
| "Yeni sürüm bu başlatıcıyla kurulamıyor… yeni zip indirin" | Uygulamanız çalışmaya devam eder. Yeni sürümü almak için "Güvenli yeniden kurulum" adımlarını uygulayın. |
| "Uygulama klasörü taşınmış…" | Klasörü taşıdığınız için uygulama kendini bir kez yeniden hazırlıyor. Bekleyin. |
| "Bu klasör bir geliştirici kopyası (git deposu)." | Uygulamayı GitHub'dan **ZIP** olarak indirip ayrı bir klasöre açın. |
| Mac "macOS bu klasöre erişim izni vermedi" diyor. | **Sistem Ayarları → Gizlilik ve Güvenlik → Dosyalar ve Klasörler** bölümünde **Terminal** için **Belgeler** iznini açın, sonra dosyaya yeniden çift tıklayın. |
| Uygulama hiç açılmıyor. | Yukarıdaki **"Güvenli yeniden kurulum"** adımlarını uygulayın. |
| Yardım istemeniz gerekirse | Hata ayrıntıları uygulama klasöründe `.runtime/launcher.log` dosyasındadır. |

## Geliştiriciler için

- `npm install` ve `npm run dev` ile de çalışır (Node 26 gerekir). Başlatıcılar git kopyasında **çalışmayı reddeder**; denemek için `git archive` ile ayrı bir klasöre çıkarın.
- Her sürüm `.runtime/versions/<id>/` içinde kendi `node_modules` ve `.next`'i ile durur; hangisinin çalışacağını yalnızca `.runtime/current.json` belirler. İndirilen klasör güncellemelerle değişmez (`data/` ve `.runtime/` dışında).
- Yeni bir sürüm daha yeni başlatıcı gerektiriyorsa `scripts/launcher.mjs` içindeki `LAUNCHER_VERSION` değerini artırın ve `app.config.json` içindeki `minLauncher` değerini ona eşitleyin.
- Güncelleme kaynağı `app.config.json` içindeki `repo` alanıdır; `OWNER/REPO` kaldığı sürece güncelleme denenmez.
- `MGS_PORT` yalnızca test içindir. Magnific girişi **yalnızca 3000 portunda** çalışır.
