# Vendors the SCRIPT faces the personal-signature "type" door draws with,
# into resources/fonts beside the Edit-tool fallback family - the same repo
# hygiene class as resources/python and resources/tesseract: assembled by
# script, gitignored, SHIPPED in the product bundle (tauri.conf.json maps
# ../resources/fonts -> fonts).
#
# Three faces, all SIL OFL 1.1, chosen for three DIFFERENT hands rather than
# three shades of one:
#   Great Vibes  -> formal calligraphic copperplate
#   Sacramento   -> casual monoline script
#   Parisienne   -> informal flowing hand
#
# They are a signature's face, never a text-layout fallback: nothing in the
# font-resolution ladder reaches them, and only an asset that names one draws
# with it. A typed signature embeds the named face's SUBSET through pdf-lib,
# so a machine that never had the face still renders the signature.
#
# NO SYSTEM-FONT DEPENDENCE is the point: a clean runner has no handwriting
# face installed, and a typed signature that silently fell back to Helvetica
# would be a wrong result rather than a missing one.
#
# Pinned twice, like sync-edit-fonts.ps1: the source is an IMMUTABLE commit of
# google/fonts, and each extracted file is individually sha256-verified. A
# silent upstream change fails loudly here instead of shipping unnoticed. To
# bump: move $Commit and every hash together, re-run, eyeball, commit.
#
# The SIL OFL 1.1 requires the license text to ACCOMPANY distributed font
# copies, so each family's OFL.txt is vendored beside its face and ships
# through the same resources mapping. THIRD-PARTY-LICENSES.md section Fonts
# carries the notice rows.
#
# ASCII ONLY in this file: Windows PowerShell 5.1 reads BOM-less UTF-8 as
# ANSI, and a multi-byte dash inside a QUOTED string mangles into a
# parser-breaking byte.

$ErrorActionPreference = 'Stop'

$Commit = 'ec626514f79f831f1ab848a82114a0ce7e2d6372'
$Base = "https://raw.githubusercontent.com/google/fonts/$Commit/ofl"

$Wanted = @(
    @{ In = 'greatvibes/GreatVibes-Regular.ttf';   Out = 'GreatVibes-Regular.ttf';       Sha256 = '8d509802186f1b51572531ecf313e8098f9a5bfdfaca93f0c9b34467f9982d15' }
    @{ In = 'greatvibes/OFL.txt';                  Out = 'LICENSE-GreatVibes-OFL.txt';   Sha256 = '61093a21f5e63dedf54222b3c09997e54c0fe43e3851d21386e02ddcbc246d49' }
    @{ In = 'sacramento/Sacramento-Regular.ttf';   Out = 'Sacramento-Regular.ttf';       Sha256 = '9341fda10adbfeb7efc94302b34507a3e227d7e7f5c432df3f5ac8753ff73d24' }
    @{ In = 'sacramento/OFL.txt';                  Out = 'LICENSE-Sacramento-OFL.txt';   Sha256 = '2e2cb5a98da665f2ab82a9fd01fb18c2337f845761b0c163f690ed65f3b94677' }
    @{ In = 'parisienne/Parisienne-Regular.ttf';   Out = 'Parisienne-Regular.ttf';       Sha256 = 'bc9ee17f022e20bc700797e5f557d14bfa43af0c98d9e6c9c5c1ca4ec7aacd57' }
    @{ In = 'parisienne/OFL.txt';                  Out = 'LICENSE-Parisienne-OFL.txt';   Sha256 = '1dd84b611f4bed7f9ff9089e76a96337b187e6f283a4ab33bcb987f844f2c4db' }
)

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root 'resources\fonts'

# Skip the download only when EVERY file is present AND verified - a corrupted
# or wrong file must not satisfy the skip (the sync-edit-fonts guard shape).
$allPresent = $true
foreach ($item in $Wanted) {
    $t = Join-Path $Dest $item.Out
    if (-not (Test-Path $t)) { $allPresent = $false; break }
    $h = (Get-FileHash -Algorithm SHA256 $t).Hash.ToLowerInvariant()
    if ($h -ne $item.Sha256) { $allPresent = $false; break }
}
if ($allPresent) {
    Write-Host "All signature faces present and verified in $Dest"
    exit 0
}

New-Item -ItemType Directory -Force $Dest | Out-Null
foreach ($item in $Wanted) {
    $Target = Join-Path $Dest $item.Out
    Invoke-WebRequest -Uri "$Base/$($item.In)" -OutFile $Target -UseBasicParsing
    $h = (Get-FileHash -Algorithm SHA256 $Target).Hash.ToLowerInvariant()
    if ($h -ne $item.Sha256) {
        Remove-Item $Target -Force
        throw "sha256 mismatch for $($item.Out)`n  expected $($item.Sha256)`n  actual   $h"
    }
    Write-Host "Vendored: $Target"
}
