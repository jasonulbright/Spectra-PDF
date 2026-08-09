# Vendors the Hunspell spelling dictionaries into resources/dictionaries/.
#
# Spell check reads the SAME dictionary everywhere it runs -- the squiggles in
# the page editor, the document-wide check panel, and the CLI -- so the
# dictionary is a shipped resource in the class of resources/tesseract, not a
# thing downloaded on demand. Nothing here contacts a network at run time.
#
# Every row of scripts/dictionaries.tsv is fetched from ONE upstream tree at
# the commit pinned below. A raw URL at a commit SHA is immutable, so that pin
# plus the per-file sha256 in the manifest is the integrity record.
#
# Layout written:
#   resources/dictionaries/<tag>/<tag>.aff
#   resources/dictionaries/<tag>/<tag>.dic
#   resources/dictionaries/<tag>/notices/<upstream file name>
#
# Run before packaging: powershell -ExecutionPolicy Bypass -File scripts\bundle-dictionaries.ps1
#
# -WriteManifest re-fetches every row and writes the sha256 column back into
# the manifest instead of verifying it. That is the deliberate pin-bump path:
# change $Commit, run it once, review the diff, commit. Never wired into a
# build -- git is the integrity record.

param(
    [string]$DestDir = "$PSScriptRoot\..\resources\dictionaries",
    [string]$Manifest = (Join-Path $PSScriptRoot "dictionaries.tsv"),
    [string]$CacheDir = (Join-Path $env:TEMP "spectrapdf-dictionaries"),
    [switch]$WriteManifest
)

$ErrorActionPreference = "Stop"

# LibreOffice/dictionaries, pinned by commit. Bumping this is a deliberate act:
# change it, run with -WriteManifest, review the sha diff, re-run the smoke
# suite (tests/test_spelling.py) before committing.
$Commit = "f2ff99058268502bdcf4cad25c1ca2935ad8aa7d"
$Base = "https://raw.githubusercontent.com/LibreOffice/dictionaries/$Commit"

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
    # mangles the header on a -WriteManifest round trip.
    foreach ($line in (Get-Content $Path -Encoding UTF8)) {
        if (-not $seenHeader) {
            $header += $line
            if ($line -match '^tag\t') { $seenHeader = $true }
            continue
        }
        if (-not $line.Trim()) { continue }
        $c = $line -split "`t"
        if ($c.Count -lt 6) { throw "malformed manifest row: $line" }
        $rows += [pscustomobject]@{
            tag      = $c[0].Trim()
            role     = $c[1].Trim()
            upstream = $c[2].Trim()
            sha256   = $c[3].Trim()
            spdx     = $c[4].Trim()
            source   = $c[5].Trim()
        }
    }
    if (-not $seenHeader) { throw "manifest $Path has no header row" }
    return [pscustomobject]@{ header = $header; rows = $rows }
}

$man = Read-Manifest $Manifest
$rows = $man.rows

# ---------------------------------------------------------------------------
# The notice gate. A tag that ships a dictionary must ship its licence: every
# tag carrying an aff+dic pair needs at least one notice row, and every row
# needs an SPDX expression and a source URL. Checked BEFORE anything is
# downloaded, so a manifest edit that drops a notice fails in a second.
# ---------------------------------------------------------------------------
$byTag = $rows | Group-Object tag
$bad = @()
foreach ($g in $byTag) {
    $roles = $g.Group.role
    if (($roles -contains 'aff') -ne ($roles -contains 'dic')) {
        $bad += "$($g.Name): an aff row and a dic row must come together"
    }
    if (($roles -contains 'aff') -and -not ($roles -contains 'notice')) {
        $bad += "$($g.Name): ships a dictionary with no notice row"
    }
}
foreach ($r in $rows) {
    if (-not $r.spdx)   { $bad += "$($r.tag)/$($r.upstream): no SPDX expression" }
    if (-not $r.source) { $bad += "$($r.tag)/$($r.upstream): no source URL" }
    if ($r.role -notin @('aff', 'dic', 'notice')) { $bad += "$($r.tag)/$($r.upstream): unknown role '$($r.role)'" }
}
if ($bad) { throw "dictionary notice gate refused:`n  " + ($bad -join "`n  ") }

# ---------------------------------------------------------------------------
# Fetch. One download per DISTINCT upstream path -- several tags share the
# same notice file (the whole de/ family shares one readme), and re-fetching
# it per tag would multiply the traffic for no gain.
# ---------------------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null
$fetched = @{}
function Get-Upstream {
    param([string]$Path)
    if ($fetched.ContainsKey($Path)) { return $fetched[$Path] }
    $local = Join-Path $CacheDir ($Path -replace '[\\/]', '_')
    if (-not (Test-Path $local)) {
        Write-Host "  fetching $Path"
        Invoke-WebRequest -Uri "$Base/$Path" -OutFile $local -TimeoutSec 300
    }
    $fetched[$Path] = $local
    return $local
}

Write-Host "Vendoring spelling dictionaries from LibreOffice/dictionaries@$($Commit.Substring(0,12))..."

if ($WriteManifest) {
    $out = @($man.header)
    foreach ($r in $rows) {
        $local = Get-Upstream $r.upstream
        $sha = (Get-FileHash -Algorithm SHA256 $local).Hash.ToLowerInvariant()
        $out += ($r.tag, $r.role, $r.upstream, $sha, $r.spdx, $r.source) -join "`t"
    }
    [System.IO.File]::WriteAllText($Manifest, ($out -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host "Wrote $($rows.Count) hashes into $Manifest. Review the diff and commit."
    return
}

foreach ($r in $rows) {
    if (-not $r.sha256) { throw "$($r.tag)/$($r.upstream): no sha256 in the manifest -- run with -WriteManifest" }
}

# Written into a staging tree and swapped in at the end, so an interrupted run
# never leaves a half-populated dictionary directory that would then load and
# reject every word of some language.
$staging = "$DestDir.staging"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
foreach ($r in $rows) {
    $local = Get-Upstream $r.upstream
    $sha = (Get-FileHash -Algorithm SHA256 $local).Hash.ToLowerInvariant()
    if ($sha -ne $r.sha256) {
        throw "$($r.upstream): sha256 $sha does not match the pinned $($r.sha256)"
    }
    $tagDir = Join-Path $staging $r.tag
    switch ($r.role) {
        'aff'    { $dest = Join-Path $tagDir "$($r.tag).aff" }
        'dic'    { $dest = Join-Path $tagDir "$($r.tag).dic" }
        'notice' { $dest = Join-Path (Join-Path $tagDir "notices") (Split-Path $r.upstream -Leaf) }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    Copy-Item $local $dest -Force
}

Remove-Item $DestDir -Recurse -Force -ErrorAction SilentlyContinue
Move-Item $staging $DestDir

$tags = ($rows | Where-Object { $_.role -eq 'aff' }).Count
$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. $tags dictionaries, ${sizeMB}MB in $DestDir"
