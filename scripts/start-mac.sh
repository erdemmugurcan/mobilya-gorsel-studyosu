#!/bin/bash
# Finds or downloads the portable Node.js, then hands over to launcher.mjs.
set -u

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)" || exit 1
cd "$APP_DIR" || exit 1
RUNTIME="$APP_DIR/.runtime"
NODE_ROOT="$RUNTIME/node"
TMP_DIR=""

cleanup() { [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"; }
trap cleanup EXIT

fail() {
  echo
  echo "Sorun: $1"
  if [ -t 0 ] && [ -z "${MGS_NO_PAUSE:-}" ]; then
    echo
    read -r -n 1 -s -p "Kapatmak için bir tuşa basın."
    echo
  fi
  exit 3
}

# A developer checkout is never run from: no lock, no .runtime, no download.
[ -e "$APP_DIR/.git" ] && fail "Bu klasör bir geliştirici kopyası (git deposu). GitHub sayfasından ZIP olarak indirip ayrı bir klasöre açın."

ARCH=x64
[ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ] && ARCH=arm64

# An update may need another Node.js major; launcher.mjs asks for it with MGS_NODE_MAJOR.
MAJOR="${MGS_NODE_MAJOR:-$(sed -n 's/.*"nodeMajor"[^0-9]*\([0-9][0-9]*\).*/\1/p' app.config.json | head -n 1)}"
case "$MAJOR" in
  ''|*[!0-9]*) fail "app.config.json okunamadı. Uygulamayı yeniden indirin." ;;
esac

NODE_DIR=""
for d in "$NODE_ROOT/node-v$MAJOR".*"-darwin-$ARCH"; do
  [ -x "$d/bin/node" ] && NODE_DIR="$d"
done

if [ -z "$NODE_DIR" ]; then
  NET_HELP="İnternet bağlantınızı kontrol edip yeniden açın."
  echo "Node.js indiriliyor (yalnızca ilk açılışta)…"
  mkdir -p "$NODE_ROOT" || fail "Uygulama klasörüne yazılamadı. Sistem Ayarları > Gizlilik ve Güvenlik > Dosyalar ve Klasörler bölümünden Terminal iznini kontrol edin."
  # Leftovers of an interrupted download; a recent folder may belong to another open window.
  /usr/bin/find "$RUNTIME" -maxdepth 1 -type d -name 'tmp.*' -mmin +120 -exec rm -rf {} + 2>/dev/null
  TMP_DIR="$(mktemp -d "$RUNTIME/tmp.XXXXXX")" || fail "Uygulama klasörüne yazılamadı. Sistem Ayarları > Gizlilik ve Güvenlik > Dosyalar ve Klasörler bölümünden Terminal iznini kontrol edin."

  VERSION="$(curl --proto '=https' --tlsv1.2 -fsSL --max-time 60 --retry 2 https://nodejs.org/dist/index.json \
    | grep -oE "\"version\"[[:space:]]*:[[:space:]]*\"v$MAJOR\.[0-9]+\.[0-9]+\"" | head -n 1 | sed -E 's/.*"(v[^"]+)"/\1/')"
  [ -n "$VERSION" ] || fail "Node.js sürüm bilgisi alınamadı. $NET_HELP"

  NAME="node-$VERSION-darwin-$ARCH"
  FILE="$NAME.tar.gz"
  curl --proto '=https' --tlsv1.2 -fL# --max-time 1800 --retry 2 -o "$TMP_DIR/$FILE" "https://nodejs.org/dist/$VERSION/$FILE" \
    || fail "Node.js indirilemedi. $NET_HELP"
  curl --proto '=https' --tlsv1.2 -fsSL --max-time 60 --retry 2 -o "$TMP_DIR/SHASUMS256.txt" "https://nodejs.org/dist/$VERSION/SHASUMS256.txt" \
    || fail "Node.js doğrulama bilgisi alınamadı. $NET_HELP"

  EXPECTED="$(awk -v f="$FILE" '$2 == f { print $1 }' "$TMP_DIR/SHASUMS256.txt")"
  ACTUAL="$(shasum -a 256 "$TMP_DIR/$FILE" | awk '{ print $1 }')"
  if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
    fail "İndirilen Node.js doğrulanamadı. $NET_HELP"
  fi

  tar -xzf "$TMP_DIR/$FILE" -C "$TMP_DIR" || fail "Node.js açılamadı. Diskte yer olduğundan emin olup yeniden deneyin."
  "$TMP_DIR/$NAME/bin/node" -v >/dev/null 2>&1 \
    || fail "Node.js bu Mac'te çalışmadı. macOS sürümünüz çok eski olabilir; Sistem Ayarları'ndan güncelleyin."
  # Another window may have finished first; `mv` would then nest the folder inside it.
  if [ ! -x "$NODE_ROOT/$NAME/bin/node" ]; then
    mv "$TMP_DIR/$NAME" "$NODE_ROOT/$NAME" || fail "Node.js yerleştirilemedi. Yeniden deneyin."
  fi
  NODE_DIR="$NODE_ROOT/$NAME"
  rm -rf "$TMP_DIR"
  TMP_DIR=""
  echo "Node.js hazır ($VERSION)."
fi

trap - EXIT
# launcher.mjs uses this to fetch a Node.js major that a new version needs.
[ -n "${MGS_BOOTSTRAP_ONLY:-}" ] && exit 0
export PATH="$NODE_DIR/bin:$PATH"
exec "$NODE_DIR/bin/node" "$APP_DIR/scripts/launcher.mjs"
