# Vendors the Finnish spelling engine into resources/dictionaries/fi/.
#
# Finnish words are generated rather than listed -- a noun inflects into
# thousands of forms and compounds without limit -- so no Hunspell .aff/.dic
# pair for it exists upstream and none could. Checking it needs a morphological
# analyser: libvoikko (the C library) plus voikko-fi (the vfst transducer that
# holds the morphology). The `fi` tag therefore ships a different KIND of
# dictionary from the other 35, inside the same resources/dictionaries tree so
# that the existing dictionary_dir argument locates it with no new plumbing.
#
# Two pinned upstream archives, each SHA-256 verified BEFORE extraction, and
# every extracted file verified again against scripts/voikko.tsv. Nothing here
# contacts a network at run time.
#
# ORDERING, load-bearing twice over:
#   - bundle-dictionaries.ps1 rebuilds resources/dictionaries WHOLESALE (it
#     removes the directory and moves a staging tree in), so this script must
#     run AFTER it or the fi tree is deleted.
#   - the three mingw runtime DLLs libvoikko-1.dll links are copied from
#     resources/tesseract, so bundle-tesseract.ps1 must have run. They are
#     copied rather than re-fetched because they already ship, with rows in
#     scripts/tesseract-licenses.tsv; a DLL loaded out of
#     resources/dictionaries/fi cannot see the OCR runtime's directory, so
#     copies must sit beside it.
#
# Run before packaging: powershell -ExecutionPolicy Bypass -File scripts\bundle-voikko.ps1
#
# -WriteManifest re-fetches every row and writes the sha256 column back into
# the manifest instead of verifying it. That is the deliberate pin-bump path:
# change the pins below, run it once, review the diff, commit. Never wired into
# a build -- git is the integrity record.

param(
    [string]$DestDir = "$PSScriptRoot\..\resources\dictionaries\fi",
    [string]$TesseractDir = "$PSScriptRoot\..\resources\tesseract",
    [string]$Manifest = (Join-Path $PSScriptRoot "voikko.tsv"),
    [string]$CacheDir = (Join-Path $env:TEMP "spectrapdf-voikko"),
    [switch]$WriteManifest
)

$ErrorActionPreference = "Stop"

# MSYS2's mingw64 build of libvoikko. The sha256 is the one MSYS2's own
# mingw64.db publishes for this package under %SHA256SUM%.
$EngineUrl = "https://repo.msys2.org/mingw/mingw64/mingw-w64-x86_64-libvoikko-4.3.3-3-any.pkg.tar.zst"
$EngineSha = "46e048d8579271704969b0dfe688e9cd40e904adc0936addeee2c39f0a34e107"

# Debian's build of voikko-fi. The sha256 is the one Debian's signed Packages
# index publishes. 2.6 exists but only as a source tarball whose build needs
# foma, which MSYS2 does not package; 2.5-2 is the newest pinnable prebuilt.
$DictUrl = "https://deb.debian.org/debian/pool/main/v/voikko-fi/voikko-fi_2.5-2_amd64.deb"
$DictSha = "e85564a1be3bf8c45d6d63b0928699ef3283f5299be8ee2d6662e6a59e816bdd"

# ---------------------------------------------------------------------------
# Manifest reader. Comment and header lines are preserved verbatim on a
# -WriteManifest rewrite, so the rules block above the table survives.
# ---------------------------------------------------------------------------
function Read-Manifest {
    param([string]$Path)
    $rows = @()
    $header = @()
    $seenHeader = $false
    # -Encoding UTF8 explicitly: Windows PowerShell 5.1 (what `npm run
    # prepackage` invokes) reads as ANSI by default, which mangles the header
    # on a -WriteManifest round trip.
    foreach ($line in (Get-Content $Path -Encoding UTF8)) {
        if (-not $seenHeader) {
            $header += $line
            if ($line -match '^file\t') { $seenHeader = $true }
            continue
        }
        if (-not $line.Trim()) { continue }
        $c = $line -split "`t"
        if ($c.Count -lt 7) { throw "malformed manifest row: $line" }
        $rows += [pscustomobject]@{
            file      = $c[0].Trim()
            component = $c[1].Trim()
            role      = $c[2].Trim()
            sha256    = $c[3].Trim()
            spdx      = $c[4].Trim()
            notice    = $c[5].Trim()
            source    = $c[6].Trim()
        }
    }
    if (-not $seenHeader) { throw "manifest $Path has no header row" }
    return [pscustomobject]@{ header = $header; rows = $rows }
}

$man = Read-Manifest $Manifest
$rows = $man.rows

