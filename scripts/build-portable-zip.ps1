# Assembles the portable distribution: spectrapdf-<version>-portable.zip.
#
# ONE STAGING AUTHORITY, TWO CONTAINERS. The zip's tree is not a second list of
# what to ship -- it is read out of `installer.nsi`, the file the Tauri bundler
# generates and NSIS then compiles into the installer. Every payload entry the
# installer lays down appears there as
#
#     File /a "/oname=<relative path>" "<absolute source>"
#
# plus the main executable as ${MAINBINARYSRCPATH}. This script copies exactly
# those, to exactly those relative paths. A resource added to
# `tauri.conf.json` therefore reaches both containers or neither; there is no
# hand-maintained inventory here to fall out of step, which is the whole reason
# the manifest is parsed rather than the resource tree walked.
#
# So the zip can only be built AFTER the bundle step has produced the .nsi. In
# the release workflow that is the job ordering; locally it means running a
# release build first.
#
# WHAT THE ZIP DOES NOT CARRY:
#   - install-record.json. The installer writes that in its post-install hook,
#     and its ABSENCE is how the application knows it is running portable (see
#     src-tauri/src/portable.rs). A zip that carried one would claim an
#     acceptance nobody gave.
#   - A WebView2 bootstrapper. A first-party Microsoft platform runtime is
#     never vendored; the app names the missing prerequisite instead.
#
# THE NOTICE GATE. Every shipped binary needs its notice row, and that applies
# to this container exactly as it applies to the installer -- the same bytes
# reach a user either way. The gate below refuses to write a zip whose tree is
# missing the notice inventory, the Rust notice file, or the colour profiles'
# end-user licence, and refuses when any vendored runtime present in the tree
# has no row in THIRD-PARTY-LICENSES.md. Refusal is exit 1 with the reasons
# named.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File scripts\build-portable-zip.ps1
#
# -Verify compares the tree that WOULD be built against a directory (the
# installer's own staging), reports any difference and writes nothing. That is
# the clean-runner CI gate.

param(
    [string]$Manifest = "$PSScriptRoot\..\src-tauri\target\release\nsis\x64\installer.nsi",
    [string]$OutputDirectory = "$PSScriptRoot\..\src-tauri\target\release\bundle\portable",
    [string]$Notices = "$PSScriptRoot\..\THIRD-PARTY-LICENSES.md",
    [string]$Verify = "",
    [switch]$CheckMap,
    [string]$TauriConfig = "$PSScriptRoot\..\src-tauri\tauri.conf.json"
)

$ErrorActionPreference = "Stop"

# The notice map. It classifies every payload DIRECTORY: the value is the name
# that must appear in THIRD-PARTY-LICENSES.md for that component, and an empty
# value marks FIRST-PARTY code, which has no third-party notice obligation but
# still has to be listed so a new payload directory cannot arrive
# unclassified. Read by both gates below.
$runtimes = @{
    "engine"       = ""
    "python"       = "Python"
    "tesseract"    = "Tesseract"
    "libreoffice"  = "LibreOffice"
    "jbig2enc"     = "jbig2enc"
    "fonts"        = "Liberation"
    "dictionaries" = "Hunspell"
    "icc"          = "Adobe"
}

# ---------------------------------------------------------------------------
# -CheckMap: the buildless half of the gate, for a clean CI runner.
#
# The notice map below classifies every payload DIRECTORY. It can only refuse
# an unclassified directory once a build has produced a manifest to read, which
# a lint-and-build runner never does -- so the same drift would reach the
# release job unnoticed. This compares the map against the resource
# DECLARATIONS in tauri.conf.json, which is where a new payload directory is
# actually added, and refuses there instead.
# ---------------------------------------------------------------------------
if ($CheckMap) {
    if (-not (Test-Path $TauriConfig)) { throw "tauri config not found: $TauriConfig" }
    $conf = Get-Content $TauriConfig -Raw -Encoding UTF8 | ConvertFrom-Json
    $declared = @()
    foreach ($property in $conf.bundle.resources.PSObject.Properties) {
        # The VALUE is the destination in the payload tree: a bare file name
        # (a notice file) or a directory name.
        $destination = [string]$property.Value
        if ($destination -match '\.[A-Za-z0-9]+$') { continue }
        $declared += ($destination -split '[\\/]')[0]
    }
    $unclassified = @($declared | Sort-Object -Unique | Where-Object { -not $runtimes.ContainsKey($_) })
    if ($unclassified) {
        Write-Error ("payload directories with no entry in this script's notice map:`n  " +
            ($unclassified -join "`n  ") +
            "`nAdd each to `$runtimes in scripts/build-portable-zip.ps1 -- the name that must appear in THIRD-PARTY-LICENSES.md, or an empty string for first-party code.")
        exit 1
    }
    Write-Host "Notice map covers all $($declared.Count) declared payload directories."
    exit 0
}

