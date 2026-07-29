<#
.SYNOPSIS
  kimi-code installer for Windows (fork edition — installs from GitHub Releases).

.EXAMPLE
  irm https://raw.githubusercontent.com/lucasfelipe24/kimi-code/personal/install.ps1 | iex

.EXAMPLE
  $env:KIMI_VERSION = 'v0.1.0'
  irm https://raw.githubusercontent.com/lucasfelipe24/kimi-code/personal/install.ps1 | iex

.NOTES
  Optional env:
    KIMI_VERSION         Explicit tag; if unset, resolves the repo's latest release
    KIMI_INSTALL_DIR     Installation directory, default %USERPROFILE%\.kimi-code
    KIMI_NO_MODIFY_PATH  Skip PATH modification when set to a non-empty value
    KIMI_REPO            owner/name of the GitHub repo hosting the releases
#>

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 on older Windows may not negotiate TLS 1.2 by default.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$KimiRepo = if ($env:KIMI_REPO) { $env:KIMI_REPO } else { 'lucasfelipe24/kimi-code' }

$KimiVersion    = $env:KIMI_VERSION
$KimiInstallDir = if ($env:KIMI_INSTALL_DIR) { $env:KIMI_INSTALL_DIR } else { Join-Path $env:USERPROFILE '.kimi-code' }
$KimiNoPath     = $env:KIMI_NO_MODIFY_PATH

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Die($msg)        { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

function Detect-Target {
  $rawArch = try {
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    # PowerShell 5.1: detect WOW64 (32-bit PS on 64-bit Windows).
    if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  }

  $arch = switch ($rawArch) {
    'X64'   { 'x64' }
    'AMD64' { 'x64' }
    default { Die "unsupported architecture: $rawArch (this fork only publishes x64 builds)" }
  }

  return "win32-$arch"
}

function Test-Sha256([string]$file, [string]$expected) {
  $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Die "checksum mismatch: expected $expected, got $actual"
  }
}

function Add-ToUserPath([string]$dir) {
  if ($KimiNoPath) { Write-Step "Skipping PATH update (KIMI_NO_MODIFY_PATH set)"; return }
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($current -and ($current.Split(';') -contains $dir)) {
    Write-Step "$dir already in user PATH"
    return
  }
  $newPath = if ($current) { "$dir;$current" } else { $dir }
  [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
  Write-Step "Added $dir to user PATH (open a new terminal for it to take effect)"
}

# ---------- main ----------

try {

$target = Detect-Target
Write-Step "Detected target: $target"

# 1. Version (explicit env or latest GitHub release)
if ($KimiVersion) {
  $version = $KimiVersion
  Write-Step "Using pinned version $version"
} else {
  $latestUrl = "https://api.github.com/repos/$KimiRepo/releases/latest"
  Write-Step "Resolving latest release from $latestUrl"
  $latest = Invoke-RestMethod -Uri $latestUrl -Headers @{ 'User-Agent' = 'kimi-code-installer' }
  $version = $latest.tag_name
  if (-not $version) { Die "could not resolve latest release tag (does $KimiRepo have a release?)" }
  Write-Step "Latest version: $version"
}

$downloadBase = "https://github.com/$KimiRepo/releases/download/$version"

# 2. Manifest
$manifestUrl = "$downloadBase/manifest.json"
Write-Step "Fetching manifest $manifestUrl"
$manifest = Invoke-RestMethod -Uri $manifestUrl
$entry = $manifest.platforms.$target
if (-not $entry) { Die "platform $target not found in manifest" }
$filename = $entry.filename
$checksum = $entry.checksum
if ($checksum -notmatch '^[a-f0-9]{64}$') { Die "invalid checksum for ${target}: $checksum" }

# 3. Download binary
$tmp = Join-Path $env:TEMP ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  $binaryUrl = "$downloadBase/$filename"
  $tmpBinary = Join-Path $tmp $filename
  Write-Step "Downloading $binaryUrl"
  Invoke-WebRequest -Uri $binaryUrl -OutFile $tmpBinary

  Write-Step "Verifying checksum"
  Test-Sha256 $tmpBinary $checksum

  # 4. Install
  $binDir = Join-Path $KimiInstallDir 'bin'
  New-Item -ItemType Directory -Path $binDir -Force | Out-Null
  $binaryDest = Join-Path $binDir 'kimi.exe'
  if (Test-Path $binaryDest) {
    $backup = "$binaryDest.bak"
    if (Test-Path $backup) {
      try {
        Remove-Item $backup -Force -ErrorAction Stop
      } catch {
        # File locked by a running kimi process; use a unique backup name.
        $backup = "$binaryDest.$([guid]::NewGuid().ToString('N').Substring(0,8)).bak"
      }
    }
    # Windows allows renaming a running .exe but not overwriting it.
    Move-Item $binaryDest $backup -Force
    Write-Step "Backed up existing kimi.exe to $([System.IO.Path]::GetFileName($backup))"
  }
  Copy-Item $tmpBinary $binaryDest -Force
  Write-Step "Installed to $binaryDest"

  # 5. PATH
  Add-ToUserPath $binDir

  Write-Step "Done. Open a new terminal and run: kimi --version"
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

} catch {
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("Installation failed: $($_.Exception.Message)")
  exit 1
}
