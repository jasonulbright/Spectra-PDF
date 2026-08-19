# Stages the bundled ICC colour profiles into resources/icc/.
#
# SOURCE: the committed copies under vendor/icc/. Nothing is fetched and no
# network is touched. The profiles were extracted once from an owner-held
# package (AdobeICCProfilesCS4Win_bundler.zip, sha256
# 396ea37eaa3f048df261f4c0e4595b91e52cf64f823e02d1d601e25ae8eee12f) and
# committed, so a build machine that has never seen that package -- CI, a fresh
# clone -- provisions the exact same bytes. The per-profile sha256 column in
# scripts/icc-profiles.tsv is the integrity record and is verified on the way
# out of vendor/icc and again on disk.
#
# Two grants of the Color Profile Bundling Agreement dated 10/20/2008 are in
# play, and they carry the same Section 3 conditions: the copies committed in
# this repository travel under the standalone-distribution grant (section
# 2(a)), and the copies this script writes into the product travel under the
# bundled-with-an-application grant (section 2(d)). Those shared conditions are
# what this script enforces:
#   - The profiles ship UNMODIFIED. Every file is sha256-verified twice; a
#     mismatch refuses.
#   - Each profile carries its own copyright notice in its ICC `cprt` tag, and
#     that tag travels because the bytes are unmodified. The manifest repeats
#     the notice so a row cannot be added for a profile nobody read.
#   - End users receive the profiles under the agreement's Exhibit B end-user
#     licence, which ships beside them as Adobe-Color-Profile-License.txt,
#     including the statement that the profiles are available from us or from
#     the upstream and how to obtain them. The same text sits beside the
#     committed copies in vendor/icc.
#   - Every profile is referenced by its ICC profile description string. The
#     manifest's `description` column is that string; nothing keys off a file
#     name.
#
# Layout written:
#   resources/icc/<upstream base name>.icc
#   resources/icc/Adobe-Color-Profile-License.txt
#
# Run before packaging:
#   powershell -ExecutionPolicy Bypass -File scripts\bundle-icc.ps1
#
# -WriteManifest re-reads every file in vendor/icc and writes the sha256 column
# back into the manifest instead of verifying it. That is the deliberate
# pin-bump path: replace the committed bytes, run it once, review the diff,
# commit. Never wired into a build -- git is the integrity record.

param(
    [string]$SourceDir = "$PSScriptRoot\..\vendor\icc",
    [string]$DestDir = "$PSScriptRoot\..\resources\icc",
    [string]$Manifest = (Join-Path $PSScriptRoot "icc-profiles.tsv"),
    [string]$LicenseText = "$PSScriptRoot\..\vendor\icc\Adobe-Color-Profile-License.txt",
    [string]$Notices = "$PSScriptRoot\..\THIRD-PARTY-LICENSES.md",
    [switch]$WriteManifest
)

$ErrorActionPreference = "Stop"

# The shipped end-user licence file name. The engine never reads it; the
# notice gate below refuses to write the tree without it.
$LicenseName = "Adobe-Color-Profile-License.txt"

# ---------------------------------------------------------------------------
# Manifest reader. Comment and header lines are preserved verbatim on a
# -WriteManifest rewrite, so the rules block above the table survives.
# ---------------------------------------------------------------------------
function Read-Manifest {
    param([string]$Path)
    $rows = @()
    $header = @()
    $seenHeader = $false
    # -Encoding UTF8 explicitly: the manifest is UTF-8 and Windows PowerShell
    # 5.1 (what `npm run prepackage` invokes) reads as ANSI by default, which
    # mangles a description string carrying a non-ASCII character.
    foreach ($line in (Get-Content $Path -Encoding UTF8)) {
        if (-not $seenHeader) {
            $header += $line
            if ($line -match '^description\t') { $seenHeader = $true }
            continue
        }
        if (-not $line.Trim()) { continue }
        $c = $line -split "`t"
        if ($c.Count -lt 6) { throw "malformed manifest row: $line" }
        $rows += [pscustomobject]@{
            description = $c[0].Trim()
            role        = $c[1].Trim()
            member      = $c[2].Trim()
            sha256      = $c[3].Trim()
            condition   = $c[4].Trim()
            copyright   = $c[5].Trim()
        }
    }
    if (-not $seenHeader) { throw "manifest $Path has no header row" }
    return [pscustomobject]@{ header = $header; rows = $rows }
}

$man = Read-Manifest $Manifest
$rows = $man.rows

# The `member` column is the upstream package member path and stays as the
# provenance record; the committed file is its base name under vendor/icc.
function Get-SourcePath {
    param([string]$Member)
    return (Join-Path $SourceDir (Split-Path $Member -Leaf))
}

