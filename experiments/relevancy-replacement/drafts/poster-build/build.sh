#!/usr/bin/env bash
# Build the 36in x 48in poster PDF + preview PNG from poster.html via headless Chrome.
# Reproduces the original print-to-pdf pipeline (page @page size = 36in 48in -> 2592 x 3456 pt).
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

"$CHROME" --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$DIR/poster.pdf" "file://$DIR/poster.html" 2>/dev/null

# Preview PNG at full CSS resolution (page is 36in x 48in = 3456 x 4608 CSS px @96dpi).
"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=1 --window-size=3456,4608 \
  --screenshot="$DIR/poster-preview.png" "file://$DIR/poster.html" 2>/dev/null

echo "built poster.pdf and poster-preview.png"
