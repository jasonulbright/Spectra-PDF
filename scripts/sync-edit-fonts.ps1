# Vendors the Edit-tool fallback font FAMILY (Phase 7.4 + 9.B1 + 9.A3b)
# into resources/fonts - the same repo-hygiene class as resources/python and
# resources/ghostscript: assembled by script, gitignored, SHIPPED in the
# product bundle (tauri.conf.json resources maps ../resources/fonts -> fonts).
#
# Twelve Liberation faces (all SIL OFL 1.1) - Regular/Bold/Italic/BoldItalic
# for each family, metric-compatible with the ubiquitous Microsoft cores so
# the substituted look matches the original:
#   Sans  -> Arial     (the common sans body default)
#   Serif -> Times New Roman
#   Mono  -> Courier New
# The engine (font_fallback.resolve_fallback_font) picks the face matching
# the run's own font family (and, since 9.A3b, the requested style) so a
# serif document's converted text stays serif and a bold restyle lands on
# the real Bold face. THIRD-PARTY-LICENSES.md § Fonts carries the license
# text pointer.
#
# The release tarball is sha256-pinned AND each extracted face is
# individually pinned: a silent upstream change fails loudly here instead
# of shipping unnoticed. To bump: update $Version/$Sha256 + the per-face
# hashes together, re-run, eyeball, commit.

$ErrorActionPreference = 'Stop'

$Version = '2.1.5'
$Url = "https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-$Version.tar.gz"
$Sha256 = '7191c669bf38899f73a2094ed00f7b800553364f90e2637010a69c0e268f25d0'

# NOTE: the pinned URL is a github FILES attachment (the project's release
# posts link these); it has weaker longevity guarantees than a
# /releases/download asset. The sha256 pin protects content either way; a
# future 404 means re-pointing at whatever official artifact then exists.
#
# ASCII ONLY in this file: Windows PowerShell 5.1 reads BOM-less UTF-8 as
# ANSI, and a multi-byte dash inside a QUOTED string mangles into a
# parser-breaking byte (bitten live).
$Faces = @(
    @{ Name = 'LiberationSans-Regular.ttf';     Sha256 = '76d04c18ea243f426b7de1f3ad208e927008f961dc5945e5aad352d0dfde8ee8' }
    @{ Name = 'LiberationSans-Bold.ttf';        Sha256 = '788abee4c806d660e8aee46689dd8540cd4bb98da03dcc9d171ce3efd99a9173' }
    @{ Name = 'LiberationSans-Italic.ttf';      Sha256 = 'e5bae5c4cde31f22142753855f4f8fb86da6ff39955ed3c0a11248b0d16948b0' }
    @{ Name = 'LiberationSans-BoldItalic.ttf';  Sha256 = '698da70fc191cc5f33ad4d6d3fe830fe4624b898ea2e3169955928b7c491f1ee' }
    @{ Name = 'LiberationSerif-Regular.ttf';    Sha256 = '058ea80864aef09a23f45cbec2bb5400bc3dfbdea01c3f10538a21fcb497fb74' }
    @{ Name = 'LiberationSerif-Bold.ttf';       Sha256 = 'd754ba427cfe0bca54ae052384baa8f842da5bd6550ad4da024ac441e7a7d5ce' }
    @{ Name = 'LiberationSerif-Italic.ttf';     Sha256 = '0e3dea9f8d613e006ccfa62201f33e265d19167bd0907725c3e145368b04fc2e' }
    @{ Name = 'LiberationSerif-BoldItalic.ttf'; Sha256 = 'f17db8af71e24d2066b587546021d4f0b296be389512b658dec3c09affeb11a7' }
    @{ Name = 'LiberationMono-Regular.ttf';     Sha256 = 'f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1' }
    @{ Name = 'LiberationMono-Bold.ttf';        Sha256 = 'bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb' }
    @{ Name = 'LiberationMono-Italic.ttf';      Sha256 = '605c01c711b44480a7508d349dfbf3264e81fa43d69e61cfa7d10b86e764c4d1' }
    @{ Name = 'LiberationMono-BoldItalic.ttf';  Sha256 = '79451f3c09fe25116098853b7a2ca6e2436220ccc11af022979adbcf195be130' }
)

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root 'resources\fonts'

# Skip the download entirely only when EVERY face is present and verified
# (the bundle-ghostscript re-check precedent: a corrupted/wrong file must
# not silently satisfy the skip).
$allPresent = $true
foreach ($face in $Faces) {
    $t = Join-Path $Dest $face.Name
    if (-not (Test-Path $t)) { $allPresent = $false; break }
    $h = (Get-FileHash -Algorithm SHA256 $t).Hash.ToLowerInvariant()
    if ($h -ne $face.Sha256) { $allPresent = $false; break }
}
if ($allPresent) {
    Write-Host "All faces present and verified in $Dest"
    exit 0
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

foreach ($face in $Faces) {
    $ttf = Get-ChildItem -Recurse $Extract -Filter $face.Name | Select-Object -First 1
    if (-not $ttf) { throw "$($face.Name) not found in the release archive" }
    $Target = Join-Path $Dest $face.Name
    Copy-Item $ttf.FullName $Target -Force
    $h = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
    if ($h -ne $face.Sha256) { throw "sha256 mismatch for $($face.Name): $h" }
    Write-Host "Vendored: $Target"
}

Remove-Item $Tmp -Force
Remove-Item $Extract -Recurse -Force
