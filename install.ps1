# kimi-code install script (lucasfelipe24 fork)
# Usage: irm https://github.com/lucasfelipe24/kimi-code/releases/latest/download/install.ps1 | iex

param(
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repo = "lucasfelipe24/kimi-code"
$ReleasesBase = "https://github.com/$Repo/releases"
$Target = "latest/download"
$BinName = "kimi.exe"

# ── Platform detection ─────────────────────────────────────────────────
function Get-Platform {
  $arch = $env:PROCESSOR_ARCHITECTURE
  switch ($arch) {
    "AMD64" { return "win32-x64" }
    "ARM64" { return "win32-arm64" }
    default {
      Write-Error "Unsupported architecture: $arch"
      exit 1
    }
  }
}

# ── Main ────────────────────────────────────────────────────────────────
function Main {
  $platform = Get-Platform
  Write-Host "→ Detected platform: $platform"

  if (-not $InstallDir) {
    $InstallDir = if ($env:KIMI_CODE_HOME) {
      Join-Path $env:KIMI_CODE_HOME "bin"
    } else {
      Join-Path $env:USERPROFILE ".kimi-code\bin"
    }
  }

  $zipUrl = "$ReleasesBase/$Target/kimi-code-$platform.zip"
  $checksumUrl = "$ReleasesBase/$Target/kimi-code-$platform.zip.sha256"

  $tmpdir = Join-Path $env:TEMP "kimi-code-install-$(Get-Random)"
  New-Item -ItemType Directory -Path $tmpdir -Force | Out-Null

  try {
    Write-Host "→ Downloading $zipUrl..."
    Invoke-WebRequest -Uri $zipUrl -OutFile "$tmpdir\kimi-code.zip"

    Write-Host "→ Downloading checksum..."
    Invoke-WebRequest -Uri $checksumUrl -OutFile "$tmpdir\kimi-code.zip.sha256"

    # Verify checksum
    Write-Host "→ Verifying checksum..."
    $expected = (Get-Content "$tmpdir\kimi-code.zip.sha256" -Raw).Split(" ")[0].Trim()
    $actual = (Get-FileHash -Path "$tmpdir\kimi-code.zip" -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
      Write-Error "Checksum mismatch! Expected: $expected, Got: $actual"
      exit 1
    }
    Write-Host "  Checksum OK"

    # Extract
    Write-Host "→ Installing to $InstallDir..."
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Expand-Archive -Path "$tmpdir\kimi-code.zip" -DestinationPath $InstallDir -Force

    Write-Host ""
    Write-Host "✅ kimi-code installed successfully!"
    Write-Host ""
    Write-Host "Add to PATH (PowerShell, run as admin):"
    Write-Host '  [Environment]::SetEnvironmentVariable("Path", $env:Path + ";' + $InstallDir + '", [EnvironmentVariableTarget]::User)'
    Write-Host ""
    Write-Host "Or add manually via: System Properties → Environment Variables → Path"
    Write-Host ""
    Write-Host "Run: & ""$InstallDir\$BinName"""
  }
  finally {
    Remove-Item -Path $tmpdir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Main