# ---------------------------------------------------------------------------
# The notice gate. A profile that ships must ship its notice: the end-user
# licence text has to exist, every row needs its description string, its
# upstream member, its own copyright line and a known role, no two rows may
# claim the same description (the engine resolves by it), and every shipped
# description has to appear in THIRD-PARTY-LICENSES.md. Checked BEFORE
# anything is read, so a manifest edit that drops a notice fails in a second.
# ---------------------------------------------------------------------------
$bad = @()
if (-not (Test-Path $LicenseText)) {
    $bad += "the end-user licence text is missing: $LicenseText"
} elseif (-not (Get-Content $LicenseText -Raw).Trim()) {
    $bad += "the end-user licence text is empty: $LicenseText"
}
if (-not (Test-Path $Notices)) {
    $bad += "the notice inventory is missing: $Notices"
    $noticeBody = ""
} else {
    $noticeBody = Get-Content $Notices -Raw -Encoding UTF8
}
foreach ($r in $rows) {
    if (-not $r.description) { $bad += "$($r.member): no ICC description string" }
    if (-not $r.member)      { $bad += "$($r.description): no upstream member" }
    if (-not $r.copyright)   { $bad += "$($r.description): no copyright notice" }
    if ($r.role -notin @('cmyk', 'rgb')) { $bad += "$($r.description): unknown role '$($r.role)'" }
    if ($noticeBody -and $noticeBody -notlike "*$($r.description)*") {
        $bad += "$($r.description): ships with no row in THIRD-PARTY-LICENSES.md"
    }
}
$dupes = $rows | Group-Object description | Where-Object { $_.Count -gt 1 }
foreach ($d in $dupes) { $bad += "$($d.Name): two rows claim one description string" }
if (-not ($rows | Where-Object { $_.role -eq 'cmyk' })) {
    $bad += "no CMYK profile in the manifest: the destination-profile default has no source"
}
if ($bad) { throw "ICC notice gate refused:`n  " + ($bad -join "`n  ") }

# ---------------------------------------------------------------------------
# The committed source tree. Every row must have its file before anything is
# written, so a partial vendor/icc cannot produce a partial resource tree.
# ---------------------------------------------------------------------------
if (-not (Test-Path $SourceDir)) {
    throw "committed profile directory not found: $SourceDir"
}
$missing = @()
foreach ($r in $rows) {
    $src = Get-SourcePath $r.member
    if (-not (Test-Path $src)) { $missing += "$($r.description): $src" }
}
if ($missing) { throw "committed profiles missing:`n  " + ($missing -join "`n  ") }

if ($WriteManifest) {
    $out = @($man.header)
    foreach ($r in $rows) {
        $sha = (Get-FileHash -Algorithm SHA256 (Get-SourcePath $r.member)).Hash.ToLowerInvariant()
        $out += ($r.description, $r.role, $r.member, $sha, $r.condition, $r.copyright) -join "`t"
    }
    [System.IO.File]::WriteAllText($Manifest, ($out -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host "Wrote $($rows.Count) hashes into $Manifest. Review the diff and commit."
    return
}

foreach ($r in $rows) {
    if (-not $r.sha256) { throw "$($r.description): no sha256 in the manifest -- run with -WriteManifest" }
}

# Written into a staging tree and swapped in at the end, so an interrupted
# run never leaves a half-populated profile directory -- the destination
# profile would then resolve for some presses and refuse for others.
$staging = "$DestDir.staging"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $staging | Out-Null

foreach ($r in $rows) {
    $src = Get-SourcePath $r.member
    $sha = (Get-FileHash -Algorithm SHA256 $src).Hash.ToLowerInvariant()
    if ($sha -ne $r.sha256) {
        throw "$($r.member): sha256 $sha does not match the pinned $($r.sha256)"
    }
    Copy-Item $src (Join-Path $staging (Split-Path $r.member -Leaf)) -Force
}

Copy-Item $LicenseText (Join-Path $staging $LicenseName) -Force

# Re-verify on disk. The copy is what ships, and "unmodified" is a
# condition of the licence rather than an implementation detail.
foreach ($r in $rows) {
    $leaf = Split-Path $r.member -Leaf
    $onDisk = (Get-FileHash -Algorithm SHA256 (Join-Path $staging $leaf)).Hash.ToLowerInvariant()
    if ($onDisk -ne $r.sha256) {
        throw "$leaf : written bytes do not match the pinned $($r.sha256)"
    }
}

Remove-Item $DestDir -Recurse -Force -ErrorAction SilentlyContinue
Move-Item $staging $DestDir

$cmyk = ($rows | Where-Object { $_.role -eq 'cmyk' }).Count
$rgb = ($rows | Where-Object { $_.role -eq 'rgb' }).Count
$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. $cmyk CMYK + $rgb RGB profiles, ${sizeMB}MB in $DestDir"