# ---------------------------------------------------------------------------
# The notice gate, half one: the manifest is self-consistent. Checked BEFORE
# anything is downloaded, so a manifest edit that drops a notice fails in a
# second. Half two runs against the written tree at the end.
# ---------------------------------------------------------------------------
$noticeFiles = @($rows | Where-Object { $_.role -eq 'notice' } | ForEach-Object { Split-Path $_.file -Leaf })
$bad = @()
foreach ($r in $rows) {
    if (-not $r.component) { $bad += "$($r.file): no component" }
    if (-not $r.spdx)      { $bad += "$($r.file): no SPDX expression" }
    if (-not $r.source)    { $bad += "$($r.file): no source" }
    if ($r.role -notin @('binary', 'module', 'data', 'notice', 'runtime')) {
        $bad += "$($r.file): unknown role '$($r.role)'"
    }
    if (-not $r.notice) {
        $bad += "$($r.file): names no notice file"
    } elseif ($noticeFiles -notcontains $r.notice) {
        $bad += "$($r.file): names notice '$($r.notice)', which no notice row ships"
    }
}
if (-not ($rows | Where-Object { $_.role -eq 'binary' })) {
    $bad += "the manifest ships no engine binary"
}
if ($bad) { throw "voikko notice gate refused:`n  " + ($bad -join "`n  ") }

