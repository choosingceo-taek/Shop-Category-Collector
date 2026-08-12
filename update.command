#!/bin/bash
# ============================================================================
#  Market Lens — update in one double-click (macOS)
#
#  Put this file inside the extension folder (the one holding manifest.json)
#  and double-click it. It downloads the latest version and replaces the files
#  in place, keeping the same folder path — so Chrome keeps the same extension,
#  the same settings and the same collected catalog.
#
#  You do NOT need to visit chrome://extensions afterwards: the extension
#  notices its files changed and reloads itself within about five minutes
#  (sooner if you open the panel), then puts the new engine into the shop tabs
#  you already have open.
#
#  First time only, if macOS refuses to run it:
#     chmod +x update.command
# ============================================================================
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
URL="https://github.com/choosingceo-taek/Shop-Category-Collector/archive/refs/heads/claude/main-session-cudnkx.zip"
TMP="$(mktemp -d)"

fail() {
  echo
  echo "  Update failed. Check the internet connection and try again,"
  echo "  or download the ZIP by hand:"
  echo "  $URL"
  echo
  read -r -p "  Press return to close." _
  exit 1
}

if [ ! -f "$DIR/manifest.json" ]; then
  echo
  echo "  This file has to sit INSIDE the Market Lens folder"
  echo "  (the folder that contains manifest.json)."
  echo
  read -r -p "  Press return to close." _
  exit 1
fi

echo
echo "  Downloading the latest Market Lens..."
curl -fsSL "$URL" -o "$TMP/marketlens.zip" || fail
unzip -oq "$TMP/marketlens.zip" -d "$TMP/unpacked" || fail

# the zip holds one folder; that folder is what we copy from
SRC="$(find "$TMP/unpacked" -maxdepth 1 -mindepth 1 -type d | head -1)"
[ -n "$SRC" ] && [ -f "$SRC/manifest.json" ] || fail

# exclude this script: replacing it while bash is still reading it is asking
# for a half-run update
rsync -a --exclude update.command "$SRC/" "$DIR/" 2>/dev/null || {
  ( cd "$SRC" && find . -type f ! -name update.command -exec sh -c \
      'mkdir -p "$2/$(dirname "$1")" && cp "$1" "$2/$1"' _ {} "$DIR" \; ) || fail
}
rm -rf "$TMP"

VER="$(sed -n 's/.*"version"[^"]*"\([^"]*\)".*/\1/p' "$DIR/manifest.json" | head -1)"
echo
echo "  Updated to version $VER"
echo "  Market Lens reloads itself shortly — nothing else to do."
echo
sleep 3
