# Vendors the Edit-tool fallback font (Phase 7.4) into resources/fonts —
# the same repo-hygiene class as resources/python and resources/ghostscript:
# assembled by script, gitignored, SHIPPED in the product bundle
# (tauri.conf.json resources maps ../resources/fonts -> fonts).
#
# Liberation Sans Regular (SIL OFL 1.1; metric-compatible with Arial —
# the right default for the overwhelmingly common sans body text).
# THIRD-PARTY-LICENSES.md § Fonts carries the license text pointer.
#
# The release tarball is sha256-pinned: a silent upstream change fails loudly
# here instead of shipping unnoticed. To bump: update $Version/$Sha256
# together, re-run, eyeball, commit.

$ErrorActionPreference = 'Stop'

$Version = '2.1.5'
$Url = "https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-$Version.tar.gz"
$Sha256 = '7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0'

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root 'resources\fonts'
$Target = Join-Path $Dest 'LiberationSans-Regular.ttf'

# NOTE: the pinned URL is a github FILES attachment (the project's release
# posts link these); it has weaker longevity guarantees than a
# /releases/download asset. The sha256 pin protects content either way; a
# future 404 means re-pointing at whatever official artifact then exists.

$TtfSha256 = '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8'
if (Test-Path $Target) {
    # The pin's promise covers the ALREADY-vendored file too - a corrupted
    # or wrong file must not silently satisfy the skip (the
    # bundle-ghostscript re-check precedent). ASCII ONLY in this file:
    # Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI, and a multi-byte
    # dash inside a QUOTED string mangles into a parser-breaking byte
    # (bitten live).
    $existing = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
    if ($existing -eq $TtfSha256) {
        Write-Host "Already present and verified: $Target"
        exit 0
    }
    Write-Host "Existing file failed verification - re-vendoring."
    Remove-Item $Target -Force
}

New-Item -ItemType Directory -Force $Dest | Out-Null
$Tmp = Join-Path $env:TEMP "liberation-fonts-$Version.tar.gz"

Write-Host "Downloading Liberation Fonts $Version..."
Invoke-WebRequest -Uri $Url -OutFile $Tmp -UseBasicParsing

$actual = (Get-FileHash -Algorithm SHA256 $Tmp).Hash.ToLowerInvariant()
if ($actual -ne $Sha256) {
    Remove-Item $Tmp -Force
    throw "sha256 mismatch for $Url`n  expected $Sha256`n  actual   $actual"
}

$Extract = Join-Path $env:TEMP "liberation-fonts-$Version"
if (Test-Path $Extract) { Remove-Item $Extract -Recurse -Force }
New-Item -ItemType Directory -Force $Extract | Out-Null
# System32's bsdtar EXPLICITLY: a Git-Bash GNU tar earlier on PATH parses
# "C:\..." as a remote host ("Cannot connect to C:") and dies.
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $Tmp -C $Extract
if ($LASTEXITCODE -ne 0) { throw "tar extraction failed ($LASTEXITCODE)" }

$ttf = Get-ChildItem -Recurse $Extract -Filter 'LiberationSans-Regular.ttf' | Select-Object -First 1
if (-not $ttf) { throw 'LiberationSans-Regular.ttf not found in the release archive' }
Copy-Item $ttf.FullName $Target -Force

Remove-Item $Tmp -Force
Remove-Item $Extract -Recurse -Force
Write-Host "Vendored: $Target"
