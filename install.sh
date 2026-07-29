#!/usr/bin/env bash
#
# kimi-code installer for Linux (fork edition — installs from GitHub Releases).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/lucasfelipe24/kimi-code/personal/install.sh | bash
#   KIMI_VERSION=v0.1.0 curl -fsSL .../install.sh | bash
#   KIMI_INSTALL_DIR=/usr/local curl -fsSL .../install.sh | sudo -E bash
#
# Optional env:
#   KIMI_VERSION         Explicit tag; unset resolves the repo's latest release
#   KIMI_INSTALL_DIR     Install directory, default $HOME/.kimi-code
#   KIMI_NO_MODIFY_PATH  Non-empty skips the PATH update
#   KIMI_REPO            owner/name of the GitHub repo hosting the releases

set -euo pipefail

KIMI_REPO="${KIMI_REPO:-lucasfelipe24/kimi-code}"

KIMI_VERSION="${KIMI_VERSION:-}"
KIMI_INSTALL_DIR="${KIMI_INSTALL_DIR:-$HOME/.kimi-code}"
KIMI_NO_MODIFY_PATH="${KIMI_NO_MODIFY_PATH:-}"

# ---------- helpers ----------

_have() { command -v "$1" >/dev/null 2>&1; }

_log() {
  if [ -t 1 ]; then
    printf '\033[1;36m==>\033[0m %s\n' "$*"
  else
    printf '==> %s\n' "$*"
  fi
}

_err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

_detect_target() {
  local os arch
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin)
      _err "macOS is not built by this fork — only linux-x64 and win32-x64 releases are published."
      ;;
    MINGW*|MSYS*|CYGWIN*)
      _err "Windows is not supported by install.sh — use install.ps1 (PowerShell)"
      ;;
    *) _err "unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    *) _err "unsupported architecture: $(uname -m) (this fork only publishes x64 builds)" ;;
  esac

  # musl (Alpine etc.) — only glibc binaries are shipped; fail clearly.
  if [ -f "/lib/libc.musl-x86_64.so.1" ] || \
     [ -f "/lib/libc.musl-aarch64.so.1" ] || \
     ldd /bin/ls 2>&1 | grep -q musl; then
    _err "Alpine / musl Linux is not supported — the published binary requires glibc."
  fi

  echo "${os}-${arch}"
}

_download() {
  local url="$1" dest="${2:-}"
  if _have curl; then
    if [ -n "$dest" ]; then
      if [ -t 1 ]; then
        curl --fail --location --progress-bar -o "$dest" "$url"
      else
        curl --fail --location --silent -o "$dest" "$url"
      fi
    else
      curl --fail --location --silent "$url"
    fi
  elif _have wget; then
    if [ -n "$dest" ]; then
      wget -q -O "$dest" "$url"
    else
      wget -q -O - "$url"
    fi
  else
    _err "curl or wget is required"
  fi
}

# Prefer jq; otherwise parse a single field with a bash regex.
_manifest_field() {
  local manifest_json="$1" target="$2" field="$3"
  if _have jq; then
    printf '%s' "$manifest_json" | jq -er ".platforms[\"$target\"].$field // empty"
  else
    local one_line
    one_line="$(printf '%s' "$manifest_json" | tr -d '\n\r\t' | sed 's/ \+/ /g')"
    if [[ $one_line =~ \"$target\"[^}]*\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
      printf '%s' "${BASH_REMATCH[1]}"
    fi
  fi
}

_sha256_check() {
  local file="$1" expected="$2"
  local actual
  if _have shasum; then
    actual="$(shasum -a 256 "$file" | cut -d' ' -f1)"
  elif _have sha256sum; then
    actual="$(sha256sum "$file" | cut -d' ' -f1)"
  else
    _err "shasum or sha256sum required to verify download"
  fi
  if [ "$actual" != "$expected" ]; then
    _err "checksum mismatch: expected $expected, got $actual"
  fi
}

_detect_shell_rc() {
  local shell_name
  shell_name="$(basename "${SHELL:-/bin/bash}")"
  case "$shell_name" in
    zsh)  echo "$HOME/.zshrc" ;;
    bash)
      if [ -f "$HOME/.bashrc" ]; then echo "$HOME/.bashrc"
      elif [ -f "$HOME/.bash_profile" ]; then echo "$HOME/.bash_profile"
      elif [ -f "$HOME/.profile" ]; then echo "$HOME/.profile"
      else echo "$HOME/.bashrc"; fi
      ;;
    fish) echo "$HOME/.config/fish/config.fish" ;;
    *)    echo "$HOME/.profile" ;;
  esac
}

