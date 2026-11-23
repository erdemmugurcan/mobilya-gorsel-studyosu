#!/bin/bash
# Mobilya Stüdyo, macOS başlatıcısı. Asıl iş scripts/start-mac.sh içindedir.

stop_here() {
  echo
  echo "Sorun: $1"
  echo "$2"
  if [ -t 0 ] && [ -z "${MGS_NO_PAUSE:-}" ]; then
    echo
    read -r -n 1 -s -p "Kapatmak için bir tuşa basın."
    echo
  fi
  exit 3
}

denied() {
  stop_here "macOS bu klasöre erişim izni vermedi." \
    "Sistem Ayarları > Gizlilik ve Güvenlik > Dosyalar ve Klasörler bölümünde Terminal için Belgeler iznini açın, sonra bu dosyaya yeniden çift tıklayın."
}

DIR="$(cd "$(dirname "$0")" 2>/dev/null && pwd)" || denied
cd "$DIR" 2>/dev/null || denied

# Geliştirici kopyasında hiçbir şey yapılmaz: kilit, .runtime ya da indirme yok.
if [ -e .git ]; then
  stop_here "Bu klasör bir geliştirici kopyası (git deposu). Mobilya Stüdyo buradan açılmaz." \
    "GitHub sayfasından ZIP olarak indirip ayrı bir klasöre açın."
fi

if ! head -c 1 app.config.json >/dev/null 2>&1; then
  if ls . >/dev/null 2>&1 && [ ! -e app.config.json ]; then
    stop_here "Bu dosya uygulama klasörünün içinde olmalı." \
      "Dosyayı indirdiğiniz klasöre geri taşıyıp yeniden çift tıklayın."
  fi
  denied
fi

exec /bin/bash "$DIR/scripts/start-mac.sh"
