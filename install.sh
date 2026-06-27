#!/usr/bin/env bash
set -euo pipefail

# ── kimi-code install script (lucasfelipe24 fork) ──────────────────────
# Usage: curl -fsSL https://github.com/lucasfelipe24/kimi-code/releases/latest/download/install.sh | bash

REPO="lucasfelipe24/kimi-code"
RELEASES_BASE="https://github.com/${REPO}/releases"
INSTALL_DIR="${KIMI_CODE_HOME:-$HOME/.kimi-code}/bin"
BIN_NAME="kimi"

# ── Platform detection ─────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    linux)  os="linux" ;;
    darwin) os="darwin" ;;
    *)
      echo "Unsupported OS: $os" >&2
      exit 1
      ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *)
      echo "Unsupported architecture: $arch" >&2
      exit 1
      ;;
  esac

  echo "${os}-${arch}"
}

# ── Main ────────────────────────────────────────────────────────────────
main() {
  local platform target zip_url checksum_url tmpdir

  platform="$(detect_platform)"
  echo "→ Detected platform: ${platform}"

  # Check if we're getting a specific version or "latest"
  if command -v jq > /dev/null 2>&1; then
    target="latest/download"
  else
    target="latest/download"
  fi

  zip_url="${RELEASES_BASE}/${target}/kimi-code-${platform}.zip"
  checksum_url="${RELEASES_BASE}/${target}/kimi-code-${platform}.zip.sha256"

  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT

  echo "→ Downloading ${zip_url}..."
  if command -v curl > /dev/null 2>&1; then
    curl -fsSL -o "${tmpdir}/kimi-code.zip" "$zip_url"
    curl -fsSL -o "${tmpdir}/kimi-code.zip.sha256" "$checksum_url"
  elif command -v wget > /dev/null 2>&1; then
    wget -q -O "${tmpdir}/kimi-code.zip" "$zip_url"
    wget -q -O "${tmpdir}/kimi-code.zip.sha256" "$checksum_url"
  else
    echo "Error: neither curl nor wget found. Install one and retry." >&2
    exit 1
  fi

  # Verify checksum
  echo "→ Verifying checksum..."
  if command -v shasum > /dev/null 2>&1; then
    (cd "$tmpdir" && shasum -a 256 -c kimi-code.zip.sha256)
  elif command -v sha256sum > /dev/null 2>&1; then
    (cd "$tmpdir" && sha256sum -c kimi-code.zip.sha256)
  else
    echo "Warning: no sha256 tool found, skipping verification" >&2
  fi

  # Extract
  echo "→ Installing to ${INSTALL_DIR}..."
  mkdir -p "$INSTALL_DIR"
  unzip -o "${tmpdir}/kimi-code.zip" -d "$INSTALL_DIR"
  chmod +x "${INSTALL_DIR}/${BIN_NAME}"

  echo ""
  echo "✅ kimi-code installed successfully!"
  echo ""
  echo "Add to PATH (or restart your shell):"
  echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
  echo ""
  echo "To make it permanent, add the line above to ~/.bashrc, ~/.zshrc, or ~/.profile"
  echo ""
  echo "Run: ${INSTALL_DIR}/${BIN_NAME}"
}

main "$@"