if (-not (Test-Path $Manifest)) {
    throw "installer manifest not found: $Manifest`nRun a release bundle first -- the zip's tree is read from the installer's own manifest, never rebuilt from a second list."
}

# ---------------------------------------------------------------------------
# The manifest reader. `File /a "/oname=<rel>" "<src>"` for the resources, and
# the !define for the main binary. Both quoted forms are literal in the
# generated file, so the patterns are anchored on them rather than on any
# looser "a line with two quoted strings".
# ---------------------------------------------------------------------------
$manifestText = Get-Content $Manifest -Raw -Encoding UTF8

$entries = @()

$binaryMatch = [regex]::Match($manifestText, '(?m)^\s*!define\s+MAINBINARYSRCPATH\s+"([^"]+)"')
if (-not $binaryMatch.Success) { throw "the manifest names no MAINBINARYSRCPATH: $Manifest" }
$binaryNameMatch = [regex]::Match($manifestText, '(?m)^\s*!define\s+MAINBINARYNAME\s+"([^"]+)"')
if (-not $binaryNameMatch.Success) { throw "the manifest names no MAINBINARYNAME: $Manifest" }
$entries += [pscustomobject]@{
    relative = "$($binaryNameMatch.Groups[1].Value).exe"
    source   = $binaryMatch.Groups[1].Value
}

foreach ($m in [regex]::Matches($manifestText, '(?m)^\s*File /a "/oname=([^"]+)" "([^"]+)"')) {
    $entries += [pscustomobject]@{
        relative = $m.Groups[1].Value
        source   = $m.Groups[2].Value
    }
}

if ($entries.Count -lt 2) {
    throw "the manifest lists no resources: $Manifest"
}

$versionMatch = [regex]::Match($manifestText, '(?m)^\s*!define\s+VERSION\s+"([^"]+)"')
if (-not $versionMatch.Success) { throw "the manifest names no VERSION: $Manifest" }
$version = $versionMatch.Groups[1].Value

# A duplicate relative path would mean two sources racing for one destination,
# and whichever copied last would win silently.
$dupes = $entries | Group-Object relative | Where-Object { $_.Count -gt 1 }
if ($dupes) {
    throw "the manifest maps one destination twice:`n  " + (($dupes | ForEach-Object { $_.Name }) -join "`n  ")
}

# ---------------------------------------------------------------------------
# The notice gate. Runs BEFORE anything is copied, so a tree missing a notice
# fails in a second rather than after a several-minute copy.
#
# `$runtimes` (defined at the top, because -CheckMap reads it too) maps a
# payload directory to the name that must appear in the notice inventory. A
# directory present in the tree with no row is a shipped binary with no notice,
# which is what the gate exists to stop.
# ---------------------------------------------------------------------------
$requiredFiles = @(
    "THIRD-PARTY-LICENSES.md",
    "THIRD-PARTY-LICENSES-RUST.html",
    "icc\Adobe-Color-Profile-License.txt"
)

$bad = @()
$relatives = $entries | ForEach-Object { $_.relative }
$relativeSet = [System.Collections.Generic.HashSet[string]]::new(
    [string[]]$relatives, [System.StringComparer]::OrdinalIgnoreCase)

foreach ($required in $requiredFiles) {
    if (-not $relativeSet.Contains($required)) {
        $bad += "the payload carries no $required"
    }
}

if (-not (Test-Path $Notices)) {
    $bad += "the notice inventory is missing: $Notices"
    $noticeBody = ""
} else {
    $noticeBody = Get-Content $Notices -Raw -Encoding UTF8
}