_update_path() {
  if [ -n "$KIMI_NO_MODIFY_PATH" ]; then
    _log "Skipping PATH update (KIMI_NO_MODIFY_PATH set)"
    return
  fi
  case ":$PATH:" in
    *":${KIMI_INSTALL_DIR}/bin:"*)
      _log "${KIMI_INSTALL_DIR}/bin already in PATH"
      return
      ;;
  esac
  local rc
  rc="$(_detect_shell_rc)"
  mkdir -p "$(dirname "$rc")"
  local export_line
  if [[ "$rc" == *fish* ]]; then
    export_line="fish_add_path -g \"${KIMI_INSTALL_DIR}/bin\""
  else
    export_line="export PATH=\"${KIMI_INSTALL_DIR}/bin:\$PATH\""
  fi
  if ! grep -qsF "${KIMI_INSTALL_DIR}/bin" "$rc"; then
    printf '\n# kimi-code\n%s\n' "$export_line" >> "$rc"
    _log "Added ${KIMI_INSTALL_DIR}/bin to PATH in $rc"
    _log "Restart your shell or run: source $rc"
  fi
}

# ---------- main ----------

TMPDIR_INSTALL=""
_cleanup() {
  if [ -n "$TMPDIR_INSTALL" ] && [ -d "$TMPDIR_INSTALL" ]; then
    rm -rf "$TMPDIR_INSTALL"
  fi
}
trap _cleanup EXIT

main() {
  local target version download_base manifest filename checksum binary_url tmpdir

  target="$(_detect_target)"
  _log "Detected target: $target"

  # 1. Resolve version (explicit env or latest GitHub release)
  if [ -n "$KIMI_VERSION" ]; then
    version="$KIMI_VERSION"
    _log "Using pinned version $version"
  else
    _log "Resolving latest release of ${KIMI_REPO}"
    local latest_json
    latest_json="$(_download "https://api.github.com/repos/${KIMI_REPO}/releases/latest")"
    [ -n "$latest_json" ] || _err "could not query latest release (does the repo ${KIMI_REPO} exist and have a release?)"
    if _have jq; then
      version="$(printf '%s' "$latest_json" | jq -er '.tag_name')"
    else
      version="$(printf '%s' "$latest_json" | sed -n 's/.*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    fi
    [ -n "$version" ] || _err "could not resolve latest release tag"
    _log "Latest version: $version"
  fi

  download_base="https://github.com/${KIMI_REPO}/releases/download/${version}"

  # 2. Fetch manifest
  _log "Fetching manifest ${download_base}/manifest.json"
  manifest="$(_download "${download_base}/manifest.json")"
  [ -n "$manifest" ] || _err "manifest is empty or unreachable"

  # 3. Find this platform's entry
  filename="$(_manifest_field "$manifest" "$target" "filename")"
  checksum="$(_manifest_field "$manifest" "$target" "checksum")"
  [ -n "$filename" ] || _err "platform $target not found in manifest"
  [[ "$checksum" =~ ^[a-f0-9]{64}$ ]] || _err "invalid checksum for $target: $checksum"

  # 4. Download the binary
  TMPDIR_INSTALL="$(mktemp -d 2>/dev/null || mktemp -d -t kimi-install)"
  tmpdir="$TMPDIR_INSTALL"
  binary_url="${download_base}/${filename}"
  _log "Downloading ${binary_url}"
  _download "$binary_url" "${tmpdir}/${filename}"

  # 5. Verify
  _log "Verifying checksum"
  _sha256_check "${tmpdir}/${filename}" "$checksum"

  # 6. Install
  chmod +x "${tmpdir}/${filename}"
  mkdir -p "${KIMI_INSTALL_DIR}/bin"
  if [ -f "${KIMI_INSTALL_DIR}/bin/kimi" ]; then
    cp "${KIMI_INSTALL_DIR}/bin/kimi" "${KIMI_INSTALL_DIR}/bin/kimi.bak"
    _log "Backed up existing kimi to ${KIMI_INSTALL_DIR}/bin/kimi.bak"
  fi
  install -m 0755 "${tmpdir}/${filename}" "${KIMI_INSTALL_DIR}/bin/kimi"
  _log "Installed to ${KIMI_INSTALL_DIR}/bin/kimi"

  # 7. PATH
  _update_path

  _log "Done. Run: kimi --version"
}

main "$@"