# ---------------------------------------------------------------------------
# Fetch + extract. .pkg.tar.zst and .deb both need 7-Zip (zstd since 22.00),
# and both are two-stage: an outer container holding a tar.
# ---------------------------------------------------------------------------
$SevenZip = @(
    "C:\Program Files\7-Zip\7z.exe",
    "C:\Program Files (x86)\7-Zip\7z.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $SevenZip) { $SevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source }
if (-not $SevenZip) {
    throw "7-Zip not found. Install it (e.g. 'choco install 7zip') and retry."
}

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

function Get-Pinned {
    param([string]$Url, [string]$Sha, [string]$Name)
    $local = Join-Path $CacheDir $Name
    if (-not (Test-Path $local)) {
        Write-Host "  fetching $Name"
        Invoke-WebRequest -Uri $Url -OutFile $local -MaximumRedirection 5 -TimeoutSec 300
    }
    $actual = (Get-FileHash $local -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha) {
        Remove-Item $local -Force -ErrorAction SilentlyContinue
        throw "$Name`: sha256 $actual does not match the pinned $Sha -- refusing to ship an unverified binary"
    }
    Write-Host "  verified $Name  $((Get-Item $local).Length) bytes  $actual"
    return $local
}

function Expand-Nested {
    param([string]$Archive, [string]$Into)
    Remove-Item $Into -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path $Into | Out-Null
    & $SevenZip x $Archive "-o$Into" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7-Zip failed to open $Archive (exit $LASTEXITCODE)" }
    # The outer container yields a .tar (pkg.tar.zst) or a data.tar.xz then a
    # .tar (deb). Keep unwrapping while a tarball is present.
    for ($i = 0; $i -lt 3; $i++) {
        $inner = @(Get-ChildItem $Into -File | Where-Object { $_.Extension -in @('.tar', '.xz') } |
                   Where-Object { $_.Name -notlike 'control*' })
        if (-not $inner) { break }
        foreach ($t in $inner) {
            & $SevenZip x $t.FullName "-o$Into" -y | Out-Null
            if ($LASTEXITCODE -ne 0) { throw "7-Zip failed to open $($t.Name) (exit $LASTEXITCODE)" }
            Remove-Item $t.FullName -Force
        }
    }
}

function Find-One {
    param([string]$Root, [string]$Leaf, [string]$Under)
    $hit = @(Get-ChildItem $Root -Recurse -File -Filter $Leaf |
             Where-Object { -not $Under -or $_.FullName -like "*$Under*" })
    if ($hit.Count -lt 1) { throw "$Leaf not found in the extracted archive -- the upstream layout changed" }
    return $hit[0].FullName
}

Write-Host "Vendoring the Finnish spelling engine (libvoikko 4.3.3-3 + voikko-fi 2.5-2)..."

$enginePkg = Get-Pinned -Url $EngineUrl -Sha $EngineSha -Name "mingw-w64-x86_64-libvoikko-4.3.3-3-any.pkg.tar.zst"
$dictPkg   = Get-Pinned -Url $DictUrl   -Sha $DictSha   -Name "voikko-fi_2.5-2_amd64.deb"

$engineTree = Join-Path $CacheDir "engine"
$dictTree   = Join-Path $CacheDir "dict"
Expand-Nested -Archive $enginePkg -Into $engineTree
Expand-Nested -Archive $dictPkg   -Into $dictTree

# The morphology directory, found by its own index.txt rather than a hardcoded
# path: the vfst tree is addressed by FORMAT version (5) and variant
# (mor-standard), both of which upstream may bump.
$index = Find-One -Root $dictTree -Leaf "index.txt" -Under "voikko"
$morDir = Split-Path $index -Parent
$variant = Split-Path $morDir -Leaf
$format = Split-Path (Split-Path $morDir -Parent) -Leaf

# What the run writes, as shipped path -> source file. Every entry must have a
# manifest row and every manifest row must appear here; the gate at the end
# checks both directions, so drift stops the build.
$plan = [ordered]@{}
$plan["libvoikko-1.dll"] = Find-One -Root $engineTree -Leaf "libvoikko-1.dll"
$plan["libvoikko.py"]    = Find-One -Root $engineTree -Leaf "libvoikko.py"
$plan["notices/COPYING"]      = Find-One -Root $engineTree -Leaf "COPYING" -Under "licenses"
$plan["notices/LICENSE.CORE"] = Find-One -Root $engineTree -Leaf "LICENSE.CORE"
foreach ($f in Get-ChildItem $morDir -File) {
    $plan["$format/$variant/$($f.Name)"] = $f.FullName
}
$plan["notices/copyright-voikko-fi"] = Find-One -Root $dictTree -Leaf "copyright" -Under "voikko-fi"

$runtime = @("libgcc_s_seh-1.dll", "libstdc++-6.dll", "libwinpthread-1.dll")
foreach ($dll in $runtime) {
    $src = Join-Path $TesseractDir $dll
    if (-not (Test-Path $src)) {
        throw "$dll not found in $TesseractDir -- run bundle-tesseract.ps1 first. libvoikko-1.dll links these three and cannot load without copies beside it."
    }
    $plan[$dll] = $src
}
foreach ($n in @("LICENSE-gcc-runtime.txt", "LICENSE-mingw-w64.txt")) {
    $src = Join-Path $TesseractDir "licenses\$n"
    if (-not (Test-Path $src)) { throw "$n not found in $TesseractDir\licenses -- run bundle-tesseract.ps1 first." }
    $plan["notices/$n"] = $src
}

if ($WriteManifest) {
    $byFile = @{}
    foreach ($k in $plan.Keys) { $byFile[$k] = $plan[$k] }
    $out = @($man.header)
    foreach ($r in $rows) {
        $sha = $r.sha256
        if ($r.role -ne 'runtime' -and $r.notice -ne 'LICENSE-gcc-runtime.txt' -and $r.notice -ne 'LICENSE-mingw-w64.txt') {
            if (-not $byFile.ContainsKey($r.file)) { throw "$($r.file): the manifest names a file this run does not produce" }
            $sha = (Get-FileHash -Algorithm SHA256 $byFile[$r.file]).Hash.ToLowerInvariant()
        }
        $out += ($r.file, $r.component, $r.role, $sha, $r.spdx, $r.notice, $r.source) -join "`t"
    }
    [System.IO.File]::WriteAllText($Manifest, ($out -join "`n") + "`n", [System.Text.UTF8Encoding]::new($false))
    Write-Host "Wrote $($rows.Count) rows into $Manifest. Review the diff and commit."
    return
}

foreach ($r in $rows) {
    if (-not $r.sha256) { throw "$($r.file): no sha256 in the manifest -- run with -WriteManifest" }
}

# Written into a staging tree and swapped in at the end, so an interrupted run
# never leaves a half-populated tree that would then resolve as the Finnish
# dictionary and fail on every word.
$staging = "$DestDir.staging"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
$verified = 0
foreach ($k in $plan.Keys) {
    $row = @($rows | Where-Object { $_.file -eq $k })
    if ($row.Count -eq 0) {
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw "notice gate refused: $k would ship but has NO ROW in voikko.tsv"
    }
    if ($row[0].sha256 -ne '-') {
        $sha = (Get-FileHash -Algorithm SHA256 $plan[$k]).Hash.ToLowerInvariant()
        if ($sha -ne $row[0].sha256) {
            Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
            throw "$k`: sha256 $sha does not match the pinned $($row[0].sha256)"
        }
        $verified++
    }
    $dest = Join-Path $staging $k
    New-Item -ItemType Directory -Force -Path (Split-Path $dest -Parent) | Out-Null
    Copy-Item $plan[$k] $dest -Force
}

# The gate's other direction: a row with nothing behind it.
foreach ($r in $rows) {
    if (-not (Test-Path (Join-Path $staging $r.file))) {
        Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
        throw "notice gate refused: voikko.tsv has a row for $($r.file), which this run does not ship"
    }
}

Remove-Item $DestDir -Recurse -Force -ErrorAction SilentlyContinue
Move-Item $staging $DestDir

$sizeMB = [math]::Round(((Get-ChildItem $DestDir -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB), 1)
Write-Host "Done. Finnish morphological dictionary ($format/$variant), $($plan.Count) files, $verified hash-verified, ${sizeMB}MB in $DestDir"