$topLevel = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($rel in $relatives) {
    $head = ($rel -split '[\\/]')[0]
    if ($rel -match '[\\/]') { [void]$topLevel.Add($head) }
}
foreach ($dir in $topLevel) {
    if (-not $runtimes.ContainsKey($dir)) {
        # A payload directory nobody has classified is a shipped component
        # whose notice obligation nobody has decided. Refuse rather than guess.
        $bad += "$dir\: a payload directory with no entry in this script's notice map"
        continue
    }
    if (-not $runtimes[$dir]) { continue }
    if ($noticeBody -and $noticeBody -notlike "*$($runtimes[$dir])*") {
        $bad += "$dir\: ships with no '$($runtimes[$dir])' row in THIRD-PARTY-LICENSES.md"
    }
}

# The colour profiles are named individually by their ICC description string,
# the condition bundle-icc.ps1 enforces for the installer. The zip ships the
# same bytes and inherits the same condition.
$iccManifest = Join-Path $PSScriptRoot "icc-profiles.tsv"
if (Test-Path $iccManifest) {
    $seenHeader = $false
    foreach ($line in (Get-Content $iccManifest -Encoding UTF8)) {
        if (-not $seenHeader) {
            if ($line -match '^description\t') { $seenHeader = $true }
            continue
        }
        if (-not $line.Trim()) { continue }
        $description = ($line -split "`t")[0].Trim()
        if ($description -and $noticeBody -and $noticeBody -notlike "*$description*") {
            $bad += "$description : a shipped profile with no row in THIRD-PARTY-LICENSES.md"
        }
    }
} else {
    $bad += "the colour-profile manifest is missing: $iccManifest"
}

if ($bad) {
    Write-Error ("portable notice gate refused:`n  " + ($bad -join "`n  "))
    exit 1
}

# ---------------------------------------------------------------------------
# -Verify: compare the manifest's tree against a directory, write nothing.
# ---------------------------------------------------------------------------
if ($Verify) {
    if (-not (Test-Path $Verify)) { throw "nothing to verify against: $Verify" }
    $root = (Resolve-Path $Verify).Path
    $actual = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($f in (Get-ChildItem $root -Recurse -File)) {
        [void]$actual.Add($f.FullName.Substring($root.Length).TrimStart('\', '/'))
    }
    # install-record.json is the installer's own marker and is expected to be
    # absent from a portable tree; it is never in the manifest either.
    $missing = @($relatives | Where-Object { -not $actual.Contains($_) })
    $extra = @($actual | Where-Object { -not $relativeSet.Contains($_) })
    if ($missing -or $extra) {
        $report = @()
        if ($missing) { $report += "in the installer manifest but not in the tree:`n    " + ($missing -join "`n    ") }
        if ($extra) { $report += "in the tree but not in the installer manifest:`n    " + ($extra -join "`n    ") }
        Write-Error ("the portable tree does not match the installer's staging:`n  " + ($report -join "`n  "))
        exit 1
    }
    Write-Host "Verified: $($relatives.Count) payload entries, identical to the installer's staging."
    exit 0
}

# ---------------------------------------------------------------------------
# Every source must exist before anything is copied: a partial staging tree
# must not produce a partial zip, the bundle-icc.ps1 discipline.
# ---------------------------------------------------------------------------
$missingSources = @()
foreach ($e in $entries) {
    if (-not (Test-Path -LiteralPath $e.source -PathType Leaf)) {
        $missingSources += "$($e.relative) <- $($e.source)"
    }
}
if ($missingSources) {
    throw "payload sources missing:`n  " + ($missingSources -join "`n  ")
}

$staging = Join-Path $OutputDirectory "tree.staging"
Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $staging | Out-Null

foreach ($e in $entries) {
    $dest = Join-Path $staging $e.relative
    $parent = Split-Path $dest -Parent
    if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    Copy-Item -LiteralPath $e.source -Destination $dest -Force
}

$zipName = "spectrapdf-$version-portable.zip"
$zipPath = Join-Path $OutputDirectory $zipName
Remove-Item $zipPath -Force -ErrorAction SilentlyContinue

# `-CompressionLevel Optimal` over the tree ROOT's children, so the archive
# opens onto the executable rather than onto one wrapper directory the user has
# to descend through.
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zipPath -CompressionLevel Optimal

# The staging tree stays: the CI gate verifies it against the installer's own,
# and deleting it would make that check re-extract a 12,000-file archive.
$sizeMB = [math]::Round(((Get-Item $zipPath).Length / 1MB), 1)
Write-Host "Wrote $zipPath ($($entries.Count) payload entries, ${sizeMB}MB)"
Write-Host "Tree staged at $staging"
