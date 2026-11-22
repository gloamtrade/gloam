#!/usr/bin/env bash
# Renders the update email header (light and dark) at 2x with headless Chrome.
# Run from app/: bash scripts/brand/render-email-header.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="file://$PWD/scripts/brand/email-header.html"
OUT="public/brand/kit/email"
for theme in light dark; do
  suffix=""; [ "$theme" = dark ] && suffix="-dark"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=600,168 --virtual-time-budget=2000 \
    --screenshot="$OUT/gloam-email-header$suffix.png" "$SRC#$theme" >/dev/null 2>&1
done
ls -la "$OUT"/gloam-email-header*.png
