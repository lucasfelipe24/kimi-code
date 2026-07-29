#!/usr/bin/env bash
# kimi-documents environment check
# Usage: setup.sh [--json]
#
# Reports environment status for the plugin's skills. It does NOT install
# anything. The agent decides what to install (Python deps only in a venv).
#
# Checks:
#   1. Platform (native binaries are bundled for linux-x64 only)
#   2. python3 + optional modules (openpyxl, pandas, pypdf, matplotlib)
#   3. node + playwright/chromium (pdf HTML route)
#   4. dotnet (optional: docx Create route)
#   5. libreoffice/soffice (optional: xlsx recheck, .doc conversion)
#   6. Bundled binaries and fonts

set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
JSON=0
[ "${1:-}" = "--json" ] && JSON=1

have() { command -v "$1" >/dev/null 2>&1; }

OS="$(uname -s)"
ARCH="$(uname -m)"
NATIVE_OK=0
[ "$OS" = "Linux" ] && [ "$ARCH" = "x86_64" ] && NATIVE_OK=1

PYTHON=0; PY_VERSION=""
if have python3; then
  PYTHON=1
  PY_VERSION="$(python3 --version 2>&1 | awk '{print $2}')"
fi

py_module() { # $1 = module name
  [ "$PYTHON" = 1 ] && python3 -c "import $1" >/dev/null 2>&1 && echo 1 || echo 0
}
MOD_OPENPYXL="$(py_module openpyxl)"
MOD_PANDAS="$(py_module pandas)"
MOD_PYPDF="$(py_module pypdf)"
MOD_MATPLOTLIB="$(py_module matplotlib)"

NODE=0; NODE_VERSION=""
if have node; then
  NODE=1
  NODE_VERSION="$(node --version 2>/dev/null)"
fi

CHROMIUM=0
for b in chromium chromium-browser google-chrome google-chrome-stable chrome; do
  if have "$b"; then CHROMIUM=1; break; fi
done
if [ "$CHROMIUM" = 0 ]; then
  for d in "$HOME/.cache/ms-playwright" "$HOME/Library/Caches/ms-playwright"; do
    [ -d "$d" ] && CHROMIUM=1 && break
  done
fi

DOTNET=0; have dotnet && DOTNET=1
SOFFICE=0; { have soffice || have libreoffice; } && SOFFICE=1
PANDOC=0; have pandoc && PANDOC=1

SLIDES_BIN="$PLUGIN_DIR/bin/kimi-slides"
SLIDES_OK=0
if [ -x "$SLIDES_BIN" ] && [ "$NATIVE_OK" = 1 ] && "$SLIDES_BIN" --version >/dev/null 2>&1; then
  SLIDES_OK=1
fi

XLSX_BIN="$PLUGIN_DIR/skills/xlsx/scripts/Xlsx"
XLSX_OK=0
if [ -x "$XLSX_BIN" ] && [ "$NATIVE_OK" = 1 ]; then
  XLSX_OK=1
fi

FONTS_DIR="$PLUGIN_DIR/bin/native/linux-x64/fonts"
FONTS_OK=0
[ -d "$FONTS_DIR" ] && [ "$(find "$FONTS_DIR" -type f 2>/dev/null | head -1)" != "" ] && FONTS_OK=1

if [ "$JSON" = 1 ]; then
  cat <<EOF
{
  "platform": {"os": "$OS", "arch": "$ARCH", "native_binaries_supported": $([ $NATIVE_OK = 1 ] && echo true || echo false)},
  "python3": {"present": $([ $PYTHON = 1 ] && echo true || echo false), "version": "$PY_VERSION", "modules": {"openpyxl": $([ $MOD_OPENPYXL = 1 ] && echo true || echo false), "pandas": $([ $MOD_PANDAS = 1 ] && echo true || echo false), "pypdf": $([ $MOD_PYPDF = 1 ] && echo true || echo false), "matplotlib": $([ $MOD_MATPLOTLIB = 1 ] && echo true || echo false)}},
  "node": {"present": $([ $NODE = 1 ] && echo true || echo false), "version": "$NODE_VERSION"},
  "chromium_or_playwright": $([ $CHROMIUM = 1 ] && echo true || echo false),
  "dotnet": $([ $DOTNET = 1 ] && echo true || echo false),
  "libreoffice": $([ $SOFFICE = 1 ] && echo true || echo false),
  "pandoc": $([ $PANDOC = 1 ] && echo true || echo false),
  "bundled": {"kimi_slides_cli": $([ $SLIDES_OK = 1 ] && echo true || echo false), "xlsx_cli": $([ $XLSX_OK = 1 ] && echo true || echo false), "slides_fonts": $([ $FONTS_OK = 1 ] && echo true || echo false)}
}
EOF
  exit 0
fi

echo "kimi-documents environment status"
echo "================================="
echo "platform:              $OS-$ARCH $([ $NATIVE_OK = 1 ] && echo '(native binaries OK)' || echo '(native binaries NOT available - linux-x64 only)')"
echo "python3:               $([ $PYTHON = 1 ] && echo "$PY_VERSION" || echo 'MISSING')"
echo "  openpyxl:            $([ $MOD_OPENPYXL = 1 ] && echo OK || echo 'missing (venv install needed for xlsx)')"
echo "  pandas:              $([ $MOD_PANDAS = 1 ] && echo OK || echo 'missing (venv install needed for xlsx)')"
echo "  pypdf:               $([ $MOD_PYPDF = 1 ] && echo OK || echo 'missing (venv install needed for pdf processing)')"
echo "  matplotlib:          $([ $MOD_MATPLOTLIB = 1 ] && echo OK || echo 'missing (optional, charts)')"
echo "node:                  $([ $NODE = 1 ] && echo "$NODE_VERSION" || echo 'MISSING (needed for pdf HTML route)')"
echo "chromium/playwright:   $([ $CHROMIUM = 1 ] && echo OK || echo 'missing (needed for pdf HTML route)')"
echo "dotnet:                $([ $DOTNET = 1 ] && echo OK || echo 'missing (optional, docx Create route)')"
echo "libreoffice:           $([ $SOFFICE = 1 ] && echo OK || echo 'missing (optional, xlsx recheck / .doc conversion)')"
echo "pandoc:                $([ $PANDOC = 1 ] && echo OK || echo 'missing (needed for docx md2docx route; venv pypandoc_binary works)')"
echo "bundled kimi-slides:   $([ $SLIDES_OK = 1 ] && echo OK || echo 'unavailable')"
echo "bundled Xlsx CLI:      $([ $XLSX_OK = 1 ] && echo OK || echo 'unavailable')"
echo "bundled slides fonts:  $([ $FONTS_OK = 1 ] && echo OK || echo 'MISSING')"
echo
echo "This script never installs anything. Install Python dependencies only inside a virtual environment."
